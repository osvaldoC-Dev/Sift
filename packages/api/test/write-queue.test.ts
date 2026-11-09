import { verifyChain } from '@sift/core';
import { createItem, evidenceFor, human, InMemoryContents, updateItem } from '@sift/core/testing';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src';
import { capture, claim, claim2, ext, harness, PROJECT, proposalsOf, TEXT, ver } from './helpers';
import { withLatency } from './latency-store';

/**
 * CRITÉRIO OBRIGATÓRIO ANTES DO POSTGRES (1b): fila de escrita por projeto.
 *
 * Dois pedidos que escrevem no mesmo projeto ao mesmo tempo não podem perder atualização nem quebrar nenhuma
 * cadeia de hash. O teste corre contra a interface `Store` (via `makeStore`) com latência simulada ANTES e DEPOIS de
 * cada chamada, para abrir janelas entre "ler a versão" e "escrever". Para testar o Postgres, troque `makeStore`
 * em store-factory.ts; este arquivo não muda.
 */
const SEEDS = [1, 2, 3, 4, 5];

describe('fila de escrita por projeto (critério do 1b)', () => {
  for (const seed of SEEDS) {
    it(`capturas e extrações concorrentes no mesmo projeto: nada se perde, cadeias íntegras (semente ${seed})`, async () => {
      const TEXT2 = `${TEXT}\n\nExtra line.`;
      const h = harness(
        // dois passos por extração; a fila garante que não se intercalam as chamadas ao modelo
        [ext([claim]), ver('full'), ext([claim2]), ver('full')],
        {}, (s) => withLatency(s, seed),
      );
      // preparo (sequencial): duas fontes para extrair
      const s1 = await capture(h, TEXT, 'a.txt');
      const s2 = await capture(h, TEXT2, 'b.txt');

      const N = 8;
      const jobs: Promise<{ status: number; body: unknown; kind: string }>[] = [];
      for (let i = 0; i < N; i++) {
        jobs.push(h.call('POST', `/projects/${PROJECT}/sources`, { name: `c${i}.txt`, text: `Texto concorrente ${i}.` })
          .then((r) => ({ ...r, kind: 'capture' })));
        if (i === 2) jobs.push(h.call('POST', `/projects/${PROJECT}/extractions`, { sourceId: s1 }).then((r) => ({ ...r, kind: 'extract' })));
        if (i === 5) jobs.push(h.call('POST', `/projects/${PROJECT}/extractions`, { sourceId: s2 }).then((r) => ({ ...r, kind: 'extract' })));
      }
      const results = await Promise.all(jobs);

      // 1. nenhum pedido perdido nem recusado por corrida
      for (const r of results) {
        if (r.kind === 'capture') expect(r.status, JSON.stringify(r.body)).toBe(201);
        else expect(r.body).toMatchObject({ ok: true });
      }

      const ps = (await h.store.project(PROJECT))!;

      // 2. nenhuma atualização perdida: todas as fontes e propostas estão lá
      const entries = await ps.entries();
      expect(entries.length).toBe(2 + N); // uma entrada do núcleo por captura
      expect((await proposalsOf(h)).length).toBe(2);

      // 3. cadeia do núcleo íntegra
      expect(verifyChain(entries).ok).toBe(true);

      // 4. cadeia da auditoria íntegra, sem buracos, e na mesma ordem em que o núcleo aplicou
      const trail = await ps.audit();
      expect(trail.map((e) => e.seq)).toEqual(trail.map((_, i) => i + 1));
      expect(verifyAuditChain(trail)).toEqual({ ok: true });
      expect(trail.filter((e) => e.action === 'capture_source').length).toBe(2 + N);
      expect(trail.filter((e) => e.action === 'propose').length).toBe(2);
      const versions = trail.filter((e) => e.coreVersion !== undefined).map((e) => e.coreVersion!);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
      expect(new Set(versions).size).toBe(versions.length);
    });
  }

  it('armazém: appendAudit concorrente direto no Store mantém seq contíguo e cadeia válida (obrigação do armazém durável)', async () => {
    const h = harness([], {}, (s) => withLatency(s, 9));
    const ps = (await h.store.project(PROJECT))!;
    await Promise.all(Array.from({ length: 20 }, (_, i) => ps.appendAudit({ action: 'propose', targetId: `t${i}` })));
    const trail = await ps.audit();
    expect(trail.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(verifyAuditChain(trail)).toEqual({ ok: true });
  });

  it('armazém: duas escritas com a mesma baseVersion sobre o mesmo elemento, em paralelo: uma passa, a outra dá `conflict` (conflito otimista)', async () => {
    const h = harness([], {}, (st) => withLatency(st, 11));
    const ps = (await h.store.project(PROJECT))!;
    const text = 'Is Gamma ready?';
    const hash = await ps.putContent(text);
    expect(hash).toBe(new InMemoryContents().add(text));
    const { supportVerdict: _sv, ...ev } = evidenceFor(new InMemoryContents(), text, text) as never as Record<string, unknown>;
    const mk = (id: string, baseVersion: number, ops: ReturnType<typeof createItem>[]) => ({
      id: id as never, projectId: ps.projectId, baseVersion, schemaRef: { key: ps.schema.key, version: ps.schema.version },
      origin: human(), rationale: 'teste', operations: ops, createdAt: '2026-11-09T12:00:00.000Z',
    });
    const first = await ps.submitHuman(mk('c0', 0, [createItem({ id: 'i1', type: 'question', status: 'open', content: 'A', evidence: [ev as never] })]));
    if (!first.ok) throw new Error(JSON.stringify(first));
    const base = (await ps.state()).version;
    const upd = (id: string, to: string) => mk(id, base, [updateItem({ id: 'i1', before: { content: 'A' }, patch: { content: to } })] as never);
    const [a, b] = await Promise.all([ps.submitHuman(upd('cA', 'B')), ps.submitHuman(upd('cB', 'C'))]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok).length).toBe(1);
    expect(outcomes.filter((o) => !o.ok && o.code === 'conflict').length).toBe(1);
    // a perdedora não deixou rastro no núcleo
    expect(verifyChain(await ps.entries()).ok).toBe(true);
    expect((await ps.entries()).length).toBe(2);
  });
});
