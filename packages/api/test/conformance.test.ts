import { assertProjectSchema } from '@sift/core';
import { ProposalView, ResponseSchemas } from '@sift/contract';
import { allProposals, proposalAccepted, proposalAmbiguous, proposalDecision, proposalMissingQuote, proposalOk, proposalVerifierFailed, responses } from '@sift/contract/src/fixtures';
import { researchV1 } from '@sift/schemas';
import { describe, expect, it } from 'vitest';
import { capture, claim, claim2, decision, ext, extract, harness, PROJECT, question, ver } from './helpers';

/**
 * Critério 23: para cada resposta de referência do contrato, a API tem de conseguir produzir uma DA MESMA FORMA.
 * "Mesma forma" = mesmas chaves obrigatórias (as opcionais podem faltar ou sobrar) e mesmos códigos de bloqueio.
 * Os exemplos do contrato tratam a afirmação como elegível a lote; no research@1 só a pergunta é (impacto baixo).
 * Para comparar a forma, a suíte usa uma variante do schema que libera o impacto médio (OPEN-DECISIONS).
 */
const loose = { ...(researchV1 as object), review: { batchEligibleImpact: ['low', 'medium'], maxChangesPerSet: 12 } };

const OPTIONAL = new Set(['originLabel', 'capturedAt', 'code']); // 'code' só existe quando a ação está bloqueada
const keysOf = (v: unknown, path = ''): string[] => {
  if (Array.isArray(v)) return v.length > 0 ? keysOf(v[0], path + '[]') : [];
  if (v !== null && typeof v === 'object') {
    return Object.entries(v as object).flatMap(([k, x]) => [`${path}.${k}`, ...keysOf(x, `${path}.${k}`)]);
  }
  return [];
};
const required = (v: unknown) => keysOf(v).filter((k) => !OPTIONAL.has(k.split('.').pop()!)).sort();
const sameForm = (ours: unknown, ref: unknown) => expect(required(ours)).toEqual(required(ref));

const blocks = (p: { canAccept: unknown; canReject: unknown; canBatchAccept: unknown }) =>
  [p.canAccept, p.canReject, p.canBatchAccept];

describe('conformidade com os exemplos de referência do contrato (fixtures.ts)', () => {
  it('captureSource', async () => {
    const h = harness();
    const r = await h.call('POST', `/projects/${PROJECT}/sources`, { name: 'ata.txt', text: 'texto exato da fonte' });
    expect(ResponseSchemas.captureSource.safeParse(r.body).success).toBe(true);
    sameForm(r.body, responses.captureSource);
  });

  it('extractionOk e as seis propostas de referência (ok, sem citação, ambígua, decisão, verificador falhou)', async () => {
    const schema = assertProjectSchema(loose);
    const text = 'Alpha is true here.\n\nIs Gamma ready?\n\nIs Gamma ready?\n\nBeta is also true here.';
    const h = harness(
      [ext([claim, question, decision, claim2]), ver('full'), ver('full'), ver('full'), { output: { verdict: '?' } }],
      {}, undefined, schema,
    );
    const id = await capture(h, text);
    const r = await extract(h, id);
    expect(ResponseSchemas.extraction.safeParse(r.body).success).toBe(true);
    const body = r.body as { proposals: any[] };
    sameForm(r.body, { ...responses.extractionOk, proposals: [proposalOk] });
    const [okClaim, ambiguousQuestion, aDecision, failed] = body.proposals;
    // proposalOk: afirmação, suporte full, citação única: tudo liberado (com a variante do schema)
    expect(blocks(okClaim)).toEqual(blocks(proposalOk));
    sameForm(okClaim, proposalOk);
    // proposalAmbiguous: aceitar ok, lote citation_ambiguous
    expect(blocks(ambiguousQuestion)).toEqual(blocks(proposalAmbiguous));
    sameForm(ambiguousQuestion, proposalAmbiguous);
    // proposalDecision
    expect(blocks(aDecision)).toEqual(blocks(proposalDecision));
    sameForm(aDecision, proposalDecision);
    // proposalVerifierFailed: suporte unchecked, lote support_not_full (ambiguidade da citação não muda o código)
    expect(failed).toMatchObject({ support: 'unchecked', verifierFailed: true });
    expect(failed.canAccept).toEqual(proposalVerifierFailed.canAccept);
    expect(failed.canReject).toEqual(proposalVerifierFailed.canReject);
    expect(failed.canBatchAccept).toEqual(proposalVerifierFailed.canBatchAccept);
    sameForm(failed, proposalVerifierFailed);
  });

  it('proposalAccepted: depois de aceita no núcleo, todas as ações são already_decided', async () => {
    const h = harness([ext([question]), ver('full')], {}, undefined, assertProjectSchema(loose));
    const id = await capture(h);
    const prop = ((await extract(h, id)).body as { proposals: { id: string }[] }).proposals[0]!;
    const ps = (await h.store.project(PROJECT))!;
    await ps.review({ changeId: prop.id as never, decision: 'accept', reviewer: { kind: 'human', id: 'u' as never } });
    const [after] = (await h.call('GET', `/projects/${PROJECT}/proposals`, undefined, { status: 'accepted' })).body as any[];
    expect(blocks(after)).toEqual(blocks(proposalAccepted));
    expect(after.status).toBe('accepted');
    sameForm(after, proposalAccepted);
  });

  it('extractionProviderFailure, state, log', async () => {
    const h = harness([{ error: 'x' }]);
    const id = await capture(h);
    const fail = await extract(h, id);
    expect(ResponseSchemas.extraction.safeParse(fail.body).success).toBe(true);
    sameForm(fail.body, responses.extractionProviderFailure);
    const state = await h.call('GET', `/projects/${PROJECT}/state`);
    expect(ResponseSchemas.state.safeParse(state.body).success).toBe(true);
    expect(Object.keys(state.body as object).sort()).toEqual(Object.keys(responses.state).sort());
    const log = await h.call('GET', `/projects/${PROJECT}/log`);
    expect(ResponseSchemas.log.safeParse(log.body).success).toBe(true);
    sameForm(log.body, responses.log);
  });

  it('as fixtures do contrato continuam válidas (guarda contra mudança do contrato sem aviso)', () => {
    for (const p of allProposals) expect(ProposalView.safeParse(p).success).toBe(true);
    expect(proposalMissingQuote.quote.found).toBe(0);
  });
});
