/** Exemplos de referência (golden) de cada resposta. A API tem de conseguir produzir respostas com esta forma;
 *  a interface e o servidor falso podem usá-los em testes. Tudo inventado, sem dados reais. */
import type { ProposalView } from "./index";

export const H1 = "a".repeat(64), H2 = "b".repeat(64), H3 = "c".repeat(64);
const base = { provisional: false, edited: false, verifierFailed: false, stale: false, runId: "run-1", originType: "ai" as const };
const ok = { ok: true as const };

export const proposalOk: ProposalView = {
  ...base, id: "p1", type: "claim", text: "O serviço de faturação é pouco acoplado.", support: "full", status: "pending",
  quote: { text: "é pouco acoplado", sourceId: "s1", found: 1, start: 20, end: 36 },
  canAccept: ok, canReject: ok, canBatchAccept: ok,
};
export const proposalMissingQuote: ProposalView = {
  ...base, id: "p2", type: "claim", text: "O custo vai duplicar.", support: "full", status: "pending",
  quote: { text: "vai duplicar no primeiro ano", sourceId: "s1", found: 0, start: null, end: null },
  canAccept: { ok: false, code: "citation_not_found" }, canReject: ok, canBatchAccept: { ok: false, code: "citation_not_found" },
};
export const proposalAmbiguous: ProposalView = {
  ...base, id: "p3", type: "assumption", text: "A equipa mantém cinco pessoas.", support: "full", status: "pending",
  quote: { text: "a equipa mantém cinco pessoas", sourceId: "s1", found: 2, start: 10, end: 39 },
  canAccept: ok, canReject: ok, canBatchAccept: { ok: false, code: "citation_ambiguous" },
};
export const proposalDecision: ProposalView = {
  ...base, id: "p4", type: "decision", text: "Migrar primeiro a faturação.", support: "full", status: "pending", provisional: true,
  quote: { text: "Decidimos migrar primeiro", sourceId: "s1", found: 1, start: 0, end: 25 },
  canAccept: ok, canReject: ok, canBatchAccept: { ok: false, code: "decision_individual_only" },
};
export const proposalVerifierFailed: ProposalView = {
  ...base, id: "p5", type: "relation", text: "Contradiz o item A1.", support: "unchecked", status: "pending", verifierFailed: true,
  quote: { text: "cinco serviços em produção", sourceId: "s1", found: 1, start: 5, end: 31 },
  canAccept: ok, canReject: ok, canBatchAccept: { ok: false, code: "support_not_full" },
};
export const proposalAccepted: ProposalView = {
  ...proposalOk, id: "p6", status: "accepted",
  canAccept: { ok: false, code: "already_decided" }, canReject: { ok: false, code: "already_decided" }, canBatchAccept: { ok: false, code: "already_decided" },
};
export const allProposals = [proposalOk, proposalMissingQuote, proposalAmbiguous, proposalDecision, proposalVerifierFailed, proposalAccepted];

export const logEntry = { seq: 1, action: "accept" as const, targetId: "p1", prevHash: null, hash: H1, at: "2026-11-07T19:00:00+01:00" };
export const source = { id: "s1", name: "ata.txt", text: "texto exato da fonte", contentHash: H2 };

export const responses = {
  captureSource: { source },
  extractionOk: { ok: true, runId: "run-1", proposals: allProposals, discarded: 1, ambiguousCitations: 1, modelId: "modelo-de-teste" },
  extractionProviderFailure: { ok: false, error: { code: "provider_failure", retryable: true, message: "tempo esgotado" } },
  decision: { proposal: proposalAccepted, log: logEntry },
  batchAccept: { accepted: ["p1"], refused: [{ id: "p4", code: "decision_individual_only" }], log: [logEntry] },
  undo: { proposal: proposalOk, log: { ...logEntry, seq: 2, action: "undo" as const, prevHash: H1, hash: H3 } },
  state: { items: [{ id: "i1", type: "claim", text: "Afirmação adotada.", sourceIds: ["s1"] }], relations: [], headHash: H1 },
  log: [logEntry],
  apiError: { code: "not_allowed", message: "A citação não existe na fonte.", block: "citation_not_found" },
} as const;
