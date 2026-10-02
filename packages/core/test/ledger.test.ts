import { describe, expect, it } from 'vitest';
import { staleReasons, stateHash, verifyChain, type ChangeId, type UserId } from '../src';
import {
  agent, createItem, createRelation, draftOf, iid, just, retire, updateItem,
  type InMemoryLedger, type Outcome,
} from '../src/testing';
import { ev, h, newLedger } from './fixtures';

const U = { kind: 'human', id: 'u1' as UserId } as const;

function pendingOf(o: Outcome): ChangeId {
  if (!o.ok || o.applied) throw new Error('esperava proposta pendente: ' + JSON.stringify(o));
  return o.change!.id;
}
const codeOf = (o: Outcome) => (o.ok ? 'ok' : o.code);

async function propose(l: InMemoryLedger, ops: Parameters<typeof draftOf>[1]['ops'], extra: { base?: number; run?: string } = {}) {
  return pendingOf(await l.propose(draftOf(l, { origin: agent(extra.run ?? 'run1'), ops, base: extra.base })));
}
const accept = (l: InMemoryLedger, id: ChangeId, decision: 'accept' | 'accept_provisional' = 'accept') =>
  l.review({ changeId: id, decision, reviewer: U });

describe('ciclo de vida: proposta → revisão → log', () => {
  it('mudança humana entra no log na hora, pelo mesmo caminho, e fica aceita', async () => {
    const l = newLedger();
    const o = await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'afirmação' }));
    expect(o.ok).toBe(true);
    expect(l.log).toHaveLength(1);
    expect(l.state.items.get(iid('a1'))?.status).toBe('final');
    expect(verifyChain(l.log).ok).toBe(true);
    if (!o.ok || !o.applied) throw new Error();
    expect(l.statusOf(o.entry.changeId)).toBe('accepted');
  });

  it('proposta de agente não altera o log; aceitar cria a entrada e o item com proveniência', async () => {
    const l = newLedger();
    const id = await propose(l, [createItem({ id: 'a2', type: 'alpha', status: 'draft', content: 'ferve', evidence: [ev(l, 'ferve a 100 °C')] })]);
    expect(l.log).toHaveLength(0);
    expect(l.statusOf(id)).toBe('proposed');
    const o = await accept(l, id);
    expect(o.ok).toBe(true);
    const item = l.state.items.get(iid('a2'))!;
    expect(item.origin).toEqual(agent('run1'));
    expect(item.evidence).toHaveLength(1);
    expect(item.createdByChange).toBe(id);
    expect(l.statusOf(id)).toBe('accepted');
  });

  it('a proposta nunca é alterada por revisões (imutabilidade da proposta)', async () => {
    const l = newLedger();
    const id = await propose(l, [createItem({ id: 'a2', type: 'alpha', status: 'draft', content: 'original', evidence: [ev(l, 'ferve a 100 °C')] })]);
    const snapshot = JSON.stringify(l.changes.get(id));
    await l.review({ changeId: id, decision: 'defer', reviewer: U });
    await accept(l, id);
    expect(JSON.stringify(l.changes.get(id))).toBe(snapshot);
  });

  it('proposta sem evidência é inválida (basis_missing) e com trecho falso é falha de fidelidade', async () => {
    const l = newLedger();
    const noEv = await l.propose(draftOf(l, { origin: agent(), ops: [createItem({ id: 'a2', type: 'alpha', status: 'draft', content: 'x' })] }));
    expect(codeOf(noEv)).toBe('invalid');
    const fake = { ...ev(l, 'ferve a 100 °C'), quote: 'ferve a 99 °C!!' };
    const bad = await l.propose(draftOf(l, { origin: agent(), ops: [createItem({ id: 'a2', type: 'alpha', status: 'draft', content: 'x', evidence: [fake] })] }));
    expect(codeOf(bad)).toBe('fidelity');
    if (!bad.ok) expect(bad.failures![0]!.reason).toBe('text_mismatch');
    expect(l.changes.size).toBe(0);
  });

  it('reject e defer; depois de rejeitada, a proposta não está mais pendente', async () => {
    const l = newLedger();
    const id = await propose(l, [createItem({ id: 'a2', type: 'alpha', status: 'draft', content: 'x', evidence: [ev(l, 'ferve a 100 °C')] })]);
    await l.review({ changeId: id, decision: 'defer', reviewer: U });
    expect(l.statusOf(id)).toBe('deferred');
    await l.review({ changeId: id, decision: 'reject', reviewer: U, reasonCode: 'irrelevant' });
    expect(l.statusOf(id)).toBe('rejected');
    expect(codeOf(await accept(l, id))).toBe('not_pending');
  });

  it('accept_edited grava as operações editadas no log e preserva a proposta original', async () => {
    const l = newLedger();
    const e = ev(l, 'ferve a 100 °C');
    const id = await propose(l, [createItem({ id: 'a5', type: 'alpha', status: 'draft', content: 'original', evidence: [e] })]);
    const edited = [createItem({ id: 'a5', type: 'alpha', status: 'draft', content: 'texto editado', evidence: [e] })];
    const o = await l.review({ changeId: id, decision: 'accept_edited', reviewer: U, editedOperations: edited });
    expect(o.ok).toBe(true);
    expect(l.state.items.get(iid('a5'))?.content).toBe('texto editado');
    expect(l.log[0]!.decision).toBe('accept_edited');
    const stored = l.changes.get(id)!.operations[0]!;
    expect(stored.op === 'create_item' && stored.content).toBe('original');
    expect(l.statusOf(id)).toBe('accepted_edited');
  });

  it('accept_edited reverifica a evidência e exige as operações editadas', async () => {
    const l = newLedger();
    const e = ev(l, 'ferve a 100 °C');
    const id = await propose(l, [createItem({ id: 'a5', type: 'alpha', status: 'draft', content: 'original', evidence: [e] })]);
    const badEdit = [createItem({ id: 'a5', type: 'alpha', status: 'draft', content: 'x', evidence: [{ ...e, quote: 'ferve a 99 °C!!' }] })];
    expect(codeOf(await l.review({ changeId: id, decision: 'accept_edited', reviewer: U, editedOperations: badEdit }))).toBe('fidelity');
    expect(codeOf(await l.review({ changeId: id, decision: 'accept_edited', reviewer: U }))).toBe('decision_not_allowed');
    expect(codeOf(await l.review({ changeId: id, decision: 'accept', reviewer: U, editedOperations: badEdit }))).toBe('decision_not_allowed');
  });

  it('um change de várias operações é atômico e pode referenciar item criado nele mesmo', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'b1', type: 'beta', status: 'final', content: 'premissa' }));
    const e = ev(l, 'ao nível do mar');
    const id = await propose(l, [
      createItem({ id: 'a7', type: 'alpha', status: 'final', content: 'achado', evidence: [e] }),
      createRelation({ id: 'x7', type: 'opposes', from: 'a7', to: 'b1', attributes: { why: 'contradiz' }, evidence: [e] }),
    ]);
    expect(l.changes.get(id)!.impact).toBe('high');
    expect(codeOf(await accept(l, id))).toBe('ok');
    expect(l.state.relations.has(('x7' as never))).toBe(true);
    expect(l.log).toHaveLength(2);
  });
});

describe('regras de decisão', () => {
  it('revisor que não é humano nunca decide', async () => {
    const l = newLedger();
    const id = await propose(l, [createItem({ id: 'a2', type: 'alpha', status: 'draft', content: 'x', evidence: [ev(l, 'ferve a 100 °C')] })]);
    const o = await l.review({ changeId: id, decision: 'accept', reviewer: { kind: 'policy', id: 'auto' } });
    expect(codeOf(o)).toBe('decision_not_allowed');
    if (!o.ok) expect(o.decisionIssues![0]!.code).toBe('reviewer_must_be_human');
  });

  it('accept_provisional: tipo com provisionalStatus exige status provisório; tipo sem provisionalStatus é permitido; relação de impacto alto não', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'b1', type: 'beta', status: 'final', content: 'premissa' }));
    const e = ev(l, 'ferve a 100 °C');
    // provisório → ok
    const p1 = await propose(l, [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [e] })]);
    expect(codeOf(await accept(l, p1, 'accept_provisional'))).toBe('ok');
    // status final criado por agente → inválido como provisional
    const p2 = await propose(l, [createItem({ id: 'a2', type: 'alpha', status: 'final', content: 'x', evidence: [e] })]);
    expect(codeOf(await accept(l, p2, 'accept_provisional'))).toBe('decision_not_allowed');
    // tipo sem provisionalStatus (pergunta) → permitido
    const p3 = await propose(l, [createItem({ id: 'g1', type: 'gamma', status: 'open', content: 'pergunta' })]);
    expect(codeOf(await accept(l, p3, 'accept_provisional'))).toBe('ok');
    // relação de impacto alto → exige accept individual
    const p4 = await propose(l, [
      createItem({ id: 'a4', type: 'alpha', status: 'draft', content: 'y', evidence: [e] }),
      createRelation({ id: 'x4', type: 'opposes', from: 'a4', to: 'b1', attributes: { why: 'z' }, evidence: [e] }),
    ]);
    const bad = await accept(l, p4, 'accept_provisional');
    expect(codeOf(bad)).toBe('decision_not_allowed');
    if (!bad.ok) expect(bad.decisionIssues![0]!.code).toBe('accept_provisional_invalid');
    expect(codeOf(await accept(l, p4, 'accept'))).toBe('ok');
  });

  it('transição explícita: nunca por accept_provisional nem em lote; accept individual funciona', async () => {
    const l = newLedger();
    const e = ev(l, 'ferve a 100 °C');
    const c = await propose(l, [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [e] })]);
    await accept(l, c, 'accept_provisional');
    const p = await propose(l, [updateItem({ id: 'a1', before: { status: 'draft' }, patch: { status: 'final' } })]);
    expect(codeOf(await accept(l, p, 'accept_provisional'))).toBe('decision_not_allowed');
    const batch = await l.review({ changeId: p, decision: 'accept', reviewer: U, batch: true });
    expect(codeOf(batch)).toBe('decision_not_allowed');
    if (!batch.ok) expect(batch.decisionIssues!.map((d) => d.code)).toContain('batch_not_eligible');
    expect(codeOf(await accept(l, p))).toBe('ok');
    expect(l.state.items.get(iid('a1'))?.status).toBe('final');
  });

  it('só justificativa: marcado como justification_only, nunca em lote, mesmo com impacto baixo', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'base' }));
    const j = just('derivado do item base por análise', 'a1');
    const only = await propose(l, [
      createItem({ id: 'g1', type: 'gamma', status: 'open', content: 'pergunta' }),
      createRelation({ id: 'x1', type: 'asks', from: 'a1', to: 'g1', justification: j }),
    ]);
    expect(l.changes.get(only)!.basisKind).toBe('justification_only');
    expect(l.changes.get(only)!.impact).toBe('low');
    expect(codeOf(await l.review({ changeId: only, decision: 'accept', reviewer: U, batch: true }))).toBe('decision_not_allowed');
    expect(codeOf(await accept(l, only))).toBe('ok');
    expect(l.log.at(-1)!.appliedBasisKind).toBe('justification_only');

    const withEv = await propose(l, [
      createItem({ id: 'g2', type: 'gamma', status: 'open', content: 'outra' }),
      createRelation({ id: 'x2', type: 'asks', from: 'a1', to: 'g2', evidence: [ev(l, 'ferve a 100 °C')] }),
    ]);
    expect(l.changes.get(withEv)!.basisKind).toBe('evidence');
    expect(codeOf(await l.review({ changeId: withEv, decision: 'accept', reviewer: U, batch: true }))).toBe('ok');
  });

  it('promoção por humano exige base (evidência ancorada ou justificativa)', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'base' }));
    const p = await propose(l, [createItem({ id: 'b2', type: 'beta', status: 'draft', content: 'x', justification: just('inferido do item base por análise', 'a1') })]);
    await accept(l, p);
    const bare = await h(l, updateItem({ id: 'b2', before: { status: 'draft' }, patch: { status: 'final' } }));
    expect(codeOf(bare)).toBe('invalid');
    if (!bare.ok) expect(bare.issues!.map((i) => i.code)).toContain('basis_missing');
    const withJ = await h(l, updateItem({ id: 'b2', before: { status: 'draft' }, patch: { status: 'final' }, justification: just('confirmado por mim na reunião') }));
    expect(codeOf(withJ)).toBe('ok');
    expect(l.log.at(-1)!.appliedBasisKind).toBe('justification_only');
  });
});

describe('stale', () => {
  it('aceitar uma proposta invalida as pendentes que tocam os mesmos alvos; stale não se aplica', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'base' }));
    const x = await propose(l, [updateItem({ id: 'a1', before: { content: 'base' }, patch: { content: 'via X' } })]);
    const y = await propose(l, [retire({ item: 'a1' })], { run: 'run2' });
    expect(codeOf(await accept(l, x))).toBe('ok');
    expect(l.statusOf(y)).toBe('stale');
    expect(l.reviews.at(-1)!.reviewer).toEqual({ kind: 'system' });
    const o = await accept(l, y);
    expect(codeOf(o)).toBe('stale');
    if (!o.ok) expect(o.reasons![0]!.kind).toBe('target_changed');
    expect(codeOf(await l.review({ changeId: y, decision: 'reject', reviewer: U }))).toBe('ok');
    expect(l.statusOf(y)).toBe('rejected');
  });

  it('head andou mas os alvos não mudaram: continua aplicável (retry automático, D10)', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'um' }));
    await h(l, createItem({ id: 'a2', type: 'alpha', status: 'final', content: 'dois' }));
    const onA1 = await propose(l, [updateItem({ id: 'a1', before: { content: 'um' }, patch: { content: 'UM' } })]);
    const onA2 = await propose(l, [updateItem({ id: 'a2', before: { content: 'dois' }, patch: { content: 'DOIS' } })], { run: 'run2' });
    await accept(l, onA1);
    expect(l.statusOf(onA2)).toBe('proposed');
    expect(codeOf(await accept(l, onA2))).toBe('ok');
  });

  it('proposta feita sobre versão antiga já nasce stale se o alvo mudou depois', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'v1' }));
    await h(l, updateItem({ id: 'a1', before: { content: 'v1' }, patch: { content: 'v2' } }));
    const id = await propose(l, [updateItem({ id: 'a1', before: { content: 'v1' }, patch: { content: 'v3' } })], { base: 1 });
    expect(l.statusOf(id)).toBe('stale');
  });

  it('edição humana sobre versão antiga é conflito (sem last-write-wins, D3)', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'v1' }));
    await h(l, updateItem({ id: 'a1', before: { content: 'v1' }, patch: { content: 'v2' } }));
    const o = await l.submitHuman(draftOf(l, { origin: { kind: 'human', actorId: 'u2' as UserId }, base: 1,
      ops: [updateItem({ id: 'a1', before: { content: 'v1' }, patch: { content: 'meu' } })] }));
    expect(codeOf(o)).toBe('conflict');
    expect(l.log).toHaveLength(2);
  });

  it('accept_edited não resolve stale: a base do change não muda (ver docs/OPEN-DECISIONS.md)', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'base' }));
    const x = await propose(l, [updateItem({ id: 'a1', before: { content: 'base' }, patch: { content: 'X' } })]);
    const y = await propose(l, [updateItem({ id: 'a1', before: { content: 'base' }, patch: { content: 'Y' } })], { run: 'run2' });
    await accept(l, x);
    const edited = [updateItem({ id: 'a1', before: { content: 'X' }, patch: { content: 'Y editado' } })];
    const o = await l.review({ changeId: y, decision: 'accept_edited', reviewer: U, editedOperations: edited });
    expect(codeOf(o)).toBe('stale');
    expect(l.state.items.get(iid('a1'))?.content).toBe('X');
  });

  it('status recorde de stale coincide com o predicado derivado', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'base' }));
    const x = await propose(l, [updateItem({ id: 'a1', before: { content: 'base' }, patch: { content: 'X' } })]);
    const y = await propose(l, [retire({ item: 'a1' })], { run: 'run2' });
    await accept(l, x);
    for (const id of [x, y]) {
      const stale = staleReasons(l.changes.get(id)!, l.state).length > 0;
      expect(l.statusOf(id) === 'stale').toBe(id === y ? stale : false);
    }
  });
});

describe('desfazer = change compensatório', () => {
  it('desfazer criação: novo change no log, histórico anterior intacto, cadeia válida', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'x' }));
    const before = JSON.stringify(l.log[0]);
    const o = await l.undo(1, 'u1' as UserId);
    expect(o.ok).toBe(true);
    expect(l.log).toHaveLength(2);
    expect(JSON.stringify(l.log[0])).toBe(before);
    expect(verifyChain(l.log).ok).toBe(true);
    expect(l.state.items.get(iid('a1'))?.retired).toBe(true);
    expect(l.changes.get(l.log[1]!.changeId)!.compensates).toBe(1);
    // desfazer o desfazer reintegra o item
    expect((await l.undo(2, 'u1' as UserId)).ok).toBe(true);
    expect(l.state.items.get(iid('a1'))?.retired).toBe(false);
    expect(l.log).toHaveLength(3);
  });

  it('desfazer atualização restaura o valor anterior', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'original' }));
    await h(l, updateItem({ id: 'a1', before: { content: 'original' }, patch: { content: 'novo' } }));
    expect((await l.undo(2, 'u1' as UserId)).ok).toBe(true);
    expect(l.state.items.get(iid('a1'))?.content).toBe('original');
  });

  it('não desfaz quando uma versão posterior tocou o mesmo alvo (undo_conflict)', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'x' }));
    await h(l, updateItem({ id: 'a1', before: { content: 'x' }, patch: { content: 'y' } }));
    const o = await l.undo(1, 'u1' as UserId);
    expect(codeOf(o)).toBe('undo_conflict');
    if (!o.ok) expect(o.conflicts![0]!.id).toBe('a1');
    expect(l.log).toHaveLength(2);
  });

  it('desfazer um change de várias operações inverte na ordem contrária', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'b1', type: 'beta', status: 'final', content: 'premissa' }));
    const e = ev(l, 'ao nível do mar');
    const id = await propose(l, [
      createItem({ id: 'a7', type: 'alpha', status: 'final', content: 'achado', evidence: [e] }),
      createRelation({ id: 'x7', type: 'opposes', from: 'a7', to: 'b1', attributes: { why: 'z' }, evidence: [e] }),
    ]);
    await accept(l, id);
    expect((await l.undo(2, 'u1' as UserId)).ok).toBe(true);
    expect(l.state.items.get(iid('a7'))?.retired).toBe(true);
    expect(l.state.relations.get('x7' as never)?.retired).toBe(true);
  });
});

describe('idempotência', () => {
  it('a mesma chave devolve o mesmo resultado e não grava de novo', async () => {
    const l = newLedger();
    const mk = () => draftOf(l, { origin: { kind: 'human', actorId: 'u1' as UserId }, idempotencyKey: 'k1',
      ops: [createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'x' })] });
    const first = await l.submitHuman(mk());
    const second = await l.submitHuman(mk());
    expect(first.ok && first.applied && first.version).toBe(1);
    expect(second.ok && second.applied && second.version).toBe(1);
    expect(l.log).toHaveLength(1);
  });
});

void stateHash;
