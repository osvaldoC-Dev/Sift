import {
  normalizeText, type Change, type ChangeDraft, type ChangeId, type Clock, type IdGenerator, type UserId,
} from '@sift/core';
import { extractFromSource, sourceCreationOp, type ExtractError, type ModelParams, type ModelPort } from '@sift/ai';
import {
  CaptureSourceRequest, CaptureSourceResponse, ExtractionResponse, ProposalView, ResponseSchemas, Routes,
  StartExtractionRequest,
  StateView, type LogEntry as LogEntryView, type SourceView,
} from '@sift/contract';
import {
  HttpError, ResponseInvalid, compileRoutes, fail, makeEmitter, matchRoute, parseBody,
  type ApiRequest, type ApiResponse,
} from './http';
import type { AuditEntry, ProjectStore, SourceRecord, Store } from './store';
import { listProposalViews, loadProposalView } from './views';

/** Evento de log SEM conteúdo: rota, estado, códigos. Nunca texto de fonte, citação, chave nem pilha. */
export interface LogEvent {
  level: 'info' | 'error';
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
    case 'source_hash_mismatch': throw fail('internal', 'erro interno');
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
      // O núcleo exige a execução de origem de uma fonte de IA; o contrato 0.2.1 não a carrega. Recusar é mais
      // honesto do que inventar uma proveniência (OPEN-DECISIONS).
      throw fail('invalid_request', 'fonte de IA exige a execução de origem, que o contrato ainda não carrega');
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
          id, label: body.name, contentHash, originType: 'human',
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
    return emitter.emit(CaptureSourceResponse, { source: await sourceView(ps, rec) }, []);
  };

  const startExtraction: Handler = async ({ req, params, ps }) => {
    const body = parseBody<{ sourceId: string }>(StartExtractionRequest, readBody(req));
    return locked(params.projectId!, async () => {
      const src = await ps.getSource(body.sourceId);
      if (src === undefined) throw fail('not_found', 'fonte não encontrada');
      const text = await ps.getContent(src.contentHash);
      if (text === undefined) throw fail('internal', 'erro interno');
      const runId = deps.ids.next();
      const state = await ps.state();
      const result = await extractFromSource(
        { model: deps.model, schema: ps.schema, ids: deps.ids, clock: deps.clock },
        {
          runId: runId as never, projectId: ps.projectId, baseVersion: state.version,
          schemaRef: { key: ps.schema.key, version: ps.schema.version }, state,
          source: { id: src.id, label: src.name, contentHash: src.contentHash, text },
          ...(deps.extractionParams !== undefined ? { params: deps.extractionParams } : {}),
          ...(deps.maxChunkChars !== undefined ? { maxChunkChars: deps.maxChunkChars } : {}),
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
      const modelId = result.report.model;
      if (modelId === '') throw fail('internal', 'erro interno');
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
    return emitter.emit(ProposalView.array(), views, views);
  };

  const getState: Handler = async ({ ps }) => {
    const state = await ps.state();
    const entries = await ps.entries();
    const items = [];
    for (const it of state.items.values()) {
      if (it.retired || !ProposalView.shape.type.options.includes(it.type as never) || it.type === 'relation') continue;
      const sourceIds: string[] = [];
      for (const ev of it.evidence) {
        const s = await ps.sourceByHash(ev.contentHash);
        if (s !== undefined && !sourceIds.includes(s.id)) sourceIds.push(s.id);
      }
      items.push({ id: it.id, type: it.type, text: it.content ?? '', sourceIds });
    }
    // Só as relações cujo tipo o contrato conhece (OPEN-DECISIONS: research@1 usa outros nomes).
    const relations = [...state.relations.values()]
      .filter((r) => !r.retired && ['contradiction', 'near_miss', 'duplicate'].includes(r.type))
      .map((r) => ({ id: r.id, kind: r.type, from: r.from, to: r.to }));
    const headHash = entries.length > 0 ? entries[entries.length - 1]!.entryHash : null;
    return emitter.emit(StateView, { items, relations, headHash }, []);
  };

  const getLog: Handler = async ({ ps }) => {
    const trail = await ps.audit();
    const view: LogEntryView[] = trail.map(toView);
    return emitter.emit(ResponseSchemas.log, view, []);
  };

  const notYet: Handler = async () => {
    throw new HttpError('internal', 'rota ainda não implementada (incremento 2 da API)');
  };

  /** Uma entrada por rota do contrato. O tipo `Record<keyof Routes, ...>` faz o compilador exigir todas, e só elas. */
  const handlers: Record<keyof typeof Routes, Handler> = {
    captureSource, getSource, startExtraction, listProposals, getState, getLog,
    decide: notYet, batchAccept: notYet, undo: notYet,
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


