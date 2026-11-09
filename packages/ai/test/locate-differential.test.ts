import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TEXT_KIND, normalizeText } from '@sift/core';
import { loadEval, locate } from '../eval';

/**
 * TESTE DIFERENCIAL: o `locate` do eval (oráculo da pontuação, indexOf + conversão de unidades) e o `locate` do kind
 * `text` do núcleo (varredura por code points) são implementações INDEPENDENTES do mesmo contrato. Têm de
 * concordar em todas as citações do gabarito e num corpus de propriedade. Unificá-los tiraria da pontuação
 * o oráculo independente: por isso este teste existe em vez de um import.
 */

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);
const coreSpans = (source: string, quote: string) =>
  TEXT_KIND.locate(normalizeText(source), normalizeText(quote)).map((l) => ({ start: l['start'] as number, end: l['end'] as number }));

describe('locate: eval e núcleo concordam', () => {
  const data = loadEval();

  it('em todas as citações do gabarito (itens, armadilhas e injeções), fonte por fonte', () => {
    let checked = 0;
    for (const g of data.golds) {
      const text = data.sources[g.source]!;
      const quotes = [...g.items.flatMap((i) => i.quotes), ...g.traps.flatMap((t) => t.quotes), ...g.injections.map((j) => j.quote)];
      for (const q of quotes) {
        expect(coreSpans(text, q), `${g.source}: ${q}`).toEqual(locate(text, q));
        expect(locate(text, q).length, q).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(50);
  });

  it('em citações que NÃO existem (hifenização consertada, espaço duro trocado): ambos devolvem vazio', () => {
    const text = data.sources[data.golds[0]!.source]!;
    for (const q of ['hidden dependencies between checkout', 'median payload between checkout and billing is 2 MB']) {
      expect(coreSpans(text, q)).toEqual(locate(text, q));
    }
    const pm = data.sources[data.golds[1]!.source]!;
    const typed = 'After the split, p95 checkout latency rose from 410 ms to 484 ms.'; // espaços comuns, não duros
    expect(locate(pm, typed)).toEqual([]);
    expect(coreSpans(pm, typed)).toEqual([]);
  });

  it('ocorrências sobrepostas e nos extremos: ambos as acham todas', () => {
    for (const [source, quote, n] of [['aaaa', 'aaa', 2], ['abab', 'ab', 2], ['😀😀😀', '😀😀', 2], ['x', 'x', 1], ['xyz', 'xyz', 1]] as const) {
      expect(locate(source, quote)).toHaveLength(n);
      expect(coreSpans(source, quote)).toEqual(locate(source, quote));
    }
  });

  it('num corpus de propriedade (emoji, acento combinante, CRLF, espaço duro, repetições)', () => {
    const tokens = ['a', 'b', 'ab', 'é', 'é', '😀', '\r\n', '\n', ' ', ' ', '-', 'x'];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...tokens), { minLength: 4, maxLength: 40 }),
        fc.array(fc.constantFrom(...tokens), { minLength: 0, maxLength: 5 }),
        fc.nat(30),
        fc.boolean(),
        (parts: string[], qparts: string[], offset: number, fromText: boolean) => {
          const source = parts.join('');
          const cps = Array.from(normalizeText(source));
          const start = cps.length === 0 ? 0 : offset % cps.length;
          const quote = fromText ? cps.slice(start, start + 1 + (offset % 4)).join('') : qparts.join('');
          expect(coreSpans(source, quote)).toEqual(locate(source, quote));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
