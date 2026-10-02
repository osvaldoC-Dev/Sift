import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { staleReasons, verifyChain, type ChangeId, type State, type UserId } from '../src';
import {
  agent, createItem, createRelation, draftOf, iid, retire, updateItem,
  type InMemoryLedger, type Outcome,
} from '../src/testing';
import { ev, h, newLedger } from './fixtures';

const U = { kind: 'human', id: 'u1' as UserId } as const;
const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);
const codeOf = (o: Outcome) => (o.ok ? 'ok' : o.code);
const N_ITEMS = 4;

/** Projeção do estado sem versões nem metadados: o que "desfazer" deve restaurar. */
function norm(s: State) {
  const items = [...s.items.values()]
    .map((i) => ({ id: i.id, type: i.type, status: i.status, content: i.content, retired: i.retired }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const relations = [...s.relations.values()]
    .map((r) => ({ id: r.id, type: r.type, from: r.from, to: r.to, retired: r.retired }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { items, relations };
}

async function seed(): Promise<InMemoryLedger> {
  const l = newLedger();
  for (let i = 0; i < N_ITEMS; i++) {
    await h(l, createItem({ id: `a${i}`, type: 'alpha', status: 'final', content: `c${i}` }));
  }
  return l;
}

/** Propõe como agente uma edição do conteúdo do item (a proposta fica pendente). */
async function proposeEdit(l: InMemoryLedger, idx: number, tag: string): Promise<ChangeId | undefined> {
  const id = `a${idx % N_ITEMS}`;
  const it = l.state.items.get(iid(id));
  if (!it || it.retired || it.content === undefined) return undefined;
  const o = await l.propose(draftOf(l, {
    origin: agent(`run-${tag}`),
    ops: [updateItem({ id, before: { content: it.content }, patch: { content: `${it.content}+${tag}` } })],
  }));
  return o.ok && !o.applied && o.change ? o.change.id : undefined;
}

const stepArb = fc.record({
  k: fc.constantFrom('propose', 'propose', 'accept', 'humanEdit', 'humanRetire', 'reject', 'defer'),
  a: fc.nat(20),
  b: fc.nat(20),
});

describe('propriedade: stale (com sequências que realmente produzem stale)', () => {
  it('pendente nunca é stale pelo predicado; stale nunca se aplica e pode ser dispensado; aceitar não altera o log quando recusa', async () => {
    let staleSeen = 0;
    let acceptedSeen = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 4, maxLength: 30 }), async (steps) => {
        const l = await seed();
        const pending: ChangeId[] = [];
        let n = 0;
        for (const s of steps) {
          const live = pending.filter((id) => ['proposed', 'deferred'].includes(l.statusOf(id)));
          if (s.k === 'propose') {
            const id = await proposeEdit(l, s.a, String(++n));
            if (id) pending.push(id);
          } else if (s.k === 'accept' && live.length > 0) {
            const o = await l.review({ changeId: live[s.a % live.length]!, decision: 'accept', reviewer: U });
            if (o.ok) acceptedSeen++;
          } else if (s.k === 'reject' && live.length > 0) {
            await l.review({ changeId: live[s.a % live.length]!, decision: 'reject', reviewer: U });
          } else if (s.k === 'defer' && live.length > 0) {
            await l.review({ changeId: live[s.a % live.length]!, decision: 'defer', reviewer: U });
          } else if (s.k === 'humanEdit') {
            const id = `a${s.a % N_ITEMS}`;
            const it = l.state.items.get(iid(id));
            if (it && !it.retired && it.content !== undefined) {
              await h(l, updateItem({ id, before: { content: it.content }, patch: { content: `${it.content}#h${++n}` } }));
            }
          } else if (s.k === 'humanRetire') {
            const id = `a${s.a % N_ITEMS}`;
            const it = l.state.items.get(iid(id));
            if (it) await h(l, retire({ item: id, retired: !it.retired }));
          }
        }
        for (const id of pending) {
          const status = l.statusOf(id);
          const change = l.changes.get(id)!;
          // oráculo independente: alguma entrada do log posterior à base tocou o mesmo item?
          const target = (change.operations[0] as { itemId: string }).itemId;
          const expectedStale = l.log.some(
            (e) => e.version > change.baseVersion &&
              e.appliedOperations.some((op) => ('itemId' in op && op.itemId === target) ||
                ('target' in op && op.target.id === target)),
          );
          if (status === 'proposed' || status === 'deferred' || status === 'stale') {
            expect(status === 'stale').toBe(expectedStale);
          }
          const stale = staleReasons(change, l.state).length > 0;
          if (status === 'proposed' || status === 'deferred') expect(stale).toBe(false);
          if (status === 'stale') {
            staleSeen++;
            expect(stale).toBe(true);
            const logBefore = l.log.length;
            const o = await l.review({ changeId: id, decision: 'accept', reviewer: U });
            expect(codeOf(o)).toBe('stale');
            expect(l.log.length).toBe(logBefore);
            expect((await l.review({ changeId: id, decision: 'reject', reviewer: U })).ok).toBe(true);
            expect(l.statusOf(id)).toBe('rejected');
          }
        }
        expect(verifyChain(l.log).ok).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
    // guarda contra propriedade vazia: os dois caminhos precisam ter sido exercitados
    expect(staleSeen).toBeGreaterThan(0);
    expect(acceptedSeen).toBeGreaterThan(0);
  });
});

describe('propriedade: desfazer restaura o estado', () => {
  const editArb = fc.record({ k: fc.constantFrom('edit', 'retire'), a: fc.nat(20) });

  async function apply(l: InMemoryLedger, s: { k: string; a: number }, n: number) {
    const id = `a${s.a % N_ITEMS}`;
    const it = l.state.items.get(iid(id))!;
    if (s.k === 'edit' && !it.retired && it.content !== undefined) {
      await h(l, updateItem({ id, before: { content: it.content }, patch: { content: `${it.content}.${n}` } }));
    } else if (s.k === 'retire') {
      await h(l, retire({ item: id, retired: !it.retired }));
    }
  }

  it('desfazer o último change devolve exatamente o estado anterior; desfazer o desfazer volta ao posterior', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(editArb, { minLength: 1, maxLength: 20 }), async (steps) => {
        const l = await seed();
        let n = 0;
        for (const s of steps.slice(0, -1)) await apply(l, s, ++n);
        const before = norm(l.state);
        const headBefore = l.head;
        await apply(l, steps[steps.length - 1]!, ++n);
        if (l.head === headBefore) return; // último passo inválido: nada a desfazer
        const after = norm(l.state);
        const u1 = await l.undo(l.head, 'u1' as UserId);
        expect(u1.ok).toBe(true);
        expect(norm(l.state)).toEqual(before);
        const u2 = await l.undo(l.head, 'u1' as UserId);
        expect(u2.ok).toBe(true);
        expect(norm(l.state)).toEqual(after);
        expect(verifyChain(l.log).ok).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('decisões: casos que faltavam', () => {
  const E = (l: InMemoryLedger) => ev(l, 'ferve a 100 °C');

  it('unexpected_edited_operations: operações editadas só valem em accept_edited', async () => {
    const l = newLedger();
    const o0 = await l.propose(draftOf(l, { origin: agent(), ops: [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [E(l)] })] }));
    if (!o0.ok || o0.applied) throw new Error('proposta esperada');
    const o = await l.review({
      changeId: o0.change!.id, decision: 'accept', reviewer: U,
      editedOperations: [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'y', evidence: [E(l)] })],
    });
    expect(codeOf(o)).toBe('decision_not_allowed');
    if (!o.ok) expect(o.decisionIssues!.map((d) => d.code)).toContain('unexpected_edited_operations');
    expect(l.log).toHaveLength(0);
  });

  it('impacto alto nunca entra em lote, mesmo com evidência', async () => {
    const l = newLedger();
    await h(l, createItem({ id: 'b1', type: 'beta', status: 'final', content: 'premissa' }));
    const e = E(l);
    const o0 = await l.propose(draftOf(l, {
      origin: agent(),
      ops: [
        createItem({ id: 'a4', type: 'alpha', status: 'draft', content: 'y', evidence: [e] }),
        createRelation({ id: 'x4', type: 'opposes', from: 'a4', to: 'b1', attributes: { why: 'z' }, evidence: [e] }),
      ],
    }));
    if (!o0.ok || o0.applied) throw new Error('proposta esperada');
    expect(l.changes.get(o0.change!.id)!.impact).toBe('high');
    const o = await l.review({ changeId: o0.change!.id, decision: 'accept', reviewer: U, batch: true });
    expect(codeOf(o)).toBe('decision_not_allowed');
    if (!o.ok) expect(o.decisionIssues!.map((d) => d.code)).toContain('batch_not_eligible');
  });

  it('transição explícita aceita com accept_edited (individual, não em lote)', async () => {
    const l = newLedger();
    const p0 = await l.propose(draftOf(l, { origin: agent(), ops: [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [E(l)] })] }));
    if (!p0.ok || p0.applied) throw new Error('proposta esperada');
    await l.review({ changeId: p0.change!.id, decision: 'accept_provisional', reviewer: U });
    const promo = updateItem({ id: 'a1', before: { status: 'draft' }, patch: { status: 'final' } });
    const p1 = await l.propose(draftOf(l, { origin: agent('run2'), ops: [promo] }));
    if (!p1.ok || p1.applied) throw new Error('proposta esperada');
    const o = await l.review({ changeId: p1.change!.id, decision: 'accept_edited', reviewer: U, editedOperations: [promo] });
    expect(codeOf(o)).toBe('ok');
    expect(l.state.items.get(iid('a1'))?.status).toBe('final');
  });
});