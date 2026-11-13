/**
 * @sift/contract — formato dos dados entre a API (Claude 2) e a interface (Claude 3).
 * Só descreve JSON. Não importa nada de core/ai/db, não tem lógica de domínio.
 *
 * Regras que este contrato fixa:
 *  - A interface NUNCA calcula elegibilidade, verificação, hash nem estado: recebe-os prontos.
 *  - A existência da citação (`quote.found`) e o suporte (`support`) são campos separados.
 *  - Quem decide envia só a intenção (accept / reject / edit). Nunca envia veredito, estado, id novo nem origem.
 *  - Todos os objetos são `.strict()`: campos desconhecidos são recusados.
 */
import { z } from "zod";

const Id = z.string().min(1);
const Iso = z.string().datetime({ offset: true });
const Hash = z.string().regex(/^[0-9a-f]{64}$/);

export const ItemType = z.enum(["claim", "assumption", "question", "decision", "relation"]);
export const Support = z.enum(["full", "partial", "none", "unchecked"]);
export const ProposalStatus = z.enum(["pending", "accepted", "rejected"]);

/** Porque é que uma ação não está disponível. A interface traduz o código para texto. */
export const BlockCode = z.enum([
  "already_decided",
  "citation_not_found",
  "citation_ambiguous",
  "support_not_full",
  "support_none",
  "decision_individual_only",
  "relation_touches_adopted",
  "stale",
  "needs_individual_review", // lote recusado pela estrutura do núcleo (impacto, transição, só justificação)
  "core_refused", // o núcleo recusou por uma regra que o contrato não nomeia; nunca fazer a API lançar erro por isto
]);
export const Availability = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), code: BlockCode }).strict(),
]);

/** Citação já verificada pelo servidor. `found` é a existência; não diz se sustenta a afirmação.
 *  `start`/`end`: pontos de código Unicode (não unidades UTF-16) sobre `SourceView.text`, que é o texto NORMALIZADO (NFC)
 *  guardado pelo servidor. A interface mostra sempre o `SourceView.text` devolvido, nunca o que a pessoa colou. */
export const Quote = z
  .object({
    text: z.string().min(1),
    sourceId: Id,
    found: z.number().int().min(0), // nº de ocorrências na fonte
    start: z.number().int().min(0).nullable(), // primeira ocorrência; null se found = 0
    end: z.number().int().min(0).nullable(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const missing = q.found === 0;
    if (missing !== (q.start === null) || missing !== (q.end === null))
      ctx.addIssue({ code: "custom", message: "start/end são null se e só se found = 0" });
    if (q.start !== null && q.end !== null && q.end <= q.start)
      ctx.addIssue({ code: "custom", message: "end tem de ser maior que start" });
  });

export const ProposalView = z
  .object({
    id: Id,
    type: ItemType,
    text: z.string().min(1),
    quote: Quote,
    support: Support, // opinião do modelo; `unchecked` também quando o verificador falhou ou o texto foi editado
    status: ProposalStatus,
    provisional: z.boolean(),
    edited: z.boolean(),
    /** true se o verificador falhou ou deu saída inválida neste item (o suporte fica `unchecked`). Distinto de `edited`. */
    verifierFailed: z.boolean(),
    stale: z.boolean(),
    runId: Id,
    originType: z.enum(["human", "ai"]),
    originLabel: z.string().optional(),
    /** Disponibilidade calculada pelo servidor. A interface só mostra. */
    canAccept: Availability,
    canReject: Availability,
    canBatchAccept: Availability,
  })
  .strict();

export const SourceView = z
  .object({
    id: Id,
    name: z.string().min(1),
    text: z.string(), // texto exato guardado (instantâneo); os offsets das citações referem-se a ele
    contentHash: Hash,
    capturedAt: Iso.optional(), // não verificado, nunca entra na lógica
  })
  .strict();

export const Evidence = z
  .object({ sourceId: Id, quote: z.string().min(1), start: z.number().int().min(0).nullable(), end: z.number().int().min(0).nullable() })
  .strict();
export const StateItem = z
  .object({ id: Id, type: ItemType, text: z.string().min(1), sourceIds: z.array(Id), evidence: z.array(Evidence) })
  .strict();
/** `kind` é livre: os nomes de relação vêm do schema do projeto (dado), não do contrato. A interface mostra o que conhece e o resto em bruto. */
export const StateRelation = z.object({ id: Id, kind: z.string().min(1), from: Id, to: Id }).strict();
export const StateView = z
  .object({ items: z.array(StateItem), relations: z.array(StateRelation), headHash: Hash.nullable(), canUndo: z.boolean() })
  .strict();

export const LogEntry = z
  .object({
    seq: z.number().int().min(1),
    action: z.enum(["accept", "accept_batch", "accept_edited", "reject", "undo", "capture_source", "propose"]),
    targetId: Id,
    prevHash: Hash.nullable(),
    hash: Hash,
    at: Iso,
  })
  .strict();

/* ---------- pedidos ---------- */

export const CaptureSourceRequest = z
  .object({
    name: z.string().min(1).max(200),
    text: z.string().min(1).max(2_000_000),
    originType: z.enum(["human", "ai"]).default("human"),
    originLabel: z.string().max(200).optional(),
    originRunId: Id.optional(), // obrigatório quando originType = ai
    capturedAt: Iso.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.originType === "ai" && r.originRunId === undefined) ctx.addIssue({ code: "custom", message: "fonte de IA exige originRunId" });
    if (r.originType === "human" && r.originRunId !== undefined) ctx.addIssue({ code: "custom", message: "originRunId só existe em fontes de IA" });
  });
export const CaptureSourceResponse = z.object({ source: SourceView }).strict();

export const StartExtractionRequest = z.object({ sourceId: Id }).strict();
export const ExtractionError = z
  .object({ code: z.enum(["provider_failure", "schema_invalid", "source_too_large"]), retryable: z.boolean(), message: z.string() })
  .strict();
export const ExtractionResponse = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      runId: Id,
      proposals: z.array(ProposalView),
      discarded: z.number().int().min(0), // itens inválidos descartados pelo pipeline
      ambiguousCitations: z.number().int().min(0),
      modelId: z.string(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: ExtractionError }).strict(),
]);

/** Decisão: só a intenção. `text` existe se e só se kind = edit. Nada de veredito, estado ou id. */
export const DecisionRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept") }).strict(),
  z.object({ kind: z.literal("reject") }).strict(),
  z.object({ kind: z.literal("edit"), text: z.string().trim().min(1).max(5000) }).strict(),
]);
export const DecisionResponse = z.object({ proposal: ProposalView, log: LogEntry }).strict();

export const BatchAcceptRequest = z.object({ ids: z.array(Id).min(1).max(500) }).strict();
export const BatchAcceptResponse = z
  .object({
    accepted: z.array(Id),
    refused: z.array(z.object({ id: Id, code: BlockCode }).strict()),
    proposals: z.array(ProposalView), // propostas atualizadas (as aceites e as recusadas)
    log: z.array(LogEntry),
  })
  .strict();

export const UndoResponse = z.object({ proposal: ProposalView.nullable(), log: LogEntry }).strict();

export const ApiError = z
  .object({
    code: z.enum(["not_found", "invalid_request", "not_allowed", "stale", "conflict", "internal"]),
    message: z.string(),
    block: BlockCode.optional(), // presente quando code = not_allowed
  })
  .strict();

/** Rotas (para o servidor e para o cliente falso usarem os mesmos nomes). */
export const Routes = {
  captureSource: "POST /projects/:projectId/sources",
  getSource: "GET /projects/:projectId/sources/:sourceId",
  startExtraction: "POST /projects/:projectId/extractions",
  listProposals: "GET /projects/:projectId/proposals?status=pending|accepted|rejected",
  decide: "POST /projects/:projectId/proposals/:proposalId/decision",
  batchAccept: "POST /projects/:projectId/proposals/batch-accept",
  undo: "POST /projects/:projectId/undo",
  getState: "GET /projects/:projectId/state",
  getLog: "GET /projects/:projectId/log",
} as const;

export type ItemType = z.infer<typeof ItemType>;
export type Support = z.infer<typeof Support>;
export type BlockCode = z.infer<typeof BlockCode>;
export type ProposalView = z.infer<typeof ProposalView>;
export type SourceView = z.infer<typeof SourceView>;
export type StateView = z.infer<typeof StateView>;
export type LogEntry = z.infer<typeof LogEntry>;
export type DecisionRequest = z.infer<typeof DecisionRequest>;
export type ExtractionResponse = z.infer<typeof ExtractionResponse>;

/** Versão do contrato. Mudanças compatíveis (campos opcionais novos) sobem a minor; quebras sobem a major. */
export const CONTRACT_VERSION = "0.3.0";

/** Schema de resposta de cada rota (para a API e o cliente validarem do mesmo modo). */
export const ResponseSchemas = {
  captureSource: CaptureSourceResponse,
  getSource: CaptureSourceResponse,
  proposals: z.array(ProposalView),
  extraction: ExtractionResponse,
  decision: DecisionResponse,
  batchAccept: BatchAcceptResponse,
  undo: UndoResponse,
  state: StateView,
  log: z.array(LogEntry),
  error: ApiError,
} as const;

export { checkProposalInvariants } from "./invariants";
