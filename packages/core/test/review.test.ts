import { describe, expect, it } from 'vitest';
import { deriveStatus, nextStatus, type ChangeId, type ChangeStatus, type Decision, type ReviewEvent } from '../src';

const ev = (decision: ReviewEvent['decision']): ReviewEvent => ({
  id: 'e', changeId: 'c' as ChangeId, decision, reviewer: { kind: 'system' }, at: 't',
});

describe('máquina de estados da proposta', () => {
  it('deriva o status a partir dos eventos', () => {
    expect(deriveStatus([])).toBe('proposed');
    expect(deriveStatus([ev('defer')])).toBe('deferred');
    expect(deriveStatus([ev('defer'), ev('accept')])).toBe('accepted');
    expect(deriveStatus([ev('accept_provisional')])).toBe('accepted_provisional');
    expect(deriveStatus([ev('accept_edited')])).toBe('accepted_edited');
    expect(deriveStatus([ev('stale'), ev('reject')])).toBe('rejected');
    expect(deriveStatus([ev('stale'), ev('stale')])).toBe('stale');
  });
  it('transições inválidas', () => {
    const terminals: ChangeStatus[] = ['accepted', 'accepted_provisional', 'accepted_edited', 'rejected'];
    const all: Array<Decision | 'stale'> = ['accept', 'accept_provisional', 'accept_edited', 'reject', 'defer', 'stale'];
    for (const t of terminals) for (const d of all) expect(nextStatus(t, d)).toBeUndefined();
    for (const d of ['accept', 'accept_provisional', 'accept_edited', 'defer'] as const) {
      expect(nextStatus('stale', d)).toBeUndefined();
    }
    expect(() => deriveStatus([ev('reject'), ev('accept')])).toThrow();
  });
});
