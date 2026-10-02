import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  reconstruct, staleReasons, stateHash, verifyChain, type UserId,
} from '../src';
import {
  agent, createItem, createRelation, draftOf, evidenceFor, iid, just, retire, updateItem,
} from '../src/testing';
import { TEXT, h, newLedger } from './fixtures';

type Cmd = { k: string; a: number; b: number; t: string };
const cmdArb = fc.record({
  k: fc.constantFrom('mkAlpha', 'mkDoc', 'edit', 'relate', 'retire', 'undo', 'agentAlpha', 'promote'),
  a: fc.nat(30),
  b: fc.nat(30),
  t: fc.constantFrom('x', 'y', 'z'),
});
const REVIEWER = { kind: 'human', id: 'u1' as UserId } as const;

/** Interpreta uma sequência de comandos contra o livro-razão; comandos inválidos são ignorados. */
async function run(cmds: Cmd[]) {
  const l = newLedger();
  const alphas: string[] = [];
  const rels: string[] = [];
  let n = 0;
  const nid = (p: string) => `${p}${++n}`;
  const pick = (xs: string[], i: number) => xs[i % xs.length]!;

  for (const c of cmds) {
    switch (c.k) {
      case 'mkAlpha': {
        const id = nid('a');
        const o = await h(l, createItem({ id, type: 'alpha', status: 'final', content: `texto ${c.t}${n}` }));
        if (o.ok) alphas.push(id);
        break;
      }
      case 'mkDoc': {
        const id = nid('d');
        await h(l, createItem({
          id, type: 'doc', status: 'live', contentHash: l.contents.add(`corpo ${c.t} ${n}`), attributes: { label: c.t },
        }));
        break;
      }
      case 'edit': {
        if (alphas.length === 0) break;
        const id = pick(alphas, c.a);
        const it = l.state.items.get(iid(id));
        if (!it || it.retired || it.content === undefined) break;
        await h(l, updateItem({ id, before: { content: it.content }, patch: { content: it.content + '!' } }));
        break;
      }
      case 'relate': {
        if (alphas.length < 2) break;
        const id = nid('r');
        const o = await h(l, createRelation({ id, type: 'backs', from: pick(alphas, c.a), to: pick(alphas, c.b) }));
        if (o.ok) rels.push(id);
        break;
      }
      case 'retire': {
        if (c.a % 2 === 0 && alphas.length > 0) {
          const id = pick(alphas, c.b);
          const it = l.state.items.get(iid(id));
          if (it) await h(l, retire({ item: id, retired: !it.retired }));
        } else if (rels.length > 0) {
          const id = pick(rels, c.b);
          const r = l.state.relations.get(id as never);
          if (r) await h(l, retire({ relation: id, retired: !r.retired }));
        }
        break;
      }
      case 'undo': {
        if (l.head === 0) break;
        await l.undo(1 + (c.a % l.head), 'u1' as UserId);
        break;
      }
      case 'agentAlpha': {
        const id = nid('a');
        const e = evidenceFor(l.contents, TEXT, 'ferve a 100 °C');
        const p = await l.propose(draftOf(l, {
          origin: agent(`run${n}`),
          ops: [createItem({ id, type: 'alpha', status: 'draft', content: `ag ${c.t}${n}`, evidence: [e] })],
        }));
        if (p.ok && !p.applied && p.change) {
          const mode = c.b % 3;
          if (mode === 0) {
            const r = await l.review({ changeId: p.change.id, decision: 'accept', reviewer: REVIEWER });
            if (r.ok) alphas.push(id);
          } else if (mode === 1) {
            await l.review({ changeId: p.change.id, decision: 'defer', reviewer: REVIEWER });
          } else {
            await l.review({ changeId: p.change.id, decision: 'reject', reviewer: REVIEWER });
          }
        }
        break;
      }
      case 'promote': {
        const drafts = alphas.filter((id) => l.state.items.get(iid(id))?.status === 'draft');
        if (drafts.length === 0) break;
        const id = pick(drafts, c.a);
        await h(l, updateItem({
          id, before: { status: 'draft' }, patch: { status: 'final' },
          justification: just('promovido manualmente após conferir'),
        }));
        break;
      }
    }
  }
  return l;
}

describe('invariantes por propriedade (sequências aleatórias de comandos)', () => {
  it('estado incremental == reconstrução do log; cadeia válida; versões sem lacunas; stale coerente', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb, { maxLength: 40 }), async (cmds: Cmd[]) => {
        const l = await run(cmds);
        expect(stateHash(reconstruct(l.log))).toBe(stateHash(l.state));
        expect(verifyChain(l.log).ok).toBe(true);
        l.log.forEach((e, i) => expect(e.version).toBe(i + 1));
        for (const [id, change] of l.changes) {
          const status = l.statusOf(id);
          const stale = staleReasons(change, l.state).length > 0;
          if (status === 'proposed' || status === 'deferred') expect(stale).toBe(false);
          if (status === 'stale') expect(stale).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('determinismo: reproduzir os mesmos comandos dá o mesmo estado e o mesmo log', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb, { maxLength: 30 }), async (cmds: Cmd[]) => {
        const a = await run(cmds);
        const b = await run(cmds);
        expect(stateHash(a.state)).toBe(stateHash(b.state));
        expect(a.log.at(-1)?.entryHash).toBe(b.log.at(-1)?.entryHash);
      }),
      { numRuns: 40 },
    );
  });

  it('adulterar qualquer entrada do log é detectado pela cadeia de hashes', async () => {
    const l = await run([
      { k: 'mkAlpha', a: 0, b: 0, t: 'x' }, { k: 'mkAlpha', a: 0, b: 0, t: 'y' },
      { k: 'edit', a: 0, b: 0, t: 'x' }, { k: 'relate', a: 0, b: 1, t: 'x' },
    ]);
    expect(l.log.length).toBeGreaterThan(2);
    const tampered = l.log.map((e, i) => (i === 1 ? { ...e, appliedAt: 'adulterado' } : e));
    const r = verifyChain(tampered);
    expect(r.ok).toBe(false);
    expect(() => reconstruct(tampered)).toThrow();
  });
});
