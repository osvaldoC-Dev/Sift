import { contentHash, normalizeText } from '@sift/core';
import { agent, createItem, evidenceFor, InMemoryContents } from '@sift/core/testing';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src';
import { makeStore } from './store-factory';

/**
 * Suíte de CONFORMIDADE de `Store`: só usa a interface, nunca a implementação. O Postgres do 1b tem de passar nela
 * sem alteração (a única linha que muda é `makeStore`, em store-factory.ts).
 */
const setup = () => {
  let n = 0;
  let t = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 10, 7, 12, 0, ++t)).toISOString() };
  const store = makeStore({ projects: ['p1', 'p2'], clock, ids: { next: () => `id${++n}` } });
  return store;
};

describe('Store: conformidade da interface', () => {
  it('projeto desconhecido -> undefined; projetos são isolados', async () => {
    const s = setup();
    expect(await s.project('nao-existe')).toBeUndefined();
    const a = (await s.project('p1'))!;
    const b = (await s.project('p2'))!;
    const h = await a.putContent('só no projeto um');
    expect(await a.getContent(h)).toBe('só no projeto um');
    expect(await b.getContent(h)).toBeUndefined();
    await a.saveSource({ id: 's1', name: 'x', contentHash: h, originType: 'human', createdAt: 't' });
    expect(await b.getSource('s1')).toBeUndefined();
  });

  it('conteúdo: normaliza (NFC) e devolve o hash do núcleo; é idempotente', async () => {
    const ps = (await setup().project('p1'))!;
    const raw = 'Café';
    const h1 = await ps.putContent(raw);
    expect(h1).toBe(contentHash(normalizeText(raw)));
    expect(await ps.getContent(h1)).toBe(normalizeText(raw));
    expect(await ps.putContent(raw)).toBe(h1);
    expect(await ps.getContent('0'.repeat(64))).toBeUndefined();
  });

  it('fontes: ida e volta por id e por hash; devolve cópias (mudar o retorno não muda o armazém)', async () => {
    const ps = (await setup().project('p1'))!;
    const h = await ps.putContent('texto');
    await ps.saveSource({ id: 's1', name: 'ata', contentHash: h, originType: 'human', originLabel: 'L', capturedAt: '2020-01-01T00:00:00Z', createdAt: 't' });
    const got = (await ps.getSource('s1'))!;
    expect(got).toMatchObject({ name: 'ata', originLabel: 'L', capturedAt: '2020-01-01T00:00:00Z' });
    got.name = 'mudado';
    expect((await ps.getSource('s1'))!.name).toBe('ata');
    expect((await ps.sourceByHash(h))!.id).toBe('s1');
    expect(await ps.sourceByHash('f'.repeat(64))).toBeUndefined();
  });

  it('auditoria: seq contíguo, cadeia verificável, coreVersion guardado e ordem preservada', async () => {
    const ps = (await setup().project('p1'))!;
    await ps.appendAudit({ action: 'capture_source', targetId: 'a', coreVersion: 1 });
    await ps.appendAudit({ action: 'propose', targetId: 'b' });
    await ps.appendAudit({ action: 'reject', targetId: 'b' });
    const trail = await ps.audit();
    expect(trail.map((e) => [e.seq, e.action])).toEqual([[1, 'capture_source'], [2, 'propose'], [3, 'reject']]);
    expect(trail[0]!.coreVersion).toBe(1);
    expect(trail[1]!.coreVersion).toBeUndefined();
    expect(verifyAuditChain(trail)).toEqual({ ok: true });
  });

  it('livro-razão: proposta de agente fica pendente; aceitar por humano aplica e encadeia; cópias do estado não vazam', async () => {
    const ps = (await setup().project('p1'))!;
    const contents = new InMemoryContents();
    const text = 'Is Gamma ready?';
    const hash = await ps.putContent(text);
    expect(hash).toBe(contents.add(text));
    const ev = evidenceFor(contents, text, text);
    const draft = {
      id: 'c1' as never, projectId: ps.projectId, baseVersion: 0, schemaRef: { key: ps.schema.key, version: ps.schema.version },
      origin: agent('run1'), rationale: 'extração', createdAt: '2026-11-07T12:00:00.000Z',
      operations: [createItem({ id: 'i1', type: 'question', status: 'open', content: 'Gamma está pronto?', evidence: [ev] })],
    };
    const out = await ps.proposeChange(draft);
    expect(out.ok).toBe(true);
    expect(await ps.statusOf('c1' as never)).toBe('proposed');
    expect((await ps.changes()).map((c) => c.id)).toEqual(['c1']);
    const r = await ps.review({ changeId: 'c1' as never, decision: 'accept', reviewer: { kind: 'human', id: 'u1' as never } });
    expect(r.ok && r.applied).toBe(true);
    expect(await ps.statusOf('c1' as never)).toBe('accepted');
    expect((await ps.entries()).map((e) => e.version)).toEqual([1]);
    expect((await ps.reviewEvents('c1' as never)).map((e) => e.decision)).toContain('accept');
    expect((await ps.state()).version).toBe(1);
    // revisão de agente é recusada (só humano decide)
    const again = await ps.review({ changeId: 'c1' as never, decision: 'accept', reviewer: { kind: 'system' } });
    expect(again.ok).toBe(false);
  });
});
