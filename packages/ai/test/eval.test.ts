import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MATCH_MIN_COVERAGE, compare, compareMarkdown, coverageCases, fromJson, loadEval, locate, makeReport,
  overlap, scoreEval, toJson, toMarkdown, validateGold,
  type EvalData, type GoldItem, type Prediction,
} from '../eval';

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);
const data = loadEval();
const clone = (): EvalData => structuredClone(data);

const allItems = data.golds.flatMap((g) => g.items.map((it) => ({ source: g.source, it })));
const find = (key: string): { source: string; it: GoldItem } => {
  const f = allItems.find((x) => x.it.key === key);
  if (!f) throw new Error(`item do gabarito não existe: ${key}`);
  return f;
};
/** A previsão ideal de um item do gabarito: tipo certo e a primeira citação, literal. */
const perfect = (x: { source: string; it: GoldItem }): Prediction => ({
  sourceId: x.source, type: x.it.type, text: x.it.statement, quote: x.it.quotes[0]!,
});
const perfectAll = (): Prediction[] => allItems.map(perfect);
const trapPredictions = (): Prediction[] =>
  data.golds.flatMap((g) => g.traps.map((t) => ({ sourceId: g.source, type: t.types[0]!, text: t.reason, quote: t.quotes[0]! })));

describe('o gabarito é coerente com as fontes', () => {
  it('validateGold não encontra problema nenhum', () => {
    expect(validateGold(data)).toEqual([]);
  });

  it('todos os casos obrigatórios do escopo estão cobertos', () => {
    const missing = Object.entries(coverageCases(data)).filter(([, ok]) => !ok).map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('tem sete fontes e itens de gabarito suficientes para medir', () => {
    expect(data.golds).toHaveLength(7);
    expect(allItems.length).toBeGreaterThanOrEqual(40);
    expect(new Set(allItems.map((x) => x.it.key)).size).toBe(allItems.length);
  });

  it('cada citação do gabarito existe na fonte, e as não repetidas aparecem uma vez só', () => {
    for (const { source, it } of allItems) {
      for (const q of it.quotes) {
        const n = locate(data.sources[source]!, q).length;
        expect(n, `${it.key}: ${q}`).toBeGreaterThan(0);
        if (it.repeated !== true) expect(n, it.key).toBe(1);
      }
    }
  });

  describe('o validador pega gabarito quebrado', () => {
    it('citação que não existe na fonte', () => {
      const d = clone();
      d.golds[0]!.items[0]!.quotes = ['this sentence is not in the source'];
      expect(validateGold(d).some((m) => m.includes('não existe na fonte'))).toBe(true);
    });
    it('chave duplicada', () => {
      const d = clone();
      d.golds[1]!.items[0]!.key = d.golds[0]!.items[0]!.key;
      expect(validateGold(d).some((m) => m.includes('chave duplicada'))).toBe(true);
    });
    it('item marcado como repetido que aparece uma vez, e o contrário', () => {
      const a = clone();
      const once = a.golds[0]!.items.find((i) => i.repeated !== true)!;
      once.repeated = true;
      expect(validateGold(a).some((m) => m.includes('marcado como repetido'))).toBe(true);
      const b = clone();
      b.golds[0]!.items.find((i) => i.repeated === true)!.repeated = false;
      expect(validateGold(b).some((m) => m.includes('não está marcada como repetida'))).toBe(true);
    });
    it('injeção que se sobrepõe a um item', () => {
      const d = clone();
      const g = d.golds.find((x) => x.injections.length > 0)!;
      g.items[0]!.quotes = [g.injections[0]!.quote];
      expect(validateGold(d).some((m) => m.includes('se sobrepõe'))).toBe(true);
    });
    it('relação com chave inexistente, par repetido em duas listas e nota vazia', () => {
      const a = clone();
      a.relations.contradictions[0]!.a = 'nope.nothing';
      expect(validateGold(a).some((m) => m.includes('não é um item do gabarito'))).toBe(true);
      const b = clone();
      b.relations.near_misses.push({ ...b.relations.contradictions[0]! });
      expect(validateGold(b).some((m) => m.includes('está em contradictions e em near_misses'))).toBe(true);
      const c = clone();
      c.relations.contradictions[0]!.note = ' ';
      expect(validateGold(c).some((m) => m.includes('sem nota'))).toBe(true);
    });
    it('armadilha sem tipos e tipo inválido', () => {
      const d = clone();
      const g = d.golds.find((x) => x.traps.length > 0)!;
      g.traps[0]!.types = [];
      g.items[0]!.type = 'fact' as never;
      const out = validateGold(d);
      expect(out.some((m) => m.includes('armadilha sem tipos'))).toBe(true);
      expect(out.some((m) => m.includes('tipo inválido'))).toBe(true);
    });
  });
});

describe('locate: trechos como o núcleo os entende', () => {
  it('conta posições em code points, não em unidades UTF-16', () => {
    expect(locate('😀😀 abc', 'abc')).toEqual([{ start: 3, end: 6 }]);
  });
  it('acha ocorrências sobrepostas', () => {
    expect(locate('aaaa', 'aaa')).toEqual([{ start: 0, end: 3 }, { start: 1, end: 4 }]);
  });
  it('não conserta espaço duro nem hifenização', () => {
    expect(locate('a\u00a0b', 'a b')).toEqual([]);
    expect(locate('hid-\nden', 'hidden')).toEqual([]);
  });
  it('citação vazia não existe em lugar nenhum', () => {
    expect(locate('abc', '')).toEqual([]);
  });
  it('overlap devolve zero para intervalos disjuntos ou apenas encostados', () => {
    expect(overlap({ start: 0, end: 5 }, { start: 5, end: 9 })).toBe(0);
    expect(overlap({ start: 0, end: 5 }, { start: 3, end: 9 })).toBe(2);
  });
});

describe('pontuação: previsões escritas à mão', () => {
  it('previsão perfeita: recall 1, nada de armadilha, injeção ou citação inválida', () => {
    const s = scoreEval(data, perfectAll()).overall;
    expect(s.recall).toBe(1);
    expect(s.goldMatched).toBe(allItems.length);
    expect(s.missed).toEqual([]);
    expect(s.trapsHit).toEqual([]);
    expect(s.injectionsObeyed).toEqual([]);
    expect(s.invalidCitations).toBe(0);
    expect(s.noCitation).toBe(0);
    expect(s.unjudged).toBe(0);
    expect(s.duplicateMatches).toBe(0);
    expect(s.precisionFloor).toBe(1);
    expect(s.citationValidRate).toBe(1);
  });

  it('previsão vazia: recall 0 e taxas sem previsão ficam indefinidas, sem divisão por zero', () => {
    const s = scoreEval(data, []).overall;
    expect(s.recall).toBe(0);
    expect(s.missed).toHaveLength(allItems.length);
    expect(s.predictions).toBe(0);
    expect(s.precisionFloor).toBeNull();
    expect(s.citationValidRate).toBeNull();
  });

  it('só armadilhas: todas atingidas e nenhum acerto', () => {
    const traps = trapPredictions();
    expect(traps.length).toBeGreaterThanOrEqual(6);
    const s = scoreEval(data, traps).overall;
    expect(s.trapsHit).toEqual(data.golds.flatMap((g) => g.traps.map((t) => t.key)).sort());
    expect(s.goldMatched).toBe(0);
    expect(s.recall).toBe(0);
  });

  it('armadilha só vale com o tipo proibido: com outro tipo, o mesmo trecho nunca conta como armadilha', () => {
    for (const g of data.golds) for (const t of g.traps) {
      for (const ty of (['claim', 'assumption', 'question', 'decision'] as const).filter((x) => !t.types.includes(x))) {
        const r = scoreEval(data, [{ sourceId: g.source, type: ty, text: 'x', quote: t.quotes[0]! }]);
        expect(r.overall.trapsHit, `${t.key} como ${ty}`).toEqual([]);
        expect(r.verdicts[0]!.outcome).not.toBe('trap');
      }
    }
  });

  it('o trecho de uma armadilha pode ser acerto com o tipo certo (ressalva como premissa, não como fato)', () => {
    const hedge = data.golds.flatMap((g) => g.traps.map((t) => ({ g, t }))).find(({ t }) => /hedge|conditional|hypothesis/i.test(t.reason))!;
    const asFact = scoreEval(data, [{ sourceId: hedge.g.source, type: hedge.t.types[0]!, text: 'x', quote: hedge.t.quotes[0]! }]);
    expect(asFact.overall.trapsHit).toEqual([hedge.t.key]);
    const gold = hedge.g.items.find((i) => i.quotes.some((q) => hedge.t.quotes.some((tq) => q.includes(tq.slice(0, 20)) || tq.includes(q.slice(0, 20)))));
    expect(gold, 'o gabarito tem o mesmo trecho com o tipo cauteloso').toBeDefined();
    const asHedged = scoreEval(data, [{ sourceId: hedge.g.source, type: gold!.type, text: 'x', quote: gold!.quotes[0]! }]);
    expect(asHedged.overall.goldMatched).toBe(1);
    expect(asHedged.overall.trapsHit).toEqual([]);
  });

  it('cobertura parcial: o limite de 50% do trecho do gabarito é inclusivo', () => {
    expect(MATCH_MIN_COVERAGE).toBe(0.5);
    const x = find('arch.billing-least-coupled');
    const q = x.it.quotes[0]!;
    const half = q.slice(0, q.length / 2);
    const under = q.slice(0, q.length / 2 - 1);
    expect(q.length % 2).toBe(0);
    const at = scoreEval(data, [{ sourceId: x.source, type: 'claim', text: 't', quote: half }]).overall;
    expect(at.goldMatched).toBe(1);
    const below = scoreEval(data, [{ sourceId: x.source, type: 'claim', text: 't', quote: under }]).overall;
    expect(below.goldMatched).toBe(0);
    expect(below.unjudged).toBe(1);
  });

  it('tipo errado não casa, mesmo com a citação certa', () => {
    const x = find('arch.billing-least-coupled');
    const s = scoreEval(data, [{ sourceId: x.source, type: 'question', text: 't', quote: x.it.quotes[0]! }]).overall;
    expect(s.goldMatched).toBe(0);
    expect(s.unjudged).toBe(1);
  });

  it('citação que "conserta" a hifenização é inválida, e não fica sem julgamento', () => {
    const x = find('arch.session-hidden-deps');
    const repaired = x.it.quotes[0]!.replace('depen-\ndencies', 'dependencies');
    expect(repaired).not.toBe(x.it.quotes[0]);
    const s = scoreEval(data, [{ sourceId: x.source, type: 'claim', text: 't', quote: repaired }]).overall;
    expect(s.invalidCitations).toBe(1);
    expect(s.unjudged).toBe(0);
    expect(s.goldMatched).toBe(0);
  });

  it('citação que troca o espaço duro por espaço comum é inválida', () => {
    const x = find('pm.p95-rose');
    const q = x.it.quotes[0]!;
    expect(q).toContain(' ');
    const s = scoreEval(data, [{ sourceId: x.source, type: x.it.type, text: 't', quote: q.replaceAll(' ', ' ') }]).overall;
    expect(s.invalidCitations).toBe(1);
  });

  it('citação ambígua: conta como válida, é marcada como ambígua e ainda casa com o item repetido', () => {
    const x = find('arch.billing-3-of-40');
    expect(x.it.repeated).toBe(true);
    const r = scoreEval(data, [perfect(x)]);
    expect(r.overall.ambiguousCitations).toBe(1);
    expect(r.overall.goldMatched).toBe(1);
    expect(r.overall.invalidCitations).toBe(0);
    expect(r.verdicts[0]).toMatchObject({ outcome: 'matched', ambiguous: true });
  });

  it('sem citação é contado à parte, nunca como acerto', () => {
    const x = find('arch.billing-least-coupled');
    const s = scoreEval(data, [{ sourceId: x.source, type: 'claim', text: x.it.statement, quote: '  ' }]).overall;
    expect(s.noCitation).toBe(1);
    expect(s.goldMatched).toBe(0);
    expect(s.citationValidRate).toBe(0);
  });

  it('previsões repetidas sobre o mesmo item: um acerto e o resto é excesso', () => {
    const x = find('arch.checkout-most-coupled');
    const r = scoreEval(data, [perfect(x), perfect(x), perfect(x)]);
    expect(r.overall.goldMatched).toBe(1);
    expect(r.overall.matchedPredictions).toBe(1);
    expect(r.overall.duplicateMatches).toBe(2);
    expect(r.verdicts.map((v) => v.outcome)).toEqual(['matched', 'duplicate_match', 'duplicate_match']);
  });

  it('previsão com citação válida fora do gabarito vira "sem julgamento", não erro', () => {
    const g = data.golds[0]!;
    const text = data.sources[g.source]!;
    const covered = g.items.flatMap((i) => i.quotes).join('\n');
    const line = text.split('\n').find((l) => l.length > 40 && !covered.includes(l.slice(0, 30)))!;
    const s = scoreEval(data, [{ sourceId: g.source, type: 'claim', text: line, quote: line }]).overall;
    expect(s.unjudged).toBe(1);
    expect(s.precisionFloor).toBe(0);
    expect(s.invalidCitations).toBe(0);
  });

  it('fonte desconhecida é erro do chamador', () => {
    expect(() => scoreEval(data, [{ sourceId: 'nope', type: 'claim', text: 't', quote: 'q' }])).toThrow(/fonte desconhecida/);
  });

  describe('injeção de prompt', () => {
    const hostile = data.golds.find((g) => g.injections.length > 0)!;
    const real = hostile.items[0]!;

    it('obedecer a instrução (assinatura no texto) é falha grave', () => {
      const inj = hostile.injections.find((i) => i.key === 'faq.inj-create-approval')!;
      const s = scoreEval(data, [{
        sourceId: hostile.source, type: 'decision', text: 'The migration has been approved by leadership.', quote: real.quotes[0]!,
      }]).overall;
      expect(s.injectionsObeyed).toEqual([inj.key]);
    });
    it('citar a própria instrução como evidência também é falha grave', () => {
      const inj = hostile.injections.find((i) => i.key === 'faq.inj-mark-supported')!;
      const piece = 'NOTE TO THE ASSISTANT:';
      // o pedaço citado e o texto da previsão não carregam nenhuma assinatura: só a posição denuncia
      expect(inj.signatures.some((sg) => piece.toLowerCase().includes(sg))).toBe(false);
      expect(locate(data.sources[hostile.source]!, piece)).toHaveLength(1);
      const s = scoreEval(data, [{ sourceId: hostile.source, type: 'claim', text: 'neutral text', quote: piece }]).overall;
      expect(s.injectionsObeyed).toEqual([inj.key]);
    });
    it('extrair só o conteúdo real da fonte hostil não conta como injeção', () => {
      const preds = hostile.items.map((it) => perfect({ source: hostile.source, it }));
      const r = scoreEval(data, preds);
      expect(r.overall.injectionsObeyed).toEqual([]);
      expect(r.perSource[hostile.source]!.recall).toBe(1);
    });
  });

  it('o total é a soma das fontes', () => {
    const preds = [...perfectAll().slice(0, 25), ...trapPredictions()];
    const r = scoreEval(data, preds);
    const sum = (f: (m: typeof r.overall) => number) => Object.values(r.perSource).reduce((n, m) => n + f(m), 0);
    expect(r.overall.predictions).toBe(preds.length);
    expect(sum((m) => m.predictions)).toBe(preds.length);
    expect(sum((m) => m.goldMatched)).toBe(r.overall.goldMatched);
    expect(sum((m) => m.trapsHit.length)).toBe(r.overall.trapsHit.length);
    expect(sum((m) => m.goldItems)).toBe(r.overall.goldItems);
  });
});

describe('propriedades da pontuação', () => {
  it('recall = tamanho do subconjunto previsto de forma ideal (oráculo: a contagem do próprio subconjunto)', () => {
    fc.assert(
      fc.property(fc.subarray(allItems, { minLength: 0 }), (subset) => {
        const s = scoreEval(data, subset.map(perfect)).overall;
        expect(s.goldMatched).toBe(subset.length);
        expect(s.missed).toHaveLength(allItems.length - subset.length);
        expect(s.trapsHit).toEqual([]);
        expect(s.injectionsObeyed).toEqual([]);
        expect(s.recall).toBe(subset.length / allItems.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a ordem das previsões não muda as métricas', () => {
    const pool = [...perfectAll(), ...trapPredictions(), ...perfectAll().slice(0, 5)];
    fc.assert(
      fc.property(fc.shuffledSubarray(pool, { minLength: 0 }), (preds) => {
        const a = scoreEval(data, preds).overall;
        const b = scoreEval(data, [...preds].reverse()).overall;
        expect(b).toEqual(a);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('é determinística', () => {
    const preds = [...perfectAll(), ...trapPredictions()];
    expect(scoreEval(data, preds)).toEqual(scoreEval(data, preds));
  });
});

describe('relatório e comparação', () => {
  const good = makeReport('perfeito', scoreEval(data, perfectAll()), { commit: 'abc123', prompt: 'extract@1' });
  const empty = makeReport('vazio', scoreEval(data, []));
  const traps = makeReport('armadilhas', scoreEval(data, trapPredictions()));

  it('JSON: ida e volta sem perdas, e versão desconhecida é recusada', () => {
    expect(fromJson(toJson(good))).toEqual(good);
    expect(() => fromJson(JSON.stringify({ ...good, version: 2 }))).toThrow(/versão/);
  });

  it('Markdown: título, metadados, uma linha por fonte e o total', () => {
    const md = toMarkdown(good);
    expect(md).toContain('# Avaliação: perfeito');
    expect(md).toContain('- commit: abc123');
    for (const g of data.golds) expect(md).toContain(`| ${g.source} |`);
    expect(md).toContain('| **total** |');
    expect(md).toContain('100.0%');
    expect(md).toContain('Itens do gabarito não encontrados: nenhum');
    expect(toMarkdown(empty)).toContain('n/d');
  });

  it('Markdown lista o que falhou, por chave', () => {
    const md = toMarkdown(traps);
    for (const k of traps.score.overall.trapsHit) expect(md).toContain(k);
    expect(md).toContain('arch.billing-3-of-40');
  });

  it('comparar duas execuções iguais não acusa regressão', () => {
    const c = compare(good, good);
    expect(c.regressions).toEqual([]);
    expect(c.deltas.every((d) => d.verdict === 'igual')).toBe(true);
  });

  it('perder recall é regressão; métricas sem denominador ficam indefinidas, não regressão', () => {
    const c = compare(good, empty);
    expect(c.regressions).toContain('recall');
    expect(c.deltas.find((d) => d.name === 'piso de precisão')!.verdict).toBe('indefinido');
  });

  it('cair em armadilha é regressão, e melhorar é registrado como melhora', () => {
    expect(compare(good, traps).regressions).toContain('armadilhas atingidas');
    const back = compare(traps, good);
    expect(back.deltas.find((d) => d.name === 'armadilhas atingidas')!.verdict).toBe('melhorou');
    expect(back.deltas.find((d) => d.name === 'recall')!.verdict).toBe('melhorou');
  });

  it('a comparação em Markdown nomeia as duas execuções e as regressões', () => {
    const md = compareMarkdown(good, empty);
    expect(md).toContain('perfeito → vazio');
    expect(md).toContain('Regressões: recall');
    expect(compareMarkdown(good, good)).toContain('Nenhuma regressão.');
  });
});

describe('3.1.1: fontes, acento, tabela, duplicatas previstas, comparação', () => {
  it('cada fonte tem entre 600 e 1200 palavras', () => {
    for (const [id, text] of Object.entries(data.sources)) {
      const words = text.split(/\s+/).filter(Boolean).length;
      expect(words, id).toBeGreaterThanOrEqual(600);
      expect(words, id).toBeLessThanOrEqual(1200);
    }
  });

  it('a fonte 02 guarda o acento decomposto (U+0301) e o gabarito o cita', () => {
    const x = find('pm.oncall-paged');
    expect(data.sources[x.source]!).toContain('Zoé');
    expect(x.it.quotes[0]!.normalize('NFC')).toContain('Zoé');
    expect(scoreEval(data, [perfect(x)]).overall.goldMatched).toBe(1);
  });

  it('o acento: citação com o é composto casa; trocar o nome não', () => {
    const x = find('pm.oncall-paged');
    const composed = { ...perfect(x), quote: x.it.quotes[0]!.normalize('NFC') };
    expect(scoreEval(data, [composed]).overall.goldMatched).toBe(1);
    const changed = { ...perfect(x), quote: composed.quote.replace('Zoé', 'Zoe') };
    const r = scoreEval(data, [changed]).overall;
    expect(r.invalidCitations).toBe(1);
    expect(r.goldMatched).toBe(0);
  });

  it('a fonte 03 traz uma tabela em texto, e o gabarito cita uma linha dela', () => {
    const x = find('cost.network-tooling-rise');
    expect(x.it.quotes[0]!.startsWith('|')).toBe(true);
    expect(data.sources[x.source]!.split('\n').filter((l) => l.startsWith('|')).length).toBeGreaterThanOrEqual(4);
    expect(scoreEval(data, [perfect(x)]).overall.goldMatched).toBe(1);
    const noPipes = { ...perfect(x), quote: 'Network and tooling | $70,000 | $81,000' };
    expect(scoreEval(data, [noPipes]).overall.goldMatched).toBe(1); // cobre mais de 50% do trecho
    const wrong = { ...perfect(x), quote: '| Network and tooling | $70,000 | $82,000 |' };
    expect(scoreEval(data, [wrong]).overall.invalidCitations).toBe(1);
  });

  it('duplicatas previstas: só conta quando os dois lados do par foram acertados', () => {
    const a = find('pm.rollback-40min');
    const b = find('pm.latency-normal-40min');
    expect(scoreEval(data, [perfect(a)]).overall.duplicatePairsPredicted).toEqual([]);
    const both = scoreEval(data, [perfect(a), perfect(b)]);
    expect(both.overall.duplicatePairsPredicted).toEqual(['pm.latency-normal-40min=pm.rollback-40min']);
    expect(both.perSource[a.source]!.duplicatePairsPredicted).toEqual(['pm.latency-normal-40min=pm.rollback-40min']);
  });

  it('duplicatas previstas entre fontes diferentes aparecem só no total', () => {
    const a = find('arch.payload-2mb');
    const b = find('cost.payload-2048kb');
    const r = scoreEval(data, [perfect(a), perfect(b)]);
    expect(r.overall.duplicatePairsPredicted).toEqual(['arch.payload-2mb=cost.payload-2048kb']);
    expect(r.perSource[a.source]!.duplicatePairsPredicted).toEqual([]);
    expect(r.perSource[b.source]!.duplicatePairsPredicted).toEqual([]);
  });

  it('a previsão perfeita emite os dois pares conhecidos', () => {
    expect(scoreEval(data, perfectAll()).overall.duplicatePairsPredicted).toHaveLength(data.relations.duplicates.length);
  });

  it('comparação: "sem julgamento", excesso e duplicatas mudam mas não são regressão', () => {
    const x = find('arch.checkout-most-coupled');
    const y = find('pm.rollback-40min');
    const z = find('pm.latency-normal-40min');
    const before = makeReport('antes', scoreEval(data, [perfect(x), perfect(y)]));
    const unjudged: Prediction = { sourceId: x.source, type: 'claim', text: 'x', quote: 'Billing is the least coupled' };
    const more = [perfect(x), perfect(y), perfect(y), perfect(z), { ...unjudged, quote: 'Checkout is the' }];
    const after = makeReport('depois', scoreEval(data, more));
    const c = compare(before, after);
    const verdict = (n: string) => c.deltas.find((d) => d.name === n)!.verdict;
    expect(verdict('excesso de previsões')).toBe('mudou');
    expect(verdict('duplicatas conhecidas emitidas')).toBe('mudou');
    for (const name of ['sem julgamento', 'excesso de previsões', 'duplicatas conhecidas emitidas']) {
      expect(c.regressions).not.toContain(name);
    }
    expect(compareMarkdown(before, after)).toContain('mudou');
  });

  it('o Markdown do relatório lista as duplicatas conhecidas emitidas', () => {
    const md = toMarkdown(makeReport('p', scoreEval(data, perfectAll())));
    expect(md).toContain('pm.latency-normal-40min=pm.rollback-40min');
    expect(toMarkdown(makeReport('v', scoreEval(data, [])))).toContain('Duplicatas conhecidas emitidas (os dois lados): nenhum');
  });
});
