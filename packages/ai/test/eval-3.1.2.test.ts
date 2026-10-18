import { describe, expect, it } from 'vitest';
import { loadEval, scoreEval, validateGold, type GoldItem, type Prediction } from '../eval';

const data = loadEval();
const items = data.golds.flatMap((g) => g.items.map((it) => ({ source: g.source, it })));
const find = (key: string): { source: string; it: GoldItem } => {
  const f = items.find((x) => x.it.key === key);
  if (!f) throw new Error(`item inexistente: ${key}`);
  return f;
};
const perfect = (x: { source: string; it: GoldItem }, quoteIndex = 0): Prediction => ({
  sourceId: x.source, type: x.it.type, text: x.it.statement, quote: x.it.quotes[quoteIndex]!,
});
const DEC = '07-decision-log';

describe('3.1.2: fonte de decisões', () => {
  it('o gabarito continua válido e tem 7 fontes', () => {
    expect(validateGold(data)).toEqual([]);
    expect(data.golds).toHaveLength(7);
  });

  it('a fonte 07 tem 5 decisões e 1 pergunta', () => {
    const g = data.golds.find((x) => x.source === DEC)!;
    expect(g.items.filter((i) => i.type === 'decision')).toHaveLength(5);
    expect(g.items.filter((i) => i.type === 'question')).toHaveLength(1);
    expect(g.traps).toHaveLength(3);
  });

  it('a decisão extraída como decisão acerta', () => {
    const x = find('dec.billing-first');
    const r = scoreEval(data, [perfect(x)]);
    expect(r.perSource[DEC]!.matchedPredictions).toBe(1);
  });

  it('decisão com duas citações: qualquer uma acerta, e a segunda é duplicada do mesmo item', () => {
    const x = find('dec.plain-http');
    expect(scoreEval(data, [perfect(x, 0)]).perSource[DEC]!.matchedPredictions).toBe(1);
    expect(scoreEval(data, [perfect(x, 1)]).perSource[DEC]!.matchedPredictions).toBe(1);
    const both = scoreEval(data, [perfect(x, 0), perfect(x, 1)]).perSource[DEC]!;
    expect(both.matchedPredictions).toBe(1);
    expect(both.duplicateMatches).toBe(1);
  });

  it('item decision extraído como claim NÃO acerta (o tipo importa)', () => {
    const x = find('dec.billing-first');
    const r = scoreEval(data, [{ ...perfect(x), type: 'claim' }]);
    const m = r.perSource[DEC]!;
    expect(m.matchedPredictions).toBe(0);
    expect(m.unjudged).toBe(1);
  });

  it('a pergunta em forma de afirmação só acerta como question, não como decision', () => {
    const q = find('dec.session-owner-open');
    expect(scoreEval(data, [perfect(q)]).perSource[DEC]!.matchedPredictions).toBe(1);
    expect(scoreEval(data, [{ ...perfect(q), type: 'decision' }]).perSource[DEC]!.matchedPredictions).toBe(0);
  });

  for (const key of ['dec.trap-mesh-proposal', 'dec.trap-canary-leaning', 'dec.trap-revisit-budget']) {
    it(`armadilha ${key}: extrair como decision atinge a armadilha`, () => {
      const g = data.golds.find((x) => x.source === DEC)!;
      const t = g.traps.find((x) => x.key === key)!;
      const r = scoreEval(data, [{ sourceId: DEC, type: 'decision', text: 'x', quote: t.quotes[0]! }]);
      expect(r.perSource[DEC]!.trapsHit).toEqual([key]);
    });
  }

  it('a proposta extraída como assumption/question não atinge a armadilha (só decision é proibido)', () => {
    const g = data.golds.find((x) => x.source === DEC)!;
    const t = g.traps.find((x) => x.key === 'dec.trap-mesh-proposal')!;
    const r = scoreEval(data, [{ sourceId: DEC, type: 'question', text: 'x', quote: t.quotes[0]! }]);
    expect(r.perSource[DEC]!.trapsHit).toEqual([]);
  });

  it('as 3 armadilhas da fonte 07 não casam com nenhum item do gabarito', () => {
    const g = data.golds.find((x) => x.source === DEC)!;
    const preds = g.traps.map((t) => ({ sourceId: DEC, type: 'decision' as const, text: 'x', quote: t.quotes[0]! }));
    const m = scoreEval(data, preds).perSource[DEC]!;
    expect(m.matchedPredictions).toBe(0);
    expect(m.trapsHit).toHaveLength(3);
  });
});

describe('3.1.2: relações', () => {
  const r = data.relations;
  const has = (list: { a: string; b: string }[], a: string, b: string) =>
    list.some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));

  it('billing-least-coupled e billing-fewest-deps são quase-relação, não duplicata', () => {
    expect(has(r.near_misses, 'arch.billing-least-coupled', 'cost.billing-fewest-deps')).toBe(true);
    const dup = r.duplicates.some(([a, b]) => [a, b].includes('arch.billing-least-coupled'));
    expect(dup).toBe(false);
  });

  it('payload 2 MB = 2048 KB é duplicata e continua quase-contradição', () => {
    expect(r.duplicates.some(([a, b]) => new Set([a, b]).has('arch.payload-2mb') && new Set([a, b]).has('cost.payload-2048kb'))).toBe(true);
    expect(has(r.near_misses, 'arch.payload-2mb', 'cost.payload-2048kb')).toBe(true);
  });

  it('a decisão de cinco serviços contradiz a memo de capacidade (duas vezes)', () => {
    expect(has(r.contradictions, 'dec.five-services-q3', 'cap.three-services-max')).toBe(true);
    expect(has(r.contradictions, 'dec.five-services-q3', 'cap.staffing-not-five')).toBe(true);
  });

  it('orçamento de 50 ms versus p95 de 484 ms é quase-relação', () => {
    expect(has(r.near_misses, 'dec.latency-budget-50ms', 'pm.p95-rose')).toBe(true);
  });

  it('continuam 2 grupos de duplicatas', () => {
    expect(r.duplicates).toHaveLength(2);
  });
});

describe('3.1.2: nota de cost.network-tooling-rise', () => {
  it('o enunciado diz só o que a linha mostra e a nota registra o veredito esperado partial', () => {
    const x = find('cost.network-tooling-rise').it;
    expect(x.statement).toContain('lists');
    expect(x.note).toContain('partial');
  });
});
