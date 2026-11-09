import { describe, it, expect } from "vitest";
import { ResponseSchemas, ProposalView, CONTRACT_VERSION, checkProposalInvariants } from "../src/index";
import { responses, allProposals, proposalOk, proposalMissingQuote, proposalAmbiguous, proposalDecision, proposalVerifierFailed } from "../src/fixtures";

describe("exemplos de referência cumprem os schemas", () => {
  const cases: [string, keyof typeof ResponseSchemas, unknown][] = [
    ["captureSource", "captureSource", responses.captureSource], ["extração ok", "extraction", responses.extractionOk],
    ["falha do fornecedor", "extraction", responses.extractionProviderFailure], ["decisão", "decision", responses.decision],
    ["lote", "batchAccept", responses.batchAccept], ["desfazer", "undo", responses.undo], ["estado", "state", responses.state],
    ["histórico", "log", responses.log], ["erro", "error", responses.apiError],
  ];
  for (const [name, key, data] of cases) it(name, () => expect(ResponseSchemas[key].safeParse(data).success).toBe(true));
  it("todas as propostas de referência são válidas e conformes", () => {
    for (const p of allProposals) { expect(ProposalView.safeParse(p).success).toBe(true); expect(checkProposalInvariants(p)).toEqual([]); }
  });
  it("versão do contrato definida", () => expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/));
});

describe("invariantes entre campos (o que o schema sozinho não apanha)", () => {
  const bad = (p: object) => checkProposalInvariants({ ...proposalOk, ...p } as never);
  it("citação não encontrada exige canAccept=citation_not_found", () =>
    expect(checkProposalInvariants({ ...proposalMissingQuote, canAccept: { ok: true } }).length).toBeGreaterThan(0));
  it("citação não encontrada não pode ir a lote", () =>
    expect(checkProposalInvariants({ ...proposalMissingQuote, canBatchAccept: { ok: true } }).length).toBeGreaterThan(0));
  it("decisão nunca em lote", () => expect(checkProposalInvariants({ ...proposalDecision, canBatchAccept: { ok: true } }).length).toBeGreaterThan(0));
  it("suporte parcial nunca em lote", () => expect(bad({ support: "partial" }).length).toBeGreaterThan(0));
  it("citação ambígua nunca em lote", () => expect(checkProposalInvariants({ ...proposalAmbiguous, canBatchAccept: { ok: true } }).length).toBeGreaterThan(0));
  it("editada exige suporte unchecked", () => expect(bad({ edited: true }).length).toBeGreaterThan(0));
  it("verificador falhou exige suporte unchecked", () => expect(checkProposalInvariants({ ...proposalVerifierFailed, support: "full" }).length).toBeGreaterThan(0));
  it("desatualizada não se aceita", () => expect(bad({ stale: true }).length).toBeGreaterThan(0));
  it("suporte none não se aceita", () => expect(bad({ support: "none" }).length).toBeGreaterThan(0));
  it("decidida: tudo already_decided", () => expect(bad({ status: "accepted" }).length).toBeGreaterThan(0));
  it("proposta pendente tem de poder ser rejeitada", () =>
    expect(bad({ canAccept: { ok: false, code: "stale" }, canReject: { ok: false, code: "stale" }, canBatchAccept: { ok: false, code: "stale" }, stale: true }).length).toBeGreaterThan(0));
});
