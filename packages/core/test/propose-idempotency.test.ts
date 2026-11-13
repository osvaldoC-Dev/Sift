import { describe, expect, it } from 'vitest';
import type { UserId } from '../src';
import { agent, createItem, draftOf } from '../src/testing';
import { ev, newLedger } from './fixtures';

const U = { kind: 'human', id: 'u1' as UserId } as const;
const mk = (l: ReturnType<typeof newLedger>, key: string | undefined, id = 'a2') =>
  draftOf(l, {
    origin: agent('run1'), idempotencyKey: key,
    ops: [createItem({ id, type: 'alpha', status: 'draft', content: 'ferve', evidence: [ev(l, 'ferve a 100 °C')] })],
  });

describe('idempotência da proposta de agente (`runId:sourceId:ref`)', () => {
  it('repetir a MESMA chave devolve a proposta já criada e não cria outra', async () => {
    const l = newLedger();
    const first = await l.propose(mk(l, 'run1:s1:c0.0'));
    const again = await l.propose(mk(l, 'run1:s1:c0.0')); // outro id de mudança, mesma chave
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok || first.applied || again.applied) throw new Error();
    expect(again.change!.id).toBe(first.change!.id);
    expect(l.changes.size).toBe(1);
  });

  it('chaves diferentes criam propostas diferentes; sem chave nunca deduplica', async () => {
    const l = newLedger();
    await l.propose(mk(l, 'run1:s1:c0.0', 'a2'));
    await l.propose(mk(l, 'run1:s1:c0.1', 'a3'));
    await l.propose(mk(l, undefined, 'a4'));
    await l.propose(mk(l, undefined, 'a5'));
    expect(l.changes.size).toBe(4);
  });

  it('o estado devolvido na repetição é o ATUAL (depois de aceita, não "proposed")', async () => {
    const l = newLedger();
    const first = await l.propose(mk(l, 'k'));
    if (!first.ok || first.applied) throw new Error();
    await l.review({ changeId: first.change!.id, decision: 'accept', reviewer: U });
    const again = await l.propose(mk(l, 'k'));
    expect(again.ok && !again.applied && again.status).toBe('accepted');
    expect(l.log).toHaveLength(1); // aceitar de novo não acontece
  });

  it('proposta recusada não consome a chave: depois de corrigida, a mesma chave cria a proposta', async () => {
    const l = newLedger();
    const bad = await l.propose(draftOf(l, { origin: agent('run1'), idempotencyKey: 'k2', ops: [createItem({ id: 'a2', type: 'alpha', status: 'draft', content: 'x' })] }));
    expect(bad.ok).toBe(false);
    const good = await l.propose(mk(l, 'k2'));
    expect(good.ok).toBe(true);
    expect(l.changes.size).toBe(1);
  });

  it('a chave de proposta de agente não colide com a de mudança humana', async () => {
    const l = newLedger();
    const p = await l.propose(mk(l, 'mesma'));
    expect(p.ok && !p.applied).toBe(true);
    const human = await l.submitHuman(draftOf(l, {
      origin: { kind: 'human', actorId: 'u1' as UserId }, idempotencyKey: 'mesma',
      ops: [createItem({ id: 'h1', type: 'alpha', status: 'final', content: 'humano' })],
    }));
    expect(human.ok && human.applied).toBe(true); // não devolveu a proposta do agente
    expect(l.log).toHaveLength(1);
  });
});
