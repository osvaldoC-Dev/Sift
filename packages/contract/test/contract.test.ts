import { describe, it, expect } from "vitest";
import {
  ProposalView, Quote, DecisionRequest, CaptureSourceRequest, ExtractionResponse,
  BatchAcceptResponse, LogEntry, StateView, Availability,
} from "../src/index";

const h = "a".repeat(64);
const quote = { text: "o trecho", sourceId: "s1", found: 1, start: 3, end: 11 };
const proposal = {
  id: "p1", type: "claim", text: "Afirmação.", quote, support: "full", status: "pending",
  provisional: false, edited: false, verifierFailed: false, stale: false, runId: "r1", originType: "ai",
  canAccept: { ok: true }, canReject: { ok: true }, canBatchAccept: { ok: false, code: "support_not_full" },
};

describe("ProposalView", () => {
  it("aceita uma proposta válida", () => expect(ProposalView.safeParse(proposal).success).toBe(true));
  it("recusa campos desconhecidos (ex.: o modelo a mandar verdict ou id)", () => {
    expect(ProposalView.safeParse({ ...proposal, verdict: "full" }).success).toBe(false);
  });
  it("verifierFailed é obrigatório e distinto de edited", () => {
    const { verifierFailed, ...sem } = proposal;
    expect(ProposalView.safeParse(sem).success).toBe(false);
    expect(ProposalView.safeParse({ ...proposal, support: "unchecked", verifierFailed: true }).success).toBe(true);
  });
  it("recusa suporte fora do enum", () => expect(ProposalView.safeParse({ ...proposal, support: "verified" }).success).toBe(false));
  it("recusa indisponível sem código", () => {
    expect(Availability.safeParse({ ok: false }).success).toBe(false);
    expect(Availability.safeParse({ ok: true, code: "stale" }).success).toBe(false);
  });
  it("existência da citação e suporte são campos distintos", () => {
    const p = ProposalView.parse({ ...proposal, quote: { ...quote, found: 0, start: null, end: null }, support: "full" });
    expect(p.quote.found).toBe(0); expect(p.support).toBe("full");
  });
});

describe("Quote", () => {
  it("found=0 exige start/end null", () => {
    expect(Quote.safeParse({ ...quote, found: 0 }).success).toBe(false);
    expect(Quote.safeParse({ ...quote, found: 0, start: null, end: null }).success).toBe(true);
  });
  it("found>0 recusa start/end null", () => expect(Quote.safeParse({ ...quote, start: null, end: null }).success).toBe(false));
  it("recusa end <= start", () => expect(Quote.safeParse({ ...quote, start: 5, end: 5 }).success).toBe(false));
  it("aceita ambígua (found>1)", () => expect(Quote.safeParse({ ...quote, found: 2 }).success).toBe(true));
});

describe("DecisionRequest", () => {
  it("accept e reject não levam texto", () => {
    expect(DecisionRequest.safeParse({ kind: "accept" }).success).toBe(true);
    expect(DecisionRequest.safeParse({ kind: "accept", text: "x" }).success).toBe(false);
    expect(DecisionRequest.safeParse({ kind: "reject", text: "x" }).success).toBe(false);
  });
  it("edit exige texto não vazio", () => {
    expect(DecisionRequest.safeParse({ kind: "edit" }).success).toBe(false);
    expect(DecisionRequest.safeParse({ kind: "edit", text: "   " }).success).toBe(false);
    expect(DecisionRequest.safeParse({ kind: "edit", text: "novo" }).success).toBe(true);
  });
  it("quem decide não pode enviar veredito, estado ou origem", () => {
    for (const extra of [{ support: "full" }, { status: "accepted" }, { originType: "human" }, { id: "x" }])
      expect(DecisionRequest.safeParse({ kind: "accept", ...extra }).success).toBe(false);
  });
});

describe("CaptureSourceRequest", () => {
  it("origem por omissão é human", () => expect(CaptureSourceRequest.parse({ name: "a", text: "b" }).originType).toBe("human"));
  it("recusa capturedAt que não é ISO-8601", () => expect(CaptureSourceRequest.safeParse({ name: "a", text: "b", capturedAt: "ontem" }).success).toBe(false));
  it("recusa texto vazio", () => expect(CaptureSourceRequest.safeParse({ name: "a", text: "" }).success).toBe(false));
});

describe("ExtractionResponse", () => {
  it("falha do fornecedor é um erro tipado, não uma lista vazia", () => {
    const r = { ok: false, error: { code: "provider_failure", retryable: true, message: "timeout" } };
    expect(ExtractionResponse.safeParse(r).success).toBe(true);
    expect(ExtractionResponse.safeParse({ ok: false, proposals: [] }).success).toBe(false);
  });
  it("sucesso leva o modelo e os descartes", () => {
    const r = { ok: true, runId: "r1", proposals: [proposal], discarded: 2, ambiguousCitations: 0, modelId: "m-1" };
    expect(ExtractionResponse.safeParse(r).success).toBe(true);
    expect(ExtractionResponse.safeParse({ ...r, modelId: undefined }).success).toBe(false);
  });
});

describe("outros", () => {
  it("lote devolve recusados com código", () => {
    const r = { accepted: ["p1"], proposals: [], refused: [{ id: "p2", code: "decision_individual_only" }], log: [] };
    expect(BatchAcceptResponse.safeParse(r).success).toBe(true);
    expect(BatchAcceptResponse.safeParse({ ...r, refused: [{ id: "p2" }] }).success).toBe(false);
  });
  it("LogEntry exige hashes de 64 hex; o primeiro tem prevHash null", () => {
    const e = { seq: 1, action: "accept", targetId: "p1", prevHash: null, hash: h, at: "2026-11-06T20:00:00+01:00" };
    expect(LogEntry.safeParse(e).success).toBe(true);
    expect(LogEntry.safeParse({ ...e, hash: "abc" }).success).toBe(false);
  });
  it("StateView aceita estado vazio com headHash null", () =>
    expect(StateView.safeParse({ items: [], relations: [], headHash: null, canUndo: false }).success).toBe(true));
});
