import {
  analyzeChange, assertProjectSchema, emptyState, isBatchEligible, prepareChange,
  type Change, type ChangeStatus, type ProjectSchema, type State, type SupportVerdict,
} from '@sift/core';
import { InMemoryContents, agent, createItem, evidenceFor, updateItem } from '@sift/core/testing';
import { researchV1 } from '@sift/schemas';
import { checkProposalInvariants } from '@sift/contract';
import { describe, expect, it } from 'vitest';
import { buildProposalView, eligibility, weakest } from '../src';

const schema = assertProjectSchema(researchV1);
const SOURCE = 'Alpha is true here.\n\nIs Gamma ready?\n\nIs Gamma ready?';

function agentChange(
  type: 'claim' | 'question' | 'decision', verdict: SupportVerdict | undefined, quote = 'Alpha is true here.',
  sch: ProjectSchema = schema, text = SOURCE,
): Change {
  const contents = new InMemoryContents();
  const ev = verdict === undefined ? evidenceFor(contents, text, quote, undefined) : evidenceFor(contents, text, quote, verdict);
  const status = type === 'question' ? 'open' : 'provisional';
  const draft = {
    id: 'c1' as never, projectId: 'p1' as never, baseVersion: 0, schemaRef: { key: sch.key, version: sch.version },
    origin: agent('run1'), rationale: 'extração', createdAt: '2026-11-07T12:00:00.000Z',
    operations: [createItem({ id: 'i1', type, status, content: 'texto do item', evidence: [ev] })],
  };
  const prep = prepareChange(sch, emptyState(), draft);
  expect(prep.issues).toEqual([]);
  return prep.change;
}

const elig = (c: Change, o: { status?: ChangeStatus; found?: number; support?: SupportVerdict; state?: State; sch?: ProjectSchema } = {}) =>
  eligibility({
    schema: o.sch ?? schema, state: o.state ?? emptyState(), change: c, status: o.status ?? 'proposed',
    found: o.found ?? 1, support: o.support ?? 'full',
  });

describe('elegibilidade (B): as regras são as do núcleo, traduzidas para os códigos do contrato', () => {
  it('pergunta com suporte full e citação única: tudo liberado, inclusive lote', () => {
    expect(elig(agentChange('question', 'full'))).toEqual({
      canAccept: { ok: true }, canReject: { ok: true }, canBatchAccept: { ok: true },
    });
  });

  it('decisão e afirmação: aceitar individual ok; lote recusado (impacto fora de batchEligibleImpact)', () => {
    for (const [type, code] of [['decision', 'decision_individual_only'], ['claim', 'needs_individual_review']] as const) {
      const r = elig(agentChange(type, 'full'));
      expect(r.canAccept).toEqual({ ok: true });
      expect(r.canBatchAccept).toEqual({ ok: false, code });
    }
  });

  it('lote segue o núcleo: se o schema liberar o impacto médio, a afirmação passa a ser elegível (nada reimplementado)', () => {
    const open = assertProjectSchema({ ...(researchV1 as object), review: { batchEligibleImpact: ['low', 'medium'], maxChangesPerSet: 12 } });
    expect(elig(agentChange('claim', 'full', undefined, open), { sch: open }).canBatchAccept).toEqual({ ok: true });
    expect(elig(agentChange('decision', 'full', undefined, open), { sch: open }).canBatchAccept).toEqual({ ok: false, code: 'decision_individual_only' });
  });

  it('suporte unchecked/partial/sem veredito: aceitar individual ok, lote support_not_full', () => {
    for (const v of ['unchecked', 'partial', undefined] as const) {
      const r = elig(agentChange('question', v), { support: v ?? 'unchecked' });
      expect(r.canAccept).toEqual({ ok: true });
      expect(r.canBatchAccept).toEqual({ ok: false, code: 'support_not_full' });
    }
  });

  it('citação ambígua: aceitar ok, lote citation_ambiguous (só depois das regras do núcleo)', () => {
    const q = 'Is Gamma ready?';
    expect(elig(agentChange('question', 'full', q), { found: 2 }).canBatchAccept).toEqual({ ok: false, code: 'citation_ambiguous' });
    // estrutura vence a ambiguidade: uma decisão ambígua continua decision_individual_only
    expect(elig(agentChange('decision', 'full', q), { found: 2 }).canBatchAccept).toEqual({ ok: false, code: 'decision_individual_only' });
  });

  it('citação não encontrada: aceitar e lote citation_not_found; rejeitar continua possível', () => {
    expect(elig(agentChange('question', 'full'), { found: 0 })).toEqual({
      canAccept: { ok: false, code: 'citation_not_found' }, canReject: { ok: true },
      canBatchAccept: { ok: false, code: 'citation_not_found' },
    });
  });

  it('já decidida: tudo already_decided, para cada estado final do núcleo', () => {
    for (const status of ['accepted', 'accepted_provisional', 'accepted_edited', 'rejected'] as const) {
      const none = { ok: false, code: 'already_decided' };
      expect(elig(agentChange('question', 'full'), { status })).toEqual({ canAccept: none, canReject: none, canBatchAccept: none });
    }
  });

  it('proposta stale (estado do núcleo): aceitar e lote `stale`; rejeitar/dispensar continua possível', () => {
    const contents = new InMemoryContents();
    const ev = evidenceFor(contents, SOURCE, 'Alpha is true here.');
    const base: State = emptyState();
    const item = {
      id: 'i9', type: 'claim', status: 'provisional', content: 'antes', attributes: {},
      origin: agent('r0'), createdByChange: 'c0', createdVersion: 1, lastVersion: 5, retired: false, evidence: [],
    };
    const state: State = { ...base, version: 5, items: new Map([['i9' as never, item as never]]) };
    const draft = {
      id: 'c2' as never, projectId: 'p1' as never, baseVersion: 1, schemaRef: { key: 'research', version: 1 },
      origin: agent('run2'), rationale: 'atualiza', createdAt: '2026-11-07T12:00:00.000Z',
      operations: [updateItem({ id: 'i9', before: { content: 'antes' }, patch: { content: 'depois' }, evidence: [ev] })],
    };
    const change = { ...draft, impact: 'low', basisKind: 'evidence' } as Change;
    const r = elig(change, { state });
    expect(r).toEqual({ canAccept: { ok: false, code: 'stale' }, canReject: { ok: true }, canBatchAccept: { ok: false, code: 'stale' } });
    // marcada stale pelo núcleo (status), mesmo sem recalcular
    const marked = elig(agentChange('question', 'full'), { status: 'stale' });
    expect(marked.canAccept).toEqual({ ok: false, code: 'stale' });
    expect(marked.canReject).toEqual({ ok: true });
  });

  it('equivalência com o núcleo em todas as combinações: lote liberado <=> isBatchEligible e citação única', () => {
    const types = ['claim', 'question', 'decision'] as const;
    const verdicts: (SupportVerdict | undefined)[] = ['full', 'partial', 'unchecked', undefined];
    const schemas = [schema, assertProjectSchema({ ...(researchV1 as object), review: { batchEligibleImpact: ['low', 'medium'], maxChangesPerSet: 12 } })];
    let n = 0;
    for (const sch of schemas) for (const type of types) for (const v of verdicts) for (const found of [1, 2]) {
      const c = agentChange(type, v, 'Alpha is true here.', sch);
      const a = analyzeChange(sch, emptyState(), c);
      const expected = isBatchEligible(sch, c, a) && found === 1;
      expect(elig(c, { sch, found, support: v ?? 'unchecked' }).canBatchAccept.ok, `${type}/${v}/${found}`).toBe(expected);
      n++;
    }
    expect(n).toBe(48);
  });

  it('suporte mais fraco entre as evidências vale (none < unchecked < partial < full)', () => {
    const mk = (...vs: (SupportVerdict | undefined)[]) =>
      weakest(vs.map((supportVerdict) => ({ contentHash: 'a'.repeat(64), start: 0, end: 5, quote: 'abcde', supportVerdict })));
    expect(mk('full', 'partial')).toBe('partial');
    expect(mk('full', undefined)).toBe('unchecked');
    expect(mk('full', 'none', 'partial')).toBe('none');
    expect(mk('full')).toBe('full');
    expect(weakest([])).toBe('unchecked');
  });
});

describe('ProposalView montada pelo construtor (formas do contrato que o pipeline sozinho não produz)', () => {
  const view = (change: Change, text: string, status: ChangeStatus = 'proposed') =>
    buildProposalView({ schema, state: emptyState(), change, status, events: [], meta: undefined, source: { id: 's1', text } });

  it('citação ausente do texto guardado: found 0, start/end null, aceitar bloqueado, rejeitar livre', () => {
    const v = view(agentChange('question', 'full'), 'um texto que não contém a citação');
    expect(v.quote).toMatchObject({ found: 0, start: null, end: null });
    expect(v.canAccept).toEqual({ ok: false, code: 'citation_not_found' });
    expect(v.canReject).toEqual({ ok: true });
    expect(checkProposalInvariants(v)).toEqual([]);
  });

  it('só create_item/create_relation com citação são representáveis; o resto é recusado, não inventado', () => {
    const c = agentChange('question', 'full');
    expect(() => view({ ...c, operations: [] }, SOURCE)).toThrow();
    const noQuote = { ...c, operations: [{ ...c.operations[0]!, evidence: [] }] } as Change;
    expect(() => view(noQuote, SOURCE)).toThrow('citação');
  });

  it('proposta editada: texto e suporte vêm das operações efetivas (unchecked quando o conteúdo mudou)', () => {
    const c = agentChange('claim', 'full');
    const op = c.operations[0]!;
    if (op.op !== 'create_item') throw new Error();
    const editedOps = [{ ...op, content: 'texto editado pela pessoa', evidence: op.evidence.map((e) => ({ ...e, supportVerdict: 'unchecked' as const })) }];
    const v = buildProposalView({
      schema, state: emptyState(), change: c, status: 'accepted_edited', meta: undefined, source: { id: 's1', text: SOURCE },
      events: [{ id: 'e1', changeId: c.id, decision: 'accept_edited', reviewer: { kind: 'human', id: 'u' as never }, at: 'x', editedOperations: editedOps }],
    });
    expect(v).toMatchObject({ text: 'texto editado pela pessoa', support: 'unchecked', edited: true, status: 'accepted' });
    expect(checkProposalInvariants(v)).toEqual([]);
  });
});
