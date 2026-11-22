import { describe, expect, it } from 'vitest';
import {
  CostGuard, KIMI_K3_PRICES, ModelPortError, assertCaps, costUsd, extractFromSource, redactSecrets,
  type ModelPort, type ModelRequest, type ModelResponse, type ModelUsage,
} from '../src';
import { FakeModel, type FakeStep } from '../src/testing';
import { ext, inputFor, makeDeps } from './extract-helpers';

const P = KIMI_K3_PRICES;
const rq = (): ModelRequest => ({ system: 's', messages: [], schema: {}, params: {} });
const caps = (maxUsd: number, maxTotalTokens = 1e9) => ({ maxUsd, maxTotalTokens });
const step = (output: unknown, usage: ModelUsage): FakeStep => ({ output: output as never, usage });

describe('preços e custo', () => {
  it('US$ 3 / 0,30 em cache / 15 por milhão de tokens', () => {
    expect(P).toEqual({ inputUsdPerM: 3, cachedInputUsdPerM: 0.3, outputUsdPerM: 15 });
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 0 }, P)).toBeCloseTo(3, 10);
    expect(costUsd({ inputTokens: 0, outputTokens: 1_000_000 }, P)).toBeCloseTo(15, 10);
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }, P)).toBeCloseTo(0.3, 10);
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 400_000 }, P)).toBeCloseTo(0.6 * 3 + 0.4 * 0.3 + 1.5, 10);
  });
  it('cache maior que a entrada não gera custo negativo nem passa da entrada', () => {
    expect(costUsd({ inputTokens: 10, outputTokens: 0, cachedInputTokens: 999 }, P)).toBeCloseTo(10 * 0.3 / 1e6, 12);
    expect(costUsd({ inputTokens: 10, outputTokens: 0, cachedInputTokens: -5 }, P)).toBeCloseTo(30 / 1e6, 12);
  });
  it('o raciocínio conta como saída: o custo cresce com os tokens de saída', () => {
    const a = costUsd({ inputTokens: 100, outputTokens: 100 }, P);
    const b = costUsd({ inputTokens: 100, outputTokens: 20_000 }, P);
    expect(b - a).toBeCloseTo((19_900 * 15) / 1e6, 10);
  });
});

describe('teto obrigatório', () => {
  it('sem teto, ou teto inválido: recusa (RangeError)', () => {
    for (const bad of [undefined, {}, { maxUsd: 1 }, { maxTotalTokens: 10 }, { maxUsd: 0, maxTotalTokens: 10 }, { maxUsd: 1, maxTotalTokens: -1 }, { maxUsd: Number.NaN, maxTotalTokens: 1 }, { maxUsd: Infinity, maxTotalTokens: 1 }]) {
      expect(() => assertCaps(bad as never)).toThrow(RangeError);
      expect(() => new CostGuard(bad as never, P)).toThrow(RangeError);
    }
    expect(() => assertCaps({ maxUsd: 1, maxTotalTokens: 1 })).not.toThrow();
  });
});

describe('o teto corta a execução', () => {
  it('resposta gigante: a chamada que estoura é descartada, leva o uso, e o guarda recusa as seguintes', async () => {
    const fake = new FakeModel([step({ ok: 1 }, { inputTokens: 10, outputTokens: 2_000_000 }), step({ ok: 2 }, { inputTokens: 1, outputTokens: 1 })]);
    const g = new CostGuard(caps(1), P);
    const m = g.wrap(fake);
    const e = await m.generate(rq()).catch((x: unknown) => x as ModelPortError);
    expect(e).toBeInstanceOf(ModelPortError);
    expect(e).toMatchObject({ code: 'cost_cap_exceeded', retryable: false, usage: { inputTokens: 10, outputTokens: 2_000_000 } });
    expect(g.snapshot().usd).toBeCloseTo(30.00003, 4);
    const e2 = await m.generate(rq()).catch((x: unknown) => x as ModelPortError);
    expect(e2).toMatchObject({ code: 'cost_cap_exceeded' });
    expect(fake.calls).toHaveLength(1); // a segunda NEM chegou ao modelo
  });

  it('o teto de tokens corta sozinho, mesmo com dólares de sobra', async () => {
    const fake = new FakeModel([step({}, { inputTokens: 60, outputTokens: 50 })]);
    const g = new CostGuard(caps(1000, 100), P);
    await expect(g.wrap(fake).generate(rq())).rejects.toThrow('teto de custo');
    expect(g.snapshot().totalTokens).toBe(110);
  });

  it('"atingir" é >=: gasto exatamente igual ao teto também para', async () => {
    const usage = { inputTokens: 0, outputTokens: 1_000_000 }; // US$ 15 exatos
    const g = new CostGuard(caps(15), P);
    await expect(g.wrap(new FakeModel([step({}, usage)])).generate(rq())).rejects.toThrow();
  });

  it('abaixo do teto passa, soma e conta as chamadas', async () => {
    const g = new CostGuard(caps(1), P);
    const m = g.wrap(new FakeModel([step({ a: 1 }, { inputTokens: 100, outputTokens: 10 }), step({ b: 1 }, { inputTokens: 200, outputTokens: 20, cachedInputTokens: 100, estimated: true })]));
    await m.generate(rq());
    await m.generate(rq());
    expect(g.snapshot()).toMatchObject({ inputTokens: 300, outputTokens: 30, totalTokens: 330, calls: 2, estimatedCalls: 1 });
    expect(g.snapshot().usd).toBeCloseTo(costUsd({ inputTokens: 100, outputTokens: 10 }, P) + costUsd({ inputTokens: 200, outputTokens: 20, cachedInputTokens: 100 }, P), 12);
  });

  it('uso estimado (usage em falta) NÃO é custo zero: entra na conta e pode estourar o teto', async () => {
    const g = new CostGuard(caps(0.01), P);
    const est: ModelUsage = { inputTokens: 1000, outputTokens: 4000, estimated: true }; // US$ 0,063
    await expect(g.wrap(new FakeModel([step({}, est)])).generate(rq())).rejects.toThrow('teto de custo');
  });

  it('erro do modelo que leva uso entra na conta (e o erro segue)', async () => {
    const boom: ModelPort = { generate: async () => { throw new ModelPortError('provider_error', 'x', { usage: { inputTokens: 5, outputTokens: 5 } }); } };
    const g = new CostGuard(caps(1), P);
    await expect(g.wrap(boom).generate(rq())).rejects.toThrow('x');
    expect(g.snapshot().totalTokens).toBe(10);
  });

  it('guardas encadenados: o teto de uma fonte corta sem consumir o total da corrida', async () => {
    const total = new CostGuard(caps(100), P, 'corrida');
    const perSource = new CostGuard(caps(0.5), P, 'fonte');
    const fake = new FakeModel([step({}, { inputTokens: 0, outputTokens: 100_000 })]); // US$ 1,5
    const m = total.wrap(perSource.wrap(fake));
    const e = await m.generate(rq()).catch((x: unknown) => x as ModelPortError);
    expect(e).toMatchObject({ code: 'cost_cap_exceeded', usage: { outputTokens: 100_000 } });
    expect(total.snapshot().usd).toBeCloseTo(1.5, 6); // o gasto real chegou ao guarda de fora
  });
});

describe('pipeline: o teto corta com o verificador chamado N vezes', () => {
  const text = Array.from({ length: 12 }, (_, i) => `Statement number ${i} is true here.`).join('\n\n');
  const items = Array.from({ length: 12 }, (_, i) => ({ type: 'claim', statement: `Statement ${i}.`, quote: `Statement number ${i} is true here.` }));
  const verdict = (): FakeStep => step({ verdict: 'full' }, { inputTokens: 1000, outputTokens: 20_000 }); // US$ 0,303 cada

  it('para no meio da verificação: erro tipado, nada mantido, relatório com o gasto REAL', async () => {
    const fake = new FakeModel([step({ items }, { inputTokens: 5000, outputTokens: 1000 }), ...Array.from({ length: 12 }, verdict)]);
    const guard = new CostGuard(caps(1), P); // 1 dólar: estoura na 4ª verificação
    const base = makeDeps([]);
    const r = await extractFromSource({ ...base, model: guard.wrap(fake) }, inputFor('s', text));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'cost_cap_exceeded', retryable: false });
    expect(r.report).toMatchObject({ kept: 0, modelChanges: 0, discarded: [], uncheckedByVerifier: [], verifierDegraded: null });
    expect(fake.calls.length).toBeLessThan(13); // parou antes de chamar todos
    const s = guard.snapshot();
    expect(r.report.usage).toEqual({ inputTokens: s.inputTokens, outputTokens: s.outputTokens }); // o relatório == o medidor
    expect(s.usd).toBeGreaterThanOrEqual(1);
    expect(s.usd).toBeLessThan(1 + 0.31); // passou por UMA chamada, não mais
  });

  it('resposta gigante na extração: para logo, sem chamar o verificador', async () => {
    const fake = new FakeModel([step({ items }, { inputTokens: 100, outputTokens: 500_000 }), verdict()]);
    const guard = new CostGuard(caps(1), P);
    const r = await extractFromSource({ ...makeDeps([]), model: guard.wrap(fake) }, inputFor('s', text));
    expect(r.ok === false && r.error.code).toBe('cost_cap_exceeded');
    expect(fake.calls).toHaveLength(1);
  });

  it('sem estourar: a execução termina normal e o medidor bate com o relatório', async () => {
    const fake = new FakeModel([step({ items: items.slice(0, 2) }, { inputTokens: 500, outputTokens: 100 }), step({ verdict: 'full' }, { inputTokens: 100, outputTokens: 10 }), step({ verdict: 'full' }, { inputTokens: 100, outputTokens: 10 })]);
    const guard = new CostGuard(caps(1), P);
    const r = await extractFromSource({ ...makeDeps([]), model: guard.wrap(fake) }, inputFor('s', text));
    expect(r.ok).toBe(true);
    expect(r.report.usage).toEqual({ inputTokens: 700, outputTokens: 120 });
    expect(guard.snapshot().totalTokens).toBe(820);
  });
});

describe('segredos', () => {
  it('redactSecrets troca a chave onde aparecer; segredo curto é ignorado', () => {
    const k = 'sk-0123456789abcdef';
    expect(redactSecrets(`a ${k} b ${k}`, [k])).toBe('a [redigido] b [redigido]');
    expect(redactSecrets('abc', ['abc'])).toBe('abc');
    expect(redactSecrets('nada aqui', [k])).toBe('nada aqui');
  });
});

describe('contrato do ModelResponse', () => {
  it('o guarda devolve a resposta intacta quando não corta', async () => {
    const res: ModelResponse = { output: { a: 1 }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' };
    const g = new CostGuard(caps(1), P);
    expect(await g.wrap({ generate: async () => res }).generate(rq())).toBe(res);
  });
});
