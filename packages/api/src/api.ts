import {
  TEXT_KIND, compensate, normalizeText, resolveKind,
  type Change, type ChangeDraft, type ChangeId, type Clock, type IdGenerator, type Operation, type ProjectId, type UserId,
} from '@sift/core';
import { extractFromSource, sourceCreationOp, type ExtractError, type ModelParams, type ModelPort } from '@sift/ai';
import {
  BatchAcceptRequest, CaptureSourceRequest, CaptureSourceResponse, DecisionRequest, ExtractionResponse, ProposalView,
  ResponseSchemas, Routes, StartExtractionRequest,
  StateView, type BlockCode, type LogEntry as LogEntryView, type SourceView,
} from '@sift/contract';
import {
  HttpError, ResponseInvalid, compileRoutes, fail, makeEmitter, matchRoute, parseBody,
  type ApiRequest, type ApiResponse,
} from './http';
import type { AuditEntry, ProjectStore, ReviewInput, SourceRecord, Store } from './store';
import type { LogEntry as CoreEntry } from '@sift/core';
import { effectiveOperations, listProposalViews, loadProposalView, undoneIds } from './views';

/** Evento de log SEM conteúdo: rota, estado, códigos. Nunca texto de fonte, citação, chave nem pilha. */
export interface LogEvent {
  level: 'info' | 'warn' | 'error';
  event: string;
  route?: string;
  status?: number;
  code?: string;
  projectId?: string;
  runId?: string;
  detail?: string;
}

export interface ApiDeps {
  store: Store;
  model: ModelPort;
  clock: Clock;
  ids: IdGenerator;
  /** Quem é "a pessoa" nas mudanças humanas (captura). Sem autenticação nesta fase. */
  actorId?: string;
  /** Origens permitidas por CORS. Vazio (padrão) = fechado. */
  corsOrigins?: readonly string[];
  logger?: (e: LogEvent) => void;
  extractionParams?: ModelParams;
  maxChunkChars?: number;
  /** Fração de itens `unchecked` por falha do verificador que dispara o aviso `verifier_degraded` (padrão 0,5). */
  verifierDegradedThreshold?: number;
}

export interface Api {
  handle(req: ApiRequest): Promise<ApiResponse>;
}

const ROUTES = compileRoutes();

type Ctx = { req: ApiRequest; params: Record<string, string>; ps: ProjectStore };
type Handler = (ctx: Ctx) => Promise<ApiResponse>;

const ERROR_MESSAGES: Record<'provider_failure' | 'schema_invalid', string> = {
  provider_failure: 'O modelo não respondeu. Tente de novo.',
  schema_invalid: 'O modelo devolveu uma resposta fora do formato esperado.',
};

/** Erro do pipeline -> erro tipado do contrato. `source_hash_mismatch` é falha de integridade nossa, não do fornecedor. */
function extractionError(e: ExtractError): { code: 'provider_failure' | 'schema_invalid'; retryable: boolean } {
  switch (e.code) {
    case 'schema_invalid': return { code: 'schema_invalid', retryable: e.retryable };
    case 'provider_error': return { code: 'provider_failure', retryable: e.retryable };
    case 'no_response': return { code: 'provider_failure', retryable: false };
    case 'aborted': return { code: 'provider_failure', retryable: false };
    // O contrato 0.2.1 não tem código próprio para o teto de custo: aparece como falha do fornecedor, sem nova tentativa ([C1]).
    case 'cost_cap_exceeded': return { code: 'provider_failure', retryable: false };
    case 'source_hash_mismatch':
    case 'schema_unsupported': throw fail('internal', 'erro interno');
  }
}

export function createApi(deps: ApiDeps): Api {
  const actorId = (deps.actorId ?? 'local-user') as UserId;
  const log = (e: LogEvent): void => deps.logger?.(e);
  const emitter = makeEmitter((detail) => log({ level: 'error', event: 'response_invalid', detail }));

  // Escritas de um projeto em fila: dois pedidos nunca intercalam passos de leitura-e-escrita.
  const tails = new Map<string, Promise<unknown>>();
  const locked = <T>(projectId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(projectId) ?? Promise.resolve()).then(fn, fn);
    tails.set(projectId, run.catch(() => undefined));
    return run;
  };

  const sourceView = async (ps: ProjectStore, rec: SourceRecord): Promise<SourceView> => {
    const text = await ps.getContent(rec.contentHash);
    if (text === undefined) throw fail('internal', 'erro interno');
    return {
      id: rec.id, name: rec.name, text, contentHash: rec.contentHash,
      ...(rec.capturedAt !== undefined ? { capturedAt: rec.capturedAt } : {}),
    };
  };

  const captureSource: Handler = async ({ req, params, ps }) => {
    const body = parseBody<typeof CaptureSourceRequest._output>(CaptureSourceRequest, readBody(req));
    if (body.originType === 'ai') {
      // O contrato (schema) já exige originRunId para IA e o proíbe para humano. Aqui se confere que a execução EXISTE.
      const known = (await ps.changes()).some((c) => c.origin.kind === 'agent' && c.origin.runId === body.originRunId);
      if (!known) throw fail('invalid_request', 'pedido inválido: originRunId desconhecido');
    }
    const text = normalizeText(body.text);
    if (text.trim() === '') throw fail('invalid_request', 'pedido inválido: text: vazio');
    return locked(params.projectId!, async () => {
      const contentHash = await ps.putContent(text);
      const id = deps.ids.next();
      const draft: ChangeDraft = {
        id: deps.ids.next() as ChangeId, projectId: ps.projectId, baseVersion: (await ps.state()).version,
        schemaRef: { key: ps.schema.key, version: ps.schema.version },
        origin: { kind: 'human', actorId },
        rationale: 'Captura de fonte',
        operations: [sourceCreationOp({
          id, label: body.name, contentHash, originType: body.originType,
          ...(body.originRunId !== undefined ? { originRunId: body.originRunId } : {}),
          ...(body.originLabel !== undefined ? { originLabel: body.originLabel } : {}),
          ...(body.capturedAt !== undefined ? { capturedAt: body.capturedAt } : {}),
        })],
        createdAt: deps.clock.now(),
      };
      const out = await ps.submitHuman(draft);
      if (!out.ok) {
        if (out.code === 'invalid') {
          throw fail('invalid_request', `pedido inválido: ${(out.issues ?? []).map((x) => x.code).join(', ')}`);
        }
        if (out.code === 'conflict') throw fail('conflict', 'o projeto mudou durante a captura; tente de novo');
        throw fail('internal', 'erro interno');
      }
      if (!out.applied) throw fail('internal', 'erro interno'); // mudança humana é aplicada na hora
      const rec: SourceRecord = {
        id, name: body.name, contentHash, originType: body.originType,
        ...(body.originRunId !== undefined ? { originRunId: body.originRunId } : {}),
        ...(body.originLabel !== undefined ? { originLabel: body.originLabel } : {}),
        ...(body.capturedAt !== undefined ? { capturedAt: body.capturedAt } : {}),
        createdAt: deps.clock.now(),
      };
      await ps.saveSource(rec);
      await ps.appendAudit({ action: 'capture_source', targetId: id, coreVersion: out.version });
      return emitter.emit(CaptureSourceResponse, { source: await sourceView(ps, rec) }, [], 201);
    });
  };

  const getSource: Handler = async ({ params, ps }) => {
    const rec = await ps.getSource(params.sourceId!);
    if (rec === undefined) throw fail('not_found', 'fonte não encontrada');
    return emitter.emit(ResponseSchemas.getSource, { source: await sourceView(ps, rec) }, []);
  };

  /**
   * Extração em DUAS FASES (decisão B do OPEN-DECISIONS §7.1): ler e chamar o modelo SEM travar o projeto
   * (pode levar minutos com um modelo real); travar só para propor as mudanças. As mudanças partem do
   * `baseVersion` lido na fase 1; se o projeto mudou nesse meio tempo, o núcleo as trata como obsoletas (`stale`)
   * e a proposta nasce `stale`, nunca perde nada. A idempotência `runId:sourceId:ref` protege contra repetição.
   */
  const startExtraction: Handler = async ({ req, params, ps }) => {
    const body = parseBody<{ sourceId: string }>(StartExtractionRequest, readBody(req));
    // Fase 1 (sem fila): só leitura.
    const src = await ps.getSource(body.sourceId);
    if (src === undefined) throw fail('not_found', 'fonte não encontrada');
    const text = await ps.getContent(src.contentHash);
    if (text === undefined) throw fail('internal', 'erro interno');
    const runId = deps.ids.next();
    const state = await ps.state();
    // Fase 2 (sem fila): o modelo.
    const result = await extractFromSource(
      { model: deps.model, schema: ps.schema, ids: deps.ids, clock: deps.clock },
      {
        runId: runId as never, projectId: ps.projectId, baseVersion: state.version,
        schemaRef: { key: ps.schema.key, version: ps.schema.version }, state,
        source: { id: src.id, label: src.name, contentHash: src.contentHash, text },
        ...(deps.extractionParams !== undefined ? { params: deps.extractionParams } : {}),
        ...(deps.maxChunkChars !== undefined ? { maxChunkChars: deps.maxChunkChars } : {}),
        ...(deps.verifierDegradedThreshold !== undefined ? { verifierDegradedThreshold: deps.verifierDegradedThreshold } : {}),
      },
    );
    if (!result.ok) {
      const mapped = extractionError(result.error);
      log({ level: 'error', event: 'extraction_failed', projectId: ps.projectId, runId, code: result.error.code });
      return emitter.emit(ExtractionResponse, {
        ok: false, error: { code: mapped.code, retryable: mapped.retryable, message: ERROR_MESSAGES[mapped.code] },
      }, []);
    }
    const unchecked = new Set(result.report.uncheckedByVerifier.map((u) => u.ref));
    if (result.report.verifierDegraded !== null) {
      // Nunca em silêncio: o contrato 0.2.1 não carrega este aviso na resposta ([C1]); fica no log e em `verifierFailed`.
      log({ level: 'warn', event: 'verifier_degraded', projectId: ps.projectId, runId, detail: JSON.stringify(result.report.verifierDegraded) });
    }
    const modelId = result.report.model;
    if (modelId === '') throw fail('internal', 'erro interno');
    // Fase 3 (na fila): só a escrita final.
    return locked(params.projectId!, async () => {
      const prefix = `${runId}:${src.id}:`;
      const created: Change[] = [];
      for (const change of result.changes) {
        const out = await ps.proposeChange(change);
        if (!out.ok) {
          log({ level: 'error', event: 'ledger_refused_pipeline_change', projectId: ps.projectId, runId, code: out.code });
          throw fail('internal', 'erro interno');
        }
        const key = change.idempotencyKey ?? '';
        const ref = key.startsWith(prefix) ? key.slice(prefix.length) : key;
        await ps.saveMeta(change.id, { runId, sourceId: src.id, ref, verifierFailed: unchecked.has(ref) });
        await ps.appendAudit({ action: 'propose', targetId: change.id });
        created.push(change);
      }
      const proposals: ProposalView[] = [];
      for (const change of created) proposals.push(await loadProposalView(ps, change));
      return emitter.emit(ExtractionResponse, {
        ok: true, runId, proposals, discarded: result.report.discarded.length,
        ambiguousCitations: result.report.ambiguousCitations.length, modelId,
      }, proposals);
    });
  };

  const listProposals: Handler = async ({ req, ps }) => {
    const raw = req.query?.status;
    let filter: ProposalView['status'] | undefined;
    if (raw !== undefined) {
      const parsed = ProposalView.shape.status.safeParse(raw);
      if (!parsed.success) throw fail('invalid_request', 'pedido inválido: status');
      filter = parsed.data;
    }
    const views = await listProposalViews(ps, filter);
    return emitter.emit(ResponseSchemas.proposals, views, views);
  };

  /** Decisão mais recente que ainda se pode desfazer (pilha: só a do topo) e se o núcleo deixa compensá-la agora. */
  const undoTarget = async (ps: ProjectStore): Promise<{ entry: CoreEntry; ok: boolean } | undefined> => {
    const [state, entries, gone] = await Promise.all([ps.state(), ps.entries(), undoneIds(ps)]);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.origin.kind !== 'agent' || gone.has(entry.changeId)) continue;
      const probe = compensate(entry, state, {
        changeId: 'undo-probe' as ChangeId, projectId: ps.projectId as ProjectId,
        schemaRef: { key: ps.schema.key, version: ps.schema.version }, actor: actorId, now: deps.clock.now(),
      });
      return { entry, ok: probe.ok };
    }
    return undefined;
  };

  const getState: Handler = async ({ ps }) => {
    const state = await ps.state();
    const entries = await ps.entries();
    const items = [];
    for (const it of state.items.values()) {
      if (it.retired || !ProposalView.shape.type.options.includes(it.type as never) || it.type === 'relation') continue;
      const sourceIds: string[] = [];
      const evidence: { sourceId: string; quote: string; start: number | null; end: number | null }[] = [];
      for (const ev of it.evidence) {
        const s = await ps.sourceByHash(ev.contentHash);
        if (s === undefined) continue;
        if (!sourceIds.includes(s.id)) sourceIds.push(s.id);
        if (ev.quote === undefined || ev.quote === '') continue;
        const kind = resolveKind(ev, new Map([[TEXT_KIND.kind, TEXT_KIND]]));
        const text = await ps.getContent(ev.contentHash);
        const first = kind !== undefined && text !== undefined
          ? (kind.locate(text, ev.quote)[0] as { start: number; end: number } | undefined) : undefined;
        evidence.push({ sourceId: s.id, quote: ev.quote, start: first ? first.start : null, end: first ? first.end : null });
      }
      items.push({ id: it.id, type: it.type, text: it.content ?? '', sourceIds, evidence });
    }
    // `kind` é livre no contrato 0.3.0: os nomes vêm do schema do projeto.
    const relations = [...state.relations.values()]
      .filter((r) => !r.retired)
      .map((r) => ({ id: r.id, kind: r.type, from: r.from, to: r.to }));
    const headHash = entries.length > 0 ? entries[entries.length - 1]!.entryHash : null;
    const target = await undoTarget(ps);
    return emitter.emit(StateView, { items, relations, headHash, canUndo: target?.ok === true }, []);
  };

  const agentChange = async (ps: ProjectStore, id: string): Promise<Change | undefined> =>
    (await ps.changes()).find((c) => c.id === id && c.origin.kind === 'agent');

  /** Código do núcleo -> código do contrato. Nada aqui lança. */
  const refusal = (a: { ok: false; code: BlockCode }): HttpError =>
    a.code === 'stale' ? fail('stale', 'a proposta ficou desatualizada') : fail('not_allowed', 'ação não permitida', a.code);

  type Applied = { ok: true; entry: AuditEntry } | { ok: false; code: BlockCode };
  /** Aplica UMA decisão humana no núcleo e a regista na auditoria. Chamar só dentro de `locked`. */
  const applyReview = async (
    ps: ProjectStore, change: Change, how: 'accept' | 'reject' | { edit: string }, batch: boolean,
  ): Promise<Applied> => {
    const reviewer = { kind: 'human', id: actorId } as const;
    let input: ReviewInput;
    if (how === 'reject') input = { changeId: change.id, decision: 'reject', reviewer };
    else if (how === 'accept') input = { changeId: change.id, decision: 'accept', reviewer, batch };
    else {
      const ops = effectiveOperations(change, await ps.reviewEvents(change.id));
      const first = ops[0];
      if (first === undefined || first.op !== 'create_item') return { ok: false, code: 'core_refused' };
      const edited: Operation[] = [{ ...first, content: how.edit }, ...ops.slice(1)];
      input = { changeId: change.id, decision: 'accept_edited', reviewer, editedOperations: edited };
    }
    const out = await ps.review(input);
    if (!out.ok) {
      const code: BlockCode = out.code === 'stale' ? 'stale' : out.code === 'not_pending' ? 'already_decided' : 'core_refused';
      return { ok: false, code };
    }
    const action = how === 'reject' ? 'reject' : typeof how === 'object' ? 'accept_edited' : batch ? 'accept_batch' : 'accept';
    const entry = await ps.appendAudit({
      action, targetId: change.id, ...(out.applied ? { coreVersion: out.version } : {}),
    });
    return { ok: true, entry };
  };

  const decide: Handler = async ({ req, params, ps }) => {
    const body = parseBody<typeof DecisionRequest._output>(DecisionRequest, readBody(req));
    return locked(params.projectId!, async () => {
      const change = await agentChange(ps, params.proposalId!);
      if (change === undefined) throw fail('not_found', 'proposta não encontrada');
      const before = await loadProposalView(ps, change);
      const gate = body.kind === 'reject' ? before.canReject : before.canAccept;
      if (!gate.ok) throw refusal(gate);
      if (body.kind === 'edit') {
        const current = effectiveOperations(change, await ps.reviewEvents(change.id))[0];
        if (current?.op === 'create_item' && (current.content ?? '') === body.text) {
          throw fail('invalid_request', 'pedido inválido: o texto é igual ao original; aceite sem editar');
        }
      }
      const done = await applyReview(ps, change, body.kind === 'edit' ? { edit: body.text } : body.kind, false);
      if (!done.ok) throw refusal(done);
      const proposal = await loadProposalView(ps, change);
      return emitter.emit(ResponseSchemas.decision, { proposal, log: toView(done.entry) }, [proposal]);
    });
  };

  const batchAccept: Handler = async ({ req, params, ps }) => {
    const body = parseBody<typeof BatchAcceptRequest._output>(BatchAcceptRequest, readBody(req));
    const ids = [...new Set(body.ids)];
    return locked(params.projectId!, async () => {
      const accepted: string[] = [];
      const refused: { id: string; code: BlockCode }[] = [];
      const log: LogEntryView[] = [];
      const seen: Change[] = [];
      for (const id of ids) {
        const change = await agentChange(ps, id);
        // O contrato 0.3.0 não tem `not_found` entre os BlockCode: id inexistente sai como `core_refused` ([C1]).
        if (change === undefined) { refused.push({ id, code: 'core_refused' }); continue; }
        seen.push(change);
        const view = await loadProposalView(ps, change); // fresco: aceitar uma pode ter tornado outra obsoleta
        if (!view.canBatchAccept.ok) { refused.push({ id, code: view.canBatchAccept.code }); continue; }
        const done = await applyReview(ps, change, 'accept', true);
        if (!done.ok) { refused.push({ id, code: done.code }); continue; }
        accepted.push(id);
        log.push(toView(done.entry));
      }
      const proposals: ProposalView[] = [];
      const gone = await undoneIds(ps);
      for (const c of seen) proposals.push(await loadProposalView(ps, c, gone));
      return emitter.emit(ResponseSchemas.batchAccept, { accepted, refused, proposals, log }, proposals);
    });
  };

  const undo: Handler = async ({ params, ps }) => {
    return locked(params.projectId!, async () => {
      const target = await undoTarget(ps);
      if (target === undefined) throw fail('not_allowed', 'nada a desfazer');
      if (!target.ok) throw fail('conflict', 'a decisão mais recente já foi seguida de mudanças nos mesmos itens');
      const out = await ps.undo(target.entry.version, actorId);
      if (!out.ok) {
        if (out.code === 'undo_conflict' || out.code === 'conflict') throw fail('conflict', 'não foi possível desfazer: o projeto mudou');
        throw fail('internal', 'erro interno');
      }
      if (!out.applied) throw fail('internal', 'erro interno');
      const entry = await ps.appendAudit({ action: 'undo', targetId: target.entry.changeId, coreVersion: out.version });
      const change = await agentChange(ps, target.entry.changeId);
      const proposal = change === undefined ? null : await loadProposalView(ps, change);
      return emitter.emit(ResponseSchemas.undo, { proposal, log: toView(entry) }, proposal === null ? [] : [proposal]);
    });
  };

  const getLog: Handler = async ({ ps }) => {
    const trail = await ps.audit();
    const view: LogEntryView[] = trail.map(toView);
    return emitter.emit(ResponseSchemas.log, view, []);
  };

  /** Uma entrada por rota do contrato. O tipo `Record<keyof Routes, ...>` faz o compilador exigir todas, e só elas. */
  const handlers: Record<keyof typeof Routes, Handler> = {
    captureSource, getSource, startExtraction, listProposals, getState, getLog,
    decide, batchAccept, undo,
  };

  const allowedOrigin = (req: ApiRequest): string | undefined => {
    const origin = req.headers?.origin;
    if (origin === undefined || deps.corsOrigins === undefined) return undefined;
    return deps.corsOrigins.includes(origin) ? origin : undefined;
  };
  const withCors = (req: ApiRequest, res: ApiResponse): ApiResponse => {
    const origin = allowedOrigin(req);
    if (origin !== undefined) res.headers = { ...res.headers, 'access-control-allow-origin': origin, vary: 'Origin' };
    return res;
  };

  return {
    async handle(req) {
      const done = (res: ApiResponse, route?: string, code?: string): ApiResponse => {
        log({ level: 'info', event: 'request', route: route ?? 'unknown', status: res.status, ...(code ? { code } : {}) });
        return withCors(req, res);
      };
      try {
        if (req.method === 'OPTIONS') {
          const origin = allowedOrigin(req);
          if (origin === undefined) throw fail('not_found', 'rota não encontrada');
          return done({
            status: 204,
            headers: {
              'access-control-allow-origin': origin, vary: 'Origin',
              'access-control-allow-methods': 'GET, POST, OPTIONS',
              'access-control-allow-headers': 'content-type',
            },
            body: null,
          }, 'preflight');
        }
        const hit = matchRoute(ROUTES, req.method, req.path);
        if (hit === undefined) throw fail('not_found', 'rota não encontrada');
        const ps = await deps.store.project(hit.params.projectId!);
        if (ps === undefined) throw fail('not_found', 'projeto não encontrado');
        const res = await handlers[hit.route.key]({ req, params: hit.params, ps });
        return done(res, hit.route.key);
      } catch (e) {
        if (e instanceof HttpError) return done(emitter.error(e), undefined, e.code);
        if (e instanceof ResponseInvalid) return done(emitter.error(fail('internal', 'erro interno')), undefined, 'internal');
        // Qualquer outra coisa: erro interno SEM pilha e sem mensagem original (pode conter texto de fonte).
        log({ level: 'error', event: 'unhandled', detail: e instanceof Error ? e.name : 'unknown' });
        return done(emitter.error(fail('internal', 'erro interno')), undefined, 'internal');
      }
    },
  };
}

function readBody(req: ApiRequest): unknown {
  if (req.body !== undefined) return req.body;
  if (req.rawBody === undefined || req.rawBody === '') throw fail('invalid_request', 'pedido inválido: corpo ausente');
  try {
    return JSON.parse(req.rawBody) as unknown;
  } catch {
    throw fail('invalid_request', 'pedido inválido: JSON malformado');
  }
}

const toView = (e: AuditEntry): LogEntryView => ({
  seq: e.seq, action: e.action, targetId: e.targetId, prevHash: e.prevHash, hash: e.hash, at: e.at,
});


