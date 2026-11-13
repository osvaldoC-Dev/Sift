import { ModelPortError, type ModelPort, type ModelRequest, type ModelResponse } from '@sift/ai';
import { FakeModel } from '@sift/ai/testing';
import { verifyChain } from '@sift/core';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src';
import { capture, claim, claim2, ext, extract, harness, PROJECT, proposalsOf, ver } from './helpers';

/** Extração em DUAS FASES (OPEN-DECISIONS §7.1, decisão B): o modelo NÃO segura a fila de escrita do projeto. */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Falha (em vez de pendurar o teste) se a promessa não resolver a tempo: é o que acontece se a fila ficar presa ao modelo. */
const must = async <T>(p: Promise<T>, ms = 1500): Promise<T> => {
  const r = await Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
  if (r === 'timeout') throw new Error('a fila do projeto ficou presa à chamada ao modelo');
  return r;
};
const timeout = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);

/** Modelo que SEGURA a primeira chamada até `release()`: simula um provedor lento (minutos). */
function gated(inner: ModelPort): { model: ModelPort; entered: Promise<void>; release(): void } {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const enteredP = new Promise<void>((r) => { entered = r; });
  let first = true;
  return {
    entered: enteredP, release,
    model: {
      generate: async (req: ModelRequest): Promise<ModelResponse> => {
        if (first) { first = false; entered(); await gate; }
        return inner.generate(req);
      },
    },
  };
}

describe('a chamada ao modelo não trava o projeto', () => {
  it('captura concorrente com uma extração LENTA: a captura termina antes de o modelo responder', async () => {
    const g = gated(new FakeModel([ext([claim]), ver('full')], { model: 'fake-extractor' }));
    const h = harness([], { model: g.model });
    const src = await capture(h);
    const pending = extract(h, src);
    await must(g.entered); // o modelo está "a pensar"
    const cap = await timeout(h.call('POST', `/projects/${PROJECT}/sources`, { name: 'b.txt', text: 'Outro texto durante a extração.' }), 1000);
    expect(cap).not.toBe('timeout'); // com a fila presa ao modelo, ficaria à espera para sempre
    expect(cap !== 'timeout' && cap.status).toBe(201);
    g.release();
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    expect(await proposalsOf(h)).toHaveLength(1);
  });

  it('leitura do estado e do log também não esperam pela extração lenta', async () => {
    const g = gated(new FakeModel([ext([claim]), ver('full')], { model: 'fake-extractor' }));
    const h = harness([], { model: g.model });
    const src = await capture(h);
    const pending = extract(h, src);
    await must(g.entered);
    const st = await timeout(h.call('GET', `/projects/${PROJECT}/state`), 1000);
    const log = await timeout(h.call('GET', `/projects/${PROJECT}/log`), 1000);
    expect(st).not.toBe('timeout');
    expect(log).not.toBe('timeout');
    g.release();
    await pending;
  });

  it('o projeto avançou durante a extração: as propostas nascem com a versão do começo, válidas, e as cadeias seguem íntegras', async () => {
    const g = gated(new FakeModel([ext([claim, claim2]), ver('full'), ver('full')], { model: 'fake-extractor' }));
    const h = harness([], { model: g.model });
    const src = await capture(h);
    const ps0 = (await h.store.project(PROJECT))!;
    const versionAtStart = (await ps0.state()).version;
    const pending = extract(h, src);
    await must(g.entered);
    await must(capture(h, 'Texto novo 1 durante a extração.', 'c1.txt'));
    await must(capture(h, 'Texto novo 2 durante a extração.', 'c2.txt'));
    g.release();
    const r = await pending;
    expect(r.body).toMatchObject({ ok: true });
    const props = await proposalsOf(h);
    expect(props).toHaveLength(2);
    for (const p of props) {
      expect(p.quote.found).toBe(1); // o `quote.found` é calculado de novo sobre o texto
      expect(typeof p.stale).toBe('boolean'); // o núcleo decide; nunca perde a proposta
    }
    const ps = (await h.store.project(PROJECT))!;
    const stateNow = (await ps.state()).version;
    expect(stateNow).toBeGreaterThan(versionAtStart);
    expect(verifyChain(await ps.entries()).ok).toBe(true);
    const trail = await ps.audit();
    expect(verifyAuditChain(trail)).toEqual({ ok: true });
    expect(trail.map((e) => e.seq)).toEqual(trail.map((_, i) => i + 1));
  });

  it('duas extrações lentas em paralelo, de fontes diferentes: cada uma grava as suas, sem perder nem misturar', async () => {
    const mk = (items: unknown[], n: number) => {
      const g = gated(new FakeModel([ext(items as never), ...Array.from({ length: n }, () => ver('full'))], { model: 'fake-extractor' }));
      return g;
    };
    const g1 = mk([claim], 1);
    const g2 = mk([claim2], 1);
    // um modelo que despacha por conteúdo: a extração de cada fonte usa o seu roteiro
    const router: ModelPort = {
      generate: (req) => (JSON.stringify(req.messages).includes('Beta') ? g2.model : g1.model).generate(req),
    };
    const h = harness([], { model: router });
    const a = await capture(h, 'SOURCE-A Alpha is true here.\n\nIs Gamma ready?', 'a.txt');
    const b = await capture(h, 'SOURCE-B Beta is also true here.\n\nIs Gamma ready?', 'b.txt');
    const pa = extract(h, a);
    const pb = extract(h, b);
    await must(Promise.all([g1.entered, g2.entered]));
    g2.release();
    g1.release();
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.body).toMatchObject({ ok: true });
    expect(rb.body).toMatchObject({ ok: true });
    expect(await proposalsOf(h)).toHaveLength(2);
  });
});

describe('idempotência `runId:sourceId:ref`', () => {
  it('propor de novo a MESMA mudança (mesma chave) não duplica a proposta', async () => {
    const h = harness([ext([claim]), ver('full')]);
    const src = await capture(h);
    await extract(h, src);
    const ps = (await h.store.project(PROJECT))!;
    const before = await proposalsOf(h);
    expect(before).toHaveLength(1);
    const agentChanges = async () => (await ps.changes()).filter((c) => c.origin.kind === 'agent');
    const [mine] = await agentChanges();
    expect(await agentChanges()).toHaveLength(1);
    expect(mine!.idempotencyKey).toMatch(/^[^:]+:[^:]+:c0\.0$/); // runId:sourceId:ref
    const again = await ps.proposeChange({ ...mine!, id: 'outro-id' as never });
    expect(again.ok).toBe(true);
    expect(await agentChanges()).toHaveLength(1);
    expect(await proposalsOf(h)).toHaveLength(1);
  });
});

describe('avisos e erros novos da extração', () => {
  it('verificador a falhar em tudo: resposta ok:true, itens com verifierFailed, e o aviso verifier_degraded no log', async () => {
    const bad = { output: { lixo: true } };
    const h = harness([ext([claim, claim2]), bad, bad]);
    const src = await capture(h);
    const r = await extract(h, src);
    expect(r.body).toMatchObject({ ok: true });
    const props = await proposalsOf(h);
    expect(props.map((p) => p.verifierFailed)).toEqual([true, true]);
    expect(props.map((p) => p.support)).toEqual(['unchecked', 'unchecked']);
    const warn = h.logs.filter((l) => l.event === 'verifier_degraded');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ level: 'warn', projectId: PROJECT });
    expect(JSON.parse(warn[0]!.detail!)).toMatchObject({ unchecked: 2, verified: 2, fraction: 1, threshold: 0.5 });
  });

  it('o limite de degradação vem de ApiDeps: com 1,0 não há aviso', async () => {
    const bad = { output: { lixo: true } };
    const h = harness([ext([claim, claim2]), bad, bad], { verifierDegradedThreshold: 1 });
    const src = await capture(h);
    await extract(h, src);
    expect(h.logs.filter((l) => l.event === 'verifier_degraded')).toHaveLength(0);
  });

  it('sem aviso quando o verificador funciona', async () => {
    const h = harness([ext([claim]), ver('full')]);
    await extract(h, await capture(h));
    expect(h.logs.filter((l) => l.event === 'verifier_degraded')).toHaveLength(0);
  });

  it('teto de custo no modelo: ok:false como falha do fornecedor, NÃO retentável, nada proposto', async () => {
    const capped: ModelPort = { generate: async () => { throw new ModelPortError('cost_cap_exceeded', 'teto', { usage: { inputTokens: 1, outputTokens: 1 } }); } };
    const h = harness([], { model: capped });
    const r = await extract(h, await capture(h));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, error: { code: 'provider_failure', retryable: false } });
    expect(await proposalsOf(h)).toHaveLength(0);
    expect(h.logs.some((l) => l.event === 'extraction_failed' && l.code === 'cost_cap_exceeded')).toBe(true);
  });
});
