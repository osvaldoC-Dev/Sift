import {
  TEXT_KIND, contentHash as hashOf, normalizeText, prepareChange, verifyEvidence,
  type Attrs, type Change, type ChangeDraft, type ChangeId, type Clock, type Hash, type IdGenerator,
  type ItemId, type JsonValue, type ProjectId, type ProjectSchema, type RunId, type SchemaRef, type SourceKinds,
  type State, type TextEvidence,
} from '@sift/core';
import { ModelPortError, type ModelParams, type ModelPort, type ModelUsage } from '../ports';
import type { DiscardedItem, RunReport, VerifierDegraded } from '../report';
import { chunkSource, DEFAULT_MAX_CHUNK_CHARS, type Chunk } from './chunk';
import { isDuplicate, type DedupeKey } from './dedupe';
import { parseExtraction, parseVerdict, type ParsedItem } from './output';
import {
  EXTRACT_PROMPT_VERSION, ITEM_TYPES, VERIFY_PROMPT_VERSION, buildExtractRequest, buildVerifyRequest, type ExtractedType,
} from './prompt';

/**
 * Pipeline "Extrair": UMA fonte -> propostas (Changes) + relatório. Regras que não se negociam:
 *  - o modelo só devolve {type, statement, quote}. IDs e posições são do código;
 *  - a citação tem de existir, literalmente, na PASSAGEM enviada (não na fonte inteira); o deslocamento da
 *    passagem é somado ao índice achado;
 *  - o suporte (supportVerdict) vem só de uma chamada separada que vê SÓ afirmação + citação; `none` descarta;
 *  - o pipeline NUNCA escreve no log: devolve rascunhos prontos para `propose` e um relatório à parte;
 *  - saída do modelo fora do schema descarta a execução inteira (erro tipado, com `retryable`); item inválido, só o item;
 *  - saída inválida do VERIFICADOR não descarta nada: o item fica `unchecked` e o relatório registra o motivo;
 *    só falha do provedor descarta a execução.
 */

export interface ExtractDeps {
  model: ModelPort;
  schema: ProjectSchema;
  ids: IdGenerator;
  clock: Clock;
  kinds?: SourceKinds;
}

export interface ExtractInput {
  runId: RunId;
  projectId: ProjectId;
  baseVersion: number;
  schemaRef: SchemaRef;
  /** Estado sobre o qual o modelo trabalha: serve à validação e ao dedupe contra o que já existe. */
  state: State;
  source: { id: string; label: string; contentHash: Hash; text: string };
  params?: ModelParams;
  maxChunkChars?: number;
  /**
   * Fração (0..1) de itens `unchecked` por falha do verificador acima da qual o relatório leva `verifierDegraded`.
   * Padrão 0,5. A execução continua `ok:true`; o aviso só impede que a degradação passe em silêncio.
   */
  verifierDegradedThreshold?: number;
  signal?: AbortSignal;
}

export const DEFAULT_VERIFIER_DEGRADED_THRESHOLD = 0.5;

export type ExtractErrorCode =
  | 'schema_invalid' // a saída do modelo não tem a forma exigida: a execução inteira é descartada
  | 'provider_error' // falha do provedor
  | 'no_response' // só em modelos de teste
  | 'aborted' // o signal foi abortado
  | 'source_hash_mismatch' // o texto entregue não é o snapshot citado
  | 'schema_unsupported' // o Project Schema não declara um tipo extraído ou o status com que a IA o cria
  | 'cost_cap_exceeded'; // o teto de custo da execução foi atingido (adaptador real, 3.3)
export interface ExtractError {
  code: ExtractErrorCode;
  /** O runner (3.3) tenta UMA nova execução quando verdadeiro. */
  retryable: boolean;
  detail: string;
}

export type ExtractResult =
  | { ok: true; changes: Change[]; report: RunReport }
  | { ok: false; error: ExtractError; report: RunReport };

const RETRYABLE: Record<ExtractErrorCode, boolean> = {
  schema_invalid: true,
  provider_error: true,
  no_response: false,
  aborted: false,
  source_hash_mismatch: false,
  schema_unsupported: false,
  cost_cap_exceeded: false,
};

class Stop extends Error {
  constructor(readonly error: ExtractError) {
    super(error.detail);
  }
}
const stop = (code: ExtractErrorCode, detail: string, retryable?: boolean): Stop =>
  new Stop({ code, retryable: retryable ?? RETRYABLE[code], detail });

const addUsage = (a: ModelUsage, b: ModelUsage): ModelUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  ...(a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined
    ? { cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) } : {}),
  ...(a.estimated === true || b.estimated === true ? { estimated: true } : {}),
});

/**
 * Status com que a IA cria cada tipo extraído, LIDO DO PROJECT SCHEMA (nada fixo no código):
 *  - tipo com `provisionalStatus`: esse status (a IA só cria provisório);
 *  - tipo sem ele (ex.: pergunta): `open` se a IA puder criar em `open`; senão o único status permitido à IA.
 * Se o schema não declara o tipo, ou não dá um status inequívoco, devolve o motivo (erro tipado, nunca um
 * `validation_refused` mudo no meio da execução).
 */
export function resolveCreationStatuses(
  schema: ProjectSchema,
): { ok: true; byType: Record<ExtractedType, string> } | { ok: false; detail: string } {
  const byType = {} as Record<ExtractedType, string>;
  for (const type of ITEM_TYPES) {
    const def = schema.itemTypes[type];
    if (def === undefined) return { ok: false, detail: `o schema ${schema.key}@${schema.version} não declara o tipo "${type}"` };
    const allowed = def.creation.agent;
    let status: string | undefined;
    if (def.provisionalStatus !== undefined) status = def.provisionalStatus;
    else if (allowed.includes('open')) status = 'open';
    else if (allowed.length === 1) status = allowed[0];
    if (status === undefined || !allowed.includes(status)) {
      return { ok: false, detail: `o schema ${schema.key}@${schema.version} não dá à IA um status de criação inequívoco para "${type}"` };
    }
    byType[type] = status;
  }
  return { ok: true, byType };
}

interface Candidate {
  ref: string;
  chunk: Chunk;
  item: ParsedItem;
  start: number; // code points, relativos à fonte inteira
  end: number;
  ambiguous: boolean;
}

export async function extractFromSource(deps: ExtractDeps, input: ExtractInput): Promise<ExtractResult> {
  const params: ModelParams = input.params ?? {};
  const threshold = input.verifierDegradedThreshold ?? DEFAULT_VERIFIER_DEGRADED_THRESHOLD;
  if (!(threshold >= 0 && threshold <= 1)) throw new RangeError('verifierDegradedThreshold deve estar entre 0 e 1');
  const signal = input.signal;
  const kinds = deps.kinds;
  const text = input.source.text;
  const chunks = chunkSource(text, input.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS);

  let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  let model = '';
  let verifierModel: string | undefined;
  let modelChanges = 0;
  const discarded: DiscardedItem[] = [];
  const ambiguousCitations: string[] = [];
  const uncheckedByVerifier: { ref: string; detail: string }[] = [];
  const citedChunks = new Set<number>();
  let verifierDegraded: VerifierDegraded | null = null;

  const baseReport = (kept: number): RunReport => ({
    runId: input.runId, baseVersion: input.baseVersion, model, promptVersion: EXTRACT_PROMPT_VERSION, usage,
    modelChanges, kept, discarded, ambiguousCitations, uncheckedByVerifier, verifierDegraded,
    coverage: [{
      sourceId: input.source.id, contentHash: input.source.contentHash,
      passagesTotal: chunks.length, passagesCited: citedChunks.size,
    }],
  });
  const checkAbort = (): void => {
    if (signal?.aborted) throw stop('aborted', 'execução cancelada');
  };
  const call = async (request: Parameters<ModelPort['generate']>[0]) => {
    checkAbort();
    try {
      const res = await deps.model.generate(request);
      usage = addUsage(usage, res.usage);
      return res;
    } catch (e) {
      if (e instanceof ModelPortError) {
        if (e.usage !== undefined) usage = addUsage(usage, e.usage); // o gasto da chamada que falhou também conta
        throw stop(e.code === 'aborted' ? 'aborted'
          : e.code === 'no_response' ? 'no_response'
          : e.code === 'cost_cap_exceeded' ? 'cost_cap_exceeded' : 'provider_error', e.message,
          e.code === 'provider_error' ? e.retryable : undefined);
      }
      throw e;
    }
  };

  try {
    if (TEXT_KIND.hashOf(text) !== input.source.contentHash) {
      throw stop('source_hash_mismatch', 'o texto entregue não tem o hash do snapshot citado');
    }

    // 0. O schema tem de dizer com que status a IA cria cada tipo; falhar antes de gastar uma chamada.
    const statuses = resolveCreationStatuses(deps.schema);
    if (!statuses.ok) throw stop('schema_unsupported', statuses.detail);

    // 1. Extração, passagem por passagem.
    const candidates: Candidate[] = [];
    for (const chunk of chunks) {
      const res = await call(buildExtractRequest({ chunk, sourceLabel: input.source.label, params, signal }));
      if (model === '') model = res.model;
      const parsed = parseExtraction(res.output);
      if (!parsed.ok) throw stop('schema_invalid', `passagem ${chunk.index}: ${parsed.detail}`);
      for (const m of parsed.malformed) {
        modelChanges++;
        discarded.push({ ref: `c${chunk.index}.${m.index}`, reason: 'malformed_item', detail: m.detail });
      }
      for (const { index, item } of parsed.items) {
        modelChanges++;
        const ref = `c${chunk.index}.${index}`;
        // A citação tem de existir na PASSAGEM enviada. Achado dentro da passagem + início dela = posição na fonte.
        // A fonte guardada é NFC; uma citação decomposta (e + U+0301) é a mesma citação. Normalizar não conserta
        // nada: letra trocada, hifenização refeita ou espaço diferente continuam sem casar.
        const quote = normalizeText(item.quote);
        const found = TEXT_KIND.locate(chunk.text, quote);
        if (found.length === 0) {
          discarded.push({
            ref, reason: 'invalid_citation', quote, problem: 'text_mismatch',
            detail: 'a citação não existe, literalmente, na passagem enviada ao modelo',
          });
          continue;
        }
        const first = found[0]!;
        // Ambígua se aparece mais de uma vez na passagem OU em qualquer outro ponto da fonte inteira
        // (a mesma função do núcleo, `TEXT_KIND.locate`, agora sobre o texto todo).
        const ambiguous = TEXT_KIND.locate(text, quote).length > 1; // a passagem é recorte da fonte: repetida nela => repetida na fonte
        if (ambiguous) ambiguousCitations.push(ref);
        const start = chunk.start + (first.start as number);
        const end = chunk.start + (first.end as number);
        candidates.push({ ref, chunk, item: { ...item, quote }, start, end, ambiguous });
      }
    }

    // 2. Fidelidade mecânica no núcleo (existência + limites de tamanho) contra o snapshot inteiro.
    const reader = { get: async (h: Hash) => (h === input.source.contentHash ? text : undefined) };
    const located: Candidate[] = [];
    for (const c of candidates) {
      checkAbort();
      const ev: TextEvidence = { contentHash: input.source.contentHash, start: c.start, end: c.end, quote: c.item.quote };
      const op = { op: 'create_item' as const, itemId: 'x' as ItemId, type: c.item.type, status: 'x', attributes: {}, evidence: [ev] };
      const failures = await verifyEvidence([op], reader, undefined, kinds);
      if (failures.length > 0) {
        discarded.push({
          ref: c.ref, reason: 'invalid_citation', quote: c.item.quote, problem: failures[0]!.reason,
          detail: `verificação mecânica recusou a citação (${failures[0]!.reason})`,
        });
        continue;
      }
      located.push(c);
    }

    // 3. Dedupe: contra itens já no estado e contra o que a própria execução já manteve.
    const known: { key: DedupeKey; label: string }[] = [];
    for (const it of input.state.items.values()) {
      if (it.retired) continue;
      for (const e of it.evidence) {
        if (e.kind === undefined) {
          known.push({ key: { type: it.type, contentHash: e.contentHash, span: { start: e.start, end: e.end } }, label: it.id });
        }
      }
    }
    const fresh: Candidate[] = [];
    for (const c of located) {
      const key: DedupeKey = { type: c.item.type, contentHash: input.source.contentHash, span: { start: c.start, end: c.end } };
      const hit = known.find((k) => isDuplicate(key, k.key));
      if (hit) {
        discarded.push({ ref: c.ref, reason: 'duplicate', duplicateOf: hit.label, detail: 'mesmo tipo e citação equivalente' });
        continue;
      }
      known.push({ key, label: c.ref });
      fresh.push(c);
    }

    // 4. Suporte: chamada separada por item, vendo só afirmação + citação.
    // Falha do PROVEDOR no verificador descarta a execução (em `call`). Saída inválida do verificador NÃO:
    // o item fica `unchecked` (bloqueia aceite provisório e lote até revisão humana) e o problema vai ao relatório.
    const verified: { c: Candidate; verdict: 'full' | 'partial' | 'unchecked' }[] = [];
    for (const c of fresh) {
      const res = await call(buildVerifyRequest({ statement: c.item.statement, quote: c.item.quote, params, signal }));
      if (verifierModel === undefined) verifierModel = res.model;
      const v = parseVerdict(res.output);
      if (!v.ok) {
        uncheckedByVerifier.push({ ref: c.ref, detail: v.detail });
        verified.push({ c, verdict: 'unchecked' });
        continue;
      }
      if (v.verdict === 'none') {
        discarded.push({
          ref: c.ref, reason: 'not_supported', quote: c.item.quote, verdict: 'none',
          detail: 'o trecho existe, mas não sustenta a afirmação',
        });
        continue;
      }
      verified.push({ c, verdict: v.verdict });
    }

    if (fresh.length > 0 && uncheckedByVerifier.length / fresh.length > threshold) {
      verifierDegraded = {
        unchecked: uncheckedByVerifier.length, verified: fresh.length,
        fraction: uncheckedByVerifier.length / fresh.length, threshold,
      };
    }

    // 5. Montagem: origem completa de agente; o núcleo valida cada Change (0 problemas ou descarte).
    const originParams: Attrs = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined) originParams[k] = v as JsonValue;
    originParams.verifyPromptVersion = VERIFY_PROMPT_VERSION;
    if (verifierModel !== undefined) originParams.verifierModel = verifierModel;

    const changes: Change[] = [];
    for (const { c, verdict } of verified) {
      checkAbort();
      const draft: ChangeDraft = {
        id: deps.ids.next() as ChangeId,
        projectId: input.projectId,
        baseVersion: input.baseVersion,
        schemaRef: input.schemaRef,
        origin: { kind: 'agent', runId: input.runId, model, promptVersion: EXTRACT_PROMPT_VERSION, params: originParams },
        rationale: `Extraído de "${input.source.label}" (${c.ref})`,
        operations: [{
          op: 'create_item',
          itemId: deps.ids.next() as ItemId,
          type: c.item.type,
          status: statuses.byType[c.item.type],
          content: c.item.statement,
          attributes: {},
          evidence: [{
            contentHash: input.source.contentHash, start: c.start, end: c.end, quote: c.item.quote, supportVerdict: verdict,
          }],
        }],
        idempotencyKey: `${input.runId}:${input.source.id}:${c.ref}`,
        createdAt: deps.clock.now(),
      };
      const prepared = prepareChange(deps.schema, input.state, draft, kinds);
      if (prepared.issues.length > 0) {
        discarded.push({
          ref: c.ref, reason: 'validation_refused', issueCodes: prepared.issues.map((i) => i.code),
          detail: prepared.issues.map((i) => i.message).join('; '),
        });
        continue;
      }
      changes.push(prepared.change);
      citedChunks.add(c.chunk.index);
    }

    return { ok: true, changes, report: baseReport(changes.length) };
  } catch (e) {
    if (e instanceof Stop) {
      // Execução descartada por inteiro: nada é mantido; o relatório só registra o que foi gasto.
      modelChanges = 0;
      discarded.length = 0;
      ambiguousCitations.length = 0;
      uncheckedByVerifier.length = 0;
      verifierDegraded = null;
      citedChunks.clear();
      return { ok: false, error: e.error, report: baseReport(0) };
    }
    throw e;
  }
}
