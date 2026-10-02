import { describe, expect, it } from 'vitest';
import {
  analyzeChange, assertProjectSchema, isBatchEligible, parseProjectSchema, reconstruct,
  stateHash, verifyChain, type ChangeId, type ProjectSchema, type UserId,
} from '@sift/core';
import {
  InMemoryLedger, agent, createItem, createRelation, draftOf, evidenceFor, fixedClock,
  human, iid, just, retire, sequentialIds, updateItem, type Outcome,
} from '@sift/core/testing';
import { decisionsV1, researchV1 } from '../src';

const TEXT = 'A água ferve a 100 °C ao nível do mar. Segundo trecho, bem distinto do primeiro.';
const U = { kind: 'human', id: 'u1' as UserId } as const;

function ledgerFor(schemaJson: unknown): InMemoryLedger {
  return new InMemoryLedger({
    schema: assertProjectSchema(schemaJson),
    projectId: 'p1' as never,
    clock: fixedClock(),
    ids: sequentialIds('c'),
  });
}
const h = (l: InMemoryLedger, ...ops: Parameters<typeof draftOf>[1]['ops']) =>
  l.submitHuman(draftOf(l, { origin: human(), ops }));
const E = (l: InMemoryLedger, q = 'ferve a 100 °C') => evidenceFor(l.contents, TEXT, q);
const pend = (o: Outcome): ChangeId => {
  if (!o.ok || o.applied) throw new Error('esperava proposta: ' + JSON.stringify(o));
  return o.change!.id;
};
const propose = async (l: InMemoryLedger, ops: Parameters<typeof draftOf>[1]['ops'], run = 'run1') =>
  pend(await l.propose(draftOf(l, { origin: agent(run), ops })));
const codeOf = (o: Outcome) => (o.ok ? 'ok' : o.code);

describe('os dois schemas são válidos', () => {
  it('research@1 e decisions@1 passam no parse', () => {
    for (const s of [researchV1, decisionsV1]) {
      const r = parseProjectSchema(s);
      expect(r.ok ? 'ok' : JSON.stringify(r.issues)).toBe('ok');
    }
  });
});

// ---- Contrato: a MESMA suíte de invariantes roda sobre domínios diferentes, sem tocar o core ----

interface Kit {
  name: string;
  schema: unknown;
  a: { type: string; status: string }; // item "de origem" (extremo from da relação)
  b: { type: string; status: string }; // item editável (extremo to da relação)
  rel: { type: string };
}
const kits: Kit[] = [
  { name: 'research', schema: researchV1, a: { type: 'claim', status: 'active' }, b: { type: 'assumption', status: 'adopted' }, rel: { type: 'supports' } },
  { name: 'decisions', schema: decisionsV1, a: { type: 'option', status: 'proposed' }, b: { type: 'topic', status: 'open' }, rel: { type: 'belongs_to' } },
];

for (const kit of kits) {
  describe(`contrato do core com o schema ${kit.name}`, () => {
    async function seeded() {
      const l = ledgerFor(kit.schema);
      await h(l, createItem({ id: 'ia', ...kit.a, content: 'item de origem' }));
      await h(l, createItem({ id: 'ib', ...kit.b, content: 'item editável' }));
      expect(codeOf(await h(l, createRelation({ id: 'r1', type: kit.rel.type, from: 'ia', to: 'ib' })))).toBe('ok');
      return l;
    }

    it('reconstrução só pelo histórico e cadeia de hashes', async () => {
      const l = await seeded();
      await h(l, updateItem({ id: 'ib', before: { content: 'item editável' }, patch: { content: 'editado' } }));
      expect(stateHash(reconstruct(l.log))).toBe(stateHash(l.state));
      expect(verifyChain(l.log).ok).toBe(true);
    });

    it('desfazer é um change compensatório e o histórico fica intacto', async () => {
      const l = await seeded();
      const before = JSON.stringify(l.log);
      expect((await l.undo(3, 'u1' as UserId)).ok).toBe(true);
      expect(l.log).toHaveLength(4);
      expect(JSON.stringify(l.log.slice(0, 3))).toBe(before);
      expect(l.state.relations.get('r1' as never)?.retired).toBe(true);
      expect(verifyChain(l.log).ok).toBe(true);
    });

    it('change produzido sobre versão antiga é detectado como desatualizado', async () => {
      const l = await seeded();
      const x = await propose(l, [updateItem({ id: 'ib', before: { content: 'item editável' }, patch: { content: 'via X' } })]);
      const y = await propose(l, [retire({ item: 'ib' })], 'run2');
      expect(codeOf(await l.review({ changeId: x, decision: 'accept', reviewer: U }))).toBe('ok');
      expect(l.statusOf(y)).toBe('stale');
      expect(codeOf(await l.review({ changeId: y, decision: 'accept', reviewer: U }))).toBe('stale');
    });
  });
}

// ---- Regras específicas do schema de research (incluem as correções aprovadas) ----

describe('research@1: regras de base, promoção e decisão', () => {
  const schema = (): ProjectSchema => assertProjectSchema(researchV1);

  async function withAssumptionBase() {
    const l = ledgerFor(researchV1);
    await h(l, createItem({ id: 'a1', type: 'assumption', status: 'adopted', content: 'premissa do usuário' }));
    await h(l, createItem({ id: 'd1', type: 'decision', status: 'adopted', content: 'decisão do usuário' }));
    await h(l, createItem({ id: 'c0', type: 'claim', status: 'active', content: 'afirmação do usuário' }));
    return l;
  }

  it('agente não cria premissa adotada nem fonte/nota', async () => {
    const l = await withAssumptionBase();
    const bad = await l.propose(draftOf(l, { origin: agent(), ops: [
      createItem({ id: 'x1', type: 'assumption', status: 'adopted', content: 'x', evidence: [E(l)] }),
    ] }));
    expect(codeOf(bad)).toBe('invalid');
    const src = await l.propose(draftOf(l, { origin: agent(), ops: [
      createItem({ id: 'x2', type: 'source', status: 'active', contentHash: l.contents.add('doc'), attributes: { label: 'l' } }),
    ] }));
    expect(codeOf(src)).toBe('invalid');
  });

  it('affects só por justificativa: válido, justification_only, nunca em lote; com evidência: evidence', async () => {
    const l = await withAssumptionBase();
    const only = await l.propose(draftOf(l, { origin: agent(), ops: [
      createRelation({ id: 'x1', type: 'affects', from: 'a1', to: 'd1', justification: just('a premissa sustenta a decisão adotada', 'a1', 'd1') }),
    ] }));
    const idOnly = pend(only);
    expect(l.changes.get(idOnly)!.basisKind).toBe('justification_only');
    expect(l.changes.get(idOnly)!.impact).toBe('high');
    expect(codeOf(await l.review({ changeId: idOnly, decision: 'accept', reviewer: U, batch: true }))).toBe('decision_not_allowed');
    const idEv = pend(await l.propose(draftOf(l, { origin: agent('run2'), ops: [
      createRelation({ id: 'x2', type: 'affects', from: 'c0', to: 'd1', evidence: [E(l)] }),
    ] })));
    expect(l.changes.get(idEv)!.basisKind).toBe('evidence');
    // mesmo com evidência, impacto alto nunca é elegível a lote
    expect(codeOf(await l.review({ changeId: idEv, decision: 'accept', reviewer: U, batch: true }))).toBe('decision_not_allowed');
    expect(codeOf(await l.review({ changeId: idEv, decision: 'accept', reviewer: U }))).toBe('ok');
  });

  it('agente cria premissa só por justificativa: provisional, justification_only', async () => {
    const l = await withAssumptionBase();
    const id = await propose(l, [createItem({
      id: 'x3', type: 'assumption', status: 'provisional', content: 'inferência',
      justification: just('inferido a partir da afirmação do usuário', 'c0'),
    })]);
    expect(l.changes.get(id)!.basisKind).toBe('justification_only');
    expect(codeOf(await l.review({ changeId: id, decision: 'accept_provisional', reviewer: U }))).toBe('ok');
    expect(l.state.items.get(iid('x3'))?.status).toBe('provisional');
    expect(l.log.at(-1)!.decision).toBe('accept_provisional');
  });

  it('a regra de promoção vale para HUMANO: sem evidência ancorada exige justificativa', async () => {
    const l = await withAssumptionBase();
    const id = await propose(l, [createItem({
      id: 'x3', type: 'assumption', status: 'provisional', content: 'inferência',
      justification: just('inferido a partir da afirmação do usuário', 'c0'),
    })]);
    await l.review({ changeId: id, decision: 'accept_provisional', reviewer: U });
    const bare = await h(l, updateItem({ id: 'x3', before: { status: 'provisional' }, patch: { status: 'adopted' } }));
    expect(codeOf(bare)).toBe('invalid');
    const ok = await h(l, updateItem({
      id: 'x3', before: { status: 'provisional' }, patch: { status: 'adopted' },
      justification: just('confirmado por mim na revisão'),
    }));
    expect(codeOf(ok)).toBe('ok');
    expect(l.log.at(-1)!.appliedBasisKind).toBe('justification_only');
  });

  it('claim de agente nasce com evidência ancorada; o humano promove sem exigência extra', async () => {
    const l = await withAssumptionBase();
    const id = await propose(l, [createItem({ id: 'x4', type: 'claim', status: 'provisional', content: 'achado', evidence: [E(l)] })]);
    await l.review({ changeId: id, decision: 'accept_provisional', reviewer: U });
    const o = await h(l, updateItem({ id: 'x4', before: { status: 'provisional' }, patch: { status: 'active' } }));
    expect(codeOf(o)).toBe('ok');
    expect(l.log.at(-1)!.appliedBasisKind).toBe('evidence');
  });

  it('inicialização: pergunta (sem provisionalStatus) entra por accept_provisional; claim ativa e challenges não', async () => {
    const l = await withAssumptionBase();
    const q = await propose(l, [
      createItem({ id: 'q1', type: 'question', status: 'open', content: 'o que falta?', evidence: [E(l)] }),
      createRelation({ id: 'rq', type: 'raises', from: 'c0', to: 'q1', evidence: [E(l)] }),
    ]);
    expect(codeOf(await l.review({ changeId: q, decision: 'accept_provisional', reviewer: U }))).toBe('ok');

    const active = await propose(l, [createItem({ id: 'x5', type: 'claim', status: 'active', content: 'ativa', evidence: [E(l)] })], 'run2');
    expect(codeOf(await l.review({ changeId: active, decision: 'accept_provisional', reviewer: U }))).toBe('decision_not_allowed');

    const ch = await propose(l, [
      createItem({ id: 'x6', type: 'claim', status: 'provisional', content: 'contra', evidence: [E(l)] }),
      createRelation({ id: 'rc', type: 'challenges', from: 'x6', to: 'a1', attributes: { contradicts: 'afirma o oposto' }, evidence: [E(l)] }),
    ], 'run3');
    expect(codeOf(await l.review({ changeId: ch, decision: 'accept_provisional', reviewer: U }))).toBe('decision_not_allowed');
    expect(codeOf(await l.review({ changeId: ch, decision: 'accept', reviewer: U }))).toBe('ok');
  });

  it('challenges exige o atributo contradicts', async () => {
    const l = await withAssumptionBase();
    const o = await l.propose(draftOf(l, { origin: agent(), ops: [
      createItem({ id: 'x6', type: 'claim', status: 'provisional', content: 'contra', evidence: [E(l)] }),
      createRelation({ id: 'rc', type: 'challenges', from: 'x6', to: 'a1', evidence: [E(l)] }),
    ] }));
    expect(codeOf(o)).toBe('invalid');
  });

  it('lote só para impacto baixo, agente, com evidência (derived_from/raises)', async () => {
    const l = await withAssumptionBase();
    const hash = l.contents.add(TEXT);
    await h(l, createItem({ id: 's1', type: 'source', status: 'active', contentHash: hash, attributes: { label: 'fonte' } }));
    const id = await propose(l, [createRelation({ id: 'rd', type: 'derived_from', from: 'c0', to: 's1', evidence: [E(l)] })]);
    const a = analyzeChange(schema(), l.state, l.changes.get(id)!);
    expect(a.impact).toBe('low');
    expect(isBatchEligible(schema(), l.changes.get(id)!, a)).toBe(true);
    expect(codeOf(await l.review({ changeId: id, decision: 'accept', reviewer: U, batch: true }))).toBe('ok');
  });
});
