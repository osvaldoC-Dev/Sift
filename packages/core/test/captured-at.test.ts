import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ChangeId } from '../src';
import { agent, createItem, draftOf, evidenceFor, human, updateItem, type InMemoryLedger, type Outcome } from '../src/testing';
import { TEXT, newLedger } from './fixtures';

/**
 * `capturedAt` é o que o USUÁRIO declara sobre quando o original foi escrito: dado não verificado. Ele entra
 * na operação (portanto no hash do log) e fica no estado como valor do próprio campo, mas NUNCA pode mudar
 * nenhum resultado DERIVADO: obsolescência, ordenação, análise (impacto, base, evidência fraca), validação,
 * status das propostas. (O estado em si muda: o valor do campo é parte dele.)
 */

const DATES = [
  '1999-12-31T23:59:59Z', '2026-01-01T00:00:00Z', '2026-10-13T22:40:00+01:00', '2030-06-15T12:00:00.5Z', '2100-01-01T00:00:00Z',
];

const outcomeView = (o: Outcome) =>
  o.ok
    ? o.applied
      ? { ok: true, applied: true, version: o.version }
      : { ok: true, applied: false, status: o.status, impact: o.change?.impact, basisKind: o.change?.basisKind }
    : { ok: false, code: o.code, issues: o.issues?.map((i) => i.code), reasons: o.reasons?.map((r) => r.kind) };

async function scenario(capturedAt: string | undefined) {
  const l: InMemoryLedger = newLedger();
  const view: unknown[] = [];
  const attrs: Record<string, string> = capturedAt === undefined ? { label: 'fonte' } : { label: 'fonte', capturedAt };
  view.push(outcomeView(await l.submitHuman(draftOf(l, {
    origin: human(), ops: [createItem({ id: 'd1', type: 'doc', status: 'live', contentHash: l.contents.add(TEXT), attributes: attrs })],
  }))));
  view.push(outcomeView(await l.submitHuman(draftOf(l, {
    origin: human(), ops: [createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'base' })],
  }))));
  const ev = (q: string, v?: 'full' | 'partial') => (v === undefined ? evidenceFor(l.contents, TEXT, q, undefined) : evidenceFor(l.contents, TEXT, q, v));
  // proposta que ficará obsoleta (toca a1) e proposta independente (cria a2, com evidência fraca)
  const pStale = await l.propose(draftOf(l, { origin: agent('r1'), ops: [updateItem({ id: 'a1', before: { content: 'base' }, patch: { content: 'novo' }, evidence: [ev('ferve a 100 °C', 'full')] })] }));
  const pFree = await l.propose(draftOf(l, { origin: agent('r2'), ops: [createItem({ id: 'a2', type: 'alpha', status: 'draft', content: 'x', evidence: [ev('ao nível do mar', 'partial')] })] }));
  view.push(outcomeView(pStale), outcomeView(pFree));
  view.push(outcomeView(await l.submitHuman(draftOf(l, {
    origin: human(), ops: [updateItem({ id: 'a1', before: { content: 'base' }, patch: { content: 'outro' } })],
  }))));
  const U = { kind: 'human', id: 'u1' } as never;
  view.push(outcomeView(await l.review({ changeId: (pStale as { change: { id: ChangeId } }).change.id, decision: 'accept', reviewer: U })));
  view.push(outcomeView(await l.review({ changeId: (pFree as { change: { id: ChangeId } }).change.id, decision: 'accept_provisional', reviewer: U })));
  view.push(outcomeView(await l.review({ changeId: (pFree as { change: { id: ChangeId } }).change.id, decision: 'accept', reviewer: U })));
  // projeção derivada: tudo menos o valor do próprio campo
  const items = [...l.state.items.values()].map((i) => ({
    id: i.id, type: i.type, status: i.status, lastVersion: i.lastVersion, content: i.content, retired: i.retired,
    attributes: i.id === 'd1' ? { ...i.attributes, capturedAt: capturedAt === undefined ? undefined : '<masked>' } : i.attributes,
  }));
  return {
    view, items,
    statuses: [...l.changes.keys()].map((id) => l.statusOf(id)),
    log: l.log.map((e) => ({ version: e.version, changeId: e.changeId, decision: e.decision })),
    head: l.head,
    entryHashes: l.log.map((e) => e.entryHash),
  };
}

describe('capturedAt: dado não verificado, nunca usado em lógica', () => {
  it('nenhum resultado derivado muda, qualquer que seja a data declarada (propriedade)', async () => {
    const base = await scenario('2026-01-01T00:00:00Z');
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...DATES), async (d: string) => {
        const other = await scenario(d);
        expect(other.view).toEqual(base.view);
        expect(other.items).toEqual(base.items);
        expect(other.statuses).toEqual(base.statuses);
        expect(other.log).toEqual(base.log);
        expect(other.head).toBe(base.head);
      }),
    );
  });

  it('o cenário é de verdade sensível: tem uma proposta obsoleta e uma aceita com evidência fraca', async () => {
    const s = await scenario('2026-01-01T00:00:00Z');
    const codes = s.view.map((v) => (v as { code?: string }).code);
    expect(codes).toContain('stale');
    expect(s.view.some((v) => (v as { applied?: boolean }).applied === true)).toBe(true);
  });

  it('o valor entra no hash do log (é dado da operação), e a ausência não deixa rastro', async () => {
    const a = await scenario('2026-01-01T00:00:00Z');
    const b = await scenario('2030-06-15T12:00:00.5Z');
    const none = await scenario(undefined);
    expect(a.entryHashes[0]).not.toBe(b.entryHashes[0]); // a data declarada muda o hash do evento que a cria
    expect(none.entryHashes[0]).not.toBe(a.entryHashes[0]);
    expect(JSON.stringify(none.items)).not.toContain('capturedAt'); // omitido quando ausente
  });
});
