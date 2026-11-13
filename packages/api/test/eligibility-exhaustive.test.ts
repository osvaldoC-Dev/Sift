import {
  analyzeChange, assertProjectSchema, checkDecision, emptyState, isBatchEligible, prepareChange,
  type Change, type ChangeStatus, type SupportVerdict, type UserId,
} from '@sift/core';
import { InMemoryContents, agent, createItem, evidenceFor } from '@sift/core/testing';
import { researchV1 } from '@sift/schemas';
import { describe, expect, it } from 'vitest';
import { eligibility } from '../src';

const schema = assertProjectSchema(researchV1);
const TEXT = 'Alpha is true here.';
const STATUSES: ChangeStatus[] = ['proposed', 'deferred', 'stale', 'accepted', 'accepted_edited', 'rejected'];
const PENDING = new Set<ChangeStatus>(['proposed', 'deferred', 'stale']);

function build(type: 'claim' | 'question' | 'decision', verdict: SupportVerdict | undefined): Change {
  const contents = new InMemoryContents();
  const ev = verdict === undefined ? evidenceFor(contents, TEXT, TEXT, undefined) : evidenceFor(contents, TEXT, TEXT, verdict);
  const draft = {
    id: 'c1' as never, projectId: 'p1' as never, baseVersion: 0, schemaRef: { key: schema.key, version: schema.version },
    origin: agent('run1'), rationale: 'x', createdAt: '2026-11-07T12:00:00.000Z',
    operations: [createItem({ id: 'i1', type, status: type === 'question' ? 'open' : 'provisional', content: 't', evidence: [ev] })],
  };
  return prepareChange(schema, emptyState(), draft).change;
}

describe('equivalência com o núcleo: tipo × suporte × citação × estado × stale (nunca lança)', () => {
  const types = ['claim', 'question', 'decision'] as const;
  const verdicts: (SupportVerdict | undefined)[] = ['full', 'partial', 'unchecked', 'none', undefined];
  const founds = [0, 1, 2];
  let n = 0;
  it('todas as combinações: sem exceção e disponibilidade igual à do núcleo', () => {
    for (const type of types) for (const v of verdicts) for (const found of founds) for (const status of STATUSES) {
      const change = build(type, v);
      const support: SupportVerdict = v ?? 'unchecked';
      const r = eligibility({ schema, state: emptyState(), change, status, found, support });
      n++;
      const label = `${type}/${v}/${found}/${status}`;
      if (!PENDING.has(status)) {
        expect(r, label).toEqual({
          canAccept: { ok: false, code: 'already_decided' }, canReject: { ok: false, code: 'already_decided' },
          canBatchAccept: { ok: false, code: 'already_decided' },
        });
        continue;
      }
      expect(r.canReject, label).toEqual({ ok: true });
      const gated = found === 0 || support === 'none' || status === 'stale';
      const analysis = analyzeChange(schema, emptyState(), change);
      const probe = { reviewer: { kind: 'human', id: 'p' as UserId } as const, change, analysis, effectiveOperations: change.operations, state: emptyState() };
      const coreAccept = checkDecision(schema, { ...probe, decision: 'accept' }).length === 0;
      expect(r.canAccept.ok, label).toBe(!gated && coreAccept);
      const coreBatch = isBatchEligible(schema, change, analysis);
      expect(r.canBatchAccept.ok, label).toBe(!gated && coreBatch && found <= 1);
      if (!r.canBatchAccept.ok) expect(r.canBatchAccept.code).toBeTruthy();
    }
    expect(n).toBe(3 * 5 * 3 * 6);
  });

  it('o núcleo recusando por motivo sem tradução vira core_refused, sem lançar', () => {
    const change = build('question', 'full');
    const broken = { ...schema, review: undefined } as never; // schema corrompido: o núcleo lança lá dentro
    const r = eligibility({ schema: broken, state: emptyState(), change, status: 'proposed', found: 1, support: 'full' });
    expect(r.canAccept).toEqual({ ok: false, code: 'core_refused' });
    expect(r.canBatchAccept).toEqual({ ok: false, code: 'core_refused' });
    expect(r.canReject).toEqual({ ok: true });
  });
});
