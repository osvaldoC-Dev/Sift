import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  reconcileEditedOperations,
  type EvidenceRef, type Operation, type Origin, type SupportVerdict, type UserId,
} from '../src';
import {
  agent, createItem, draftOf, evidenceFor, human,
  type InMemoryLedger, type Outcome,
} from '../src/testing';
import { TEXT, newLedger } from './fixtures';

const U = { kind: 'human', id: 'u1' as UserId } as const;
const Q1 = 'ferve a 100 °C';
const Q2 = 'ao nível do mar';
type V = SupportVerdict | undefined;

const ev = (l: InMemoryLedger, quote: string, v: V): EvidenceRef => evidenceFor(l.contents, TEXT, quote, v);
const alpha = (id: string, content: string, evidence: EvidenceRef[]): Operation =>
  createItem({ id, type: 'alpha', status: 'draft', content, evidence });
const verdicts = (op: Operation): V[] => op.evidence.map((e) => e.supportVerdict);

async function pending(l: InMemoryLedger, ops: Operation[]) {
  const o = await l.propose(draftOf(l, { origin: agent('run1'), ops }));
  if (!o.ok || o.applied) throw new Error('proposta pendente esperada: ' + JSON.stringify(o));
  return o.change!.id;
}
async function editAndAccept(l: InMemoryLedger, original: Operation[], edited: Operation[]): Promise<Outcome> {
  const id = await pending(l, original);
  return l.review({ changeId: id, decision: 'accept_edited', reviewer: U, editedOperations: edited });
}
const appliedOps = (l: InMemoryLedger): readonly Operation[] => l.log[l.log.length - 1]!.appliedOperations;

describe('accept_edited: o veredito de suporte não sobrevive a uma edição de conteúdo', () => {
  it('edição que não muda nada mantém o veredito original', async () => {
    const l = newLedger();
    const orig = [alpha('a1', 'água ferve', [ev(l, Q1, 'full')])];
    const o = await editAndAccept(l, orig, [alpha('a1', 'água ferve', [ev(l, Q1, 'full')])]);
    expect(o.ok).toBe(true);
    expect(verdicts(appliedOps(l)[0]!)).toEqual(['full']);
  });

  it('editar o conteúdo da afirmação rebaixa a evidência para unchecked, no log e no item', async () => {
    const l = newLedger();
    const orig = [alpha('a1', 'água ferve', [ev(l, Q1, 'full')])];
    const o = await editAndAccept(l, orig, [alpha('a1', 'água ferve sempre', [ev(l, Q1, 'full')])]);
    expect(o.ok).toBe(true);
    expect(verdicts(appliedOps(l)[0]!)).toEqual(['unchecked']);
    const item = [...l.state.items.values()].find((i) => i.id === 'a1')!;
    expect(item.evidence.map((e) => e.supportVerdict)).toEqual(['unchecked']);
  });

  it('um veredito escrito à mão na operação editada é ignorado', async () => {
    const l = newLedger();
    const orig = [alpha('a1', 'água ferve', [ev(l, Q1, 'partial')])];
    await editAndAccept(l, orig, [alpha('a1', 'outra coisa', [ev(l, Q1, 'full')])]);
    expect(verdicts(appliedOps(l)[0]!)).toEqual(['unchecked']);

    const l2 = newLedger();
    const orig2 = [alpha('a1', 'água ferve', [ev(l2, Q1, 'partial')])];
    await editAndAccept(l2, orig2, [alpha('a1', 'água ferve', [ev(l2, Q1, 'full')])]);
    expect(verdicts(appliedOps(l2)[0]!)).toEqual(['partial']); // não foi promovido a full
  });

  it('evidência trocada ou acrescentada vira unchecked; a que já existia mantém o veredito', async () => {
    const l = newLedger();
    const orig = [alpha('a1', 'água ferve', [ev(l, Q1, 'full')])];
    await editAndAccept(l, orig, [alpha('a1', 'água ferve', [ev(l, Q1, 'full'), ev(l, Q2, 'full')])]);
    expect(verdicts(appliedOps(l)[0]!)).toEqual(['full', 'unchecked']);

    const l2 = newLedger();
    const orig2 = [alpha('a1', 'água ferve', [ev(l2, Q1, 'full')])];
    await editAndAccept(l2, orig2, [alpha('a1', 'água ferve', [ev(l2, Q2, 'full')])]);
    expect(verdicts(appliedOps(l2)[0]!)).toEqual(['unchecked']);
  });

  it('original sem veredito continua sem veredito quando nada muda (e fraco continua fraco)', async () => {
    const l = newLedger();
    const orig = [alpha('a1', 'água ferve', [ev(l, Q1, undefined)])];
    await editAndAccept(l, orig, [alpha('a1', 'água ferve', [ev(l, Q1, 'full')])]);
    expect(verdicts(appliedOps(l)[0]!)).toEqual([undefined]);
  });

  it('só a operação editada é rebaixada; as outras mantêm o veredito, mesmo reordenadas', async () => {
    const l = newLedger();
    const orig = [
      alpha('a1', 'primeira', [ev(l, Q1, 'full')]),
      alpha('a2', 'segunda', [ev(l, Q2, 'partial')]),
    ];
    await editAndAccept(l, orig, [
      alpha('a2', 'segunda', [ev(l, Q2, 'full')]),
      alpha('a1', 'primeira editada', [ev(l, Q1, 'full')]),
    ]);
    const byId = new Map(appliedOps(l).map((o) => [(o as { itemId: string }).itemId, verdicts(o)]));
    expect(byId.get('a2')).toEqual(['partial']);
    expect(byId.get('a1')).toEqual(['unchecked']);
  });
});

describe('reconcileEditedOperations (função pura)', () => {
  const l = newLedger();
  const base = [alpha('a1', 'x', [ev(l, Q1, 'full')])];

  it('não altera as entradas', () => {
    const edited = [alpha('a1', 'y', [ev(l, Q1, 'full')])];
    const b = JSON.stringify(base);
    const e = JSON.stringify(edited);
    reconcileEditedOperations(agent(), base, edited);
    expect(JSON.stringify(base)).toBe(b);
    expect(JSON.stringify(edited)).toBe(e);
  });

  it('origem humana devolve as operações editadas como estão', () => {
    const edited = [alpha('a1', 'y', [ev(l, Q1, undefined)])];
    const out = reconcileEditedOperations(human() as Origin, base, edited);
    expect(out).toEqual(edited);
  });

  it('propriedade: conteúdo igual herda o original; conteúdo diferente vira unchecked', () => {
    const vArb = fc.constantFrom<V>('full', 'partial', 'unchecked', undefined);
    fc.assert(
      fc.property(vArb, vArb, fc.boolean(), (orig, claimed, changed) => {
        const o = [alpha('a1', 'texto', [ev(l, Q1, orig)])];
        const e = [alpha('a1', changed ? 'texto novo' : 'texto', [ev(l, Q1, claimed)])];
        const out = reconcileEditedOperations(agent(), o, e);
        expect(verdicts(out[0]!)).toEqual(changed ? ['unchecked'] : [orig]);
      }),
      { numRuns: Number(process.env.FC_NUM_RUNS ?? 100) },
    );
  });
});
