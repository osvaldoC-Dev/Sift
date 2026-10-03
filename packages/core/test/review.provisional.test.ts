import { describe, expect, it } from 'vitest';
import type { ChangeId, UserId } from '../src';
import {
  agent, createItem, createRelation, draftOf, just,
  type InMemoryLedger, type Outcome,
} from '../src/testing';
import { ev, h, newLedger } from './fixtures';

const U = { kind: 'human', id: 'u1' as UserId } as const;
const codeOf = (o: Outcome) => (o.ok ? 'ok' : o.code);
const E = (l: InMemoryLedger) => ev(l, 'ferve a 100 °C');

async function propose(l: InMemoryLedger, ops: Parameters<typeof draftOf>[1]['ops'], run = 'run1'): Promise<ChangeId> {
  const o = await l.propose(draftOf(l, { origin: agent(run), ops }));
  if (!o.ok || o.applied) throw new Error('proposta pendente esperada: ' + JSON.stringify(o));
  return o.change!.id;
}
const light = (l: InMemoryLedger, id: ChangeId) => l.review({ changeId: id, decision: 'accept_provisional', reviewer: U });
const full = (l: InMemoryLedger, id: ChangeId) => l.review({ changeId: id, decision: 'accept', reviewer: U });
const issueCodes = (o: Outcome) => (o.ok ? [] : (o.decisionIssues ?? []).map((d) => d.code));

describe('accept_provisional: só justificativa nunca passa por revisão leve', () => {
  it('justification_only é recusado em accept_provisional e aceito em accept individual', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'z1', type: 'alpha', status: 'final', content: 'base' }));
    const id = await propose(l, [
      createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [E(l)] }),
      createItem({ id: 'g1', type: 'gamma', status: 'open', content: 'pergunta' }),
      createRelation({ id: 'x1', type: 'asks', from: 'a1', to: 'g1', justification: just('derivado do item base por análise', 'z1') }),
    ]);
    expect(l.changes.get(id)!.basisKind).toBe('justification_only');
    const o = await light(l, id);
    expect(codeOf(o)).toBe('decision_not_allowed');
    expect(issueCodes(o)).toEqual(['accept_provisional_invalid']);
    expect(l.log).toHaveLength(1);
    expect(codeOf(await full(l, id))).toBe('ok');
  });

  it('o mesmo change com evidência no lugar da justificativa passa pela revisão leve', async () => {
    const l = newLedger();
    const id = await propose(l, [
      createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [E(l)] }),
      createItem({ id: 'g1', type: 'gamma', status: 'open', content: 'pergunta' }),
      createRelation({ id: 'x1', type: 'asks', from: 'a1', to: 'g1', evidence: [E(l)] }),
    ]);
    expect(l.changes.get(id)!.basisKind).toBe('evidence');
    expect(codeOf(await light(l, id))).toBe('ok');
  });
});

describe('accept_provisional: relação para item já adotado exige revisão individual', () => {
  it('relação que parte de item adotado (status final) é recusada na revisão leve', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a0', type: 'alpha', status: 'final', content: 'compromisso' }));
    const id = await propose(l, [
      createItem({ id: 'g2', type: 'gamma', status: 'open', content: 'e depois?', evidence: [E(l)] }),
      createRelation({ id: 'x2', type: 'asks', from: 'a0', to: 'g2', evidence: [E(l)] }),
    ]);
    const o = await light(l, id);
    expect(codeOf(o)).toBe('decision_not_allowed');
    expect(issueCodes(o)).toEqual(['accept_provisional_invalid']);
    expect(codeOf(await full(l, id))).toBe('ok');
  });

  it('relação que chega a item adotado também é recusada', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a0', type: 'alpha', status: 'final', content: 'compromisso' }));
    const id = await propose(l, [
      createItem({ id: 'a9', type: 'alpha', status: 'draft', content: 'novo', evidence: [E(l)] }),
      createRelation({ id: 'x9', type: 'backs', from: 'a9', to: 'a0', evidence: [E(l)] }),
    ]);
    expect(issueCodes(await light(l, id))).toEqual(['accept_provisional_invalid']);
  });

  it('extremos criados no mesmo change passam', async () => {
    const l = newLedger();
    const id = await propose(l, [
      createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [E(l)] }),
      createItem({ id: 'g1', type: 'gamma', status: 'open', content: 'pergunta' }),
      createRelation({ id: 'x1', type: 'asks', from: 'a1', to: 'g1', evidence: [E(l)] }),
    ]);
    expect(codeOf(await light(l, id))).toBe('ok');
  });

  it('extremo existente ainda provisório passa', async () => {
    const l = newLedger();
    const first = await propose(l, [createItem({ id: 'a3', type: 'alpha', status: 'draft', content: 'x', evidence: [E(l)] })]);
    expect(codeOf(await light(l, first))).toBe('ok');
    const second = await propose(l, [
      createItem({ id: 'g3', type: 'gamma', status: 'open', content: 'pergunta' }),
      createRelation({ id: 'x3', type: 'asks', from: 'a3', to: 'g3', evidence: [E(l)] }),
    ], 'run2');
    expect(codeOf(await light(l, second))).toBe('ok');
  });

  it('extremo existente de tipo sem provisionalStatus passa (o schema não distingue provisório de compromisso)', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'g0', type: 'gamma', status: 'open', content: 'pergunta existente' }));
    const id = await propose(l, [
      createItem({ id: 'a4', type: 'alpha', status: 'draft', content: 'x', evidence: [E(l)] }),
      createRelation({ id: 'x4', type: 'asks', from: 'a4', to: 'g0', evidence: [E(l)] }),
    ]);
    expect(codeOf(await light(l, id))).toBe('ok');
  });
});
