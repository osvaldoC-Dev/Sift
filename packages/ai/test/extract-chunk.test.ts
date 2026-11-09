import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeText } from '@sift/core';
import { chunkSource, DEFAULT_MAX_CHUNK_CHARS } from '../src';
import { locate } from '../eval';
import { evalData } from './extract-helpers';

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);
const slice = (s: string, a: number, b: number) => Array.from(s).slice(a, b).join('');

describe('chunkSource: recortes contíguos da fonte', () => {
  const P1 = 'Primeiro parágrafo curto.';
  const P2 = 'Segundo parágrafo, com 😀 emoji e acento é.';
  const P3 = 'Terceiro.';
  const text = `${P1}\n\n${P2}\n\n\n${P3}\n`;

  it('uma fonte curta é uma passagem só, com offset zero', () => {
    const c = chunkSource(text);
    expect(c).toHaveLength(1);
    expect(c[0]!.start).toBe(0);
    expect(c[0]!.text).toBe(slice(text, c[0]!.start, c[0]!.end));
  });

  it('corta só em quebra de parágrafo e cada passagem é exatamente slice(start, end) em code points', () => {
    const max = Array.from(`${P1}\n\n${P2}`).length;
    const c = chunkSource(text, max);
    expect(c.map((x) => x.text)).toEqual([`${P1}\n\n${P2}`, P3]);
    for (const x of c) expect(x.text).toBe(slice(text, x.start, x.end));
    expect(c[1]!.start).toBe(Array.from(`${P1}\n\n${P2}\n\n\n`).length);
  });

  it('offsets contam code points, não unidades UTF-16 (o emoji vale 1)', () => {
    const t = 'aaa\n\n😀😀😀 depois do emoji.';
    const c = chunkSource(t, 21);
    expect(c).toHaveLength(2);
    const second = c[1]!;
    expect(second.start).toBe(5);
    expect(slice(t, second.start, second.start + 3)).toBe('😀😀😀');
  });

  it('parágrafo grande: corta no fim de frase e a última frase se repete na passagem seguinte', () => {
    const t = 'Alfa um. Beta dois. Gama tres. Delta quatro. Epsilon cinco.';
    const c = chunkSource(t, 28);
    expect(c.length).toBeGreaterThan(1);
    for (const x of c) {
      expect(x.text.length).toBeLessThanOrEqual(28);
      expect(/[.]$/.test(x.text)).toBe(true); // termina em fim de frase
      expect(x.text).toBe(slice(t, x.start, x.end));
    }
    for (let i = 1; i < c.length; i++) {
      const lastSentence = c[i - 1]!.text.split(/(?<=\.)\s+/).pop()!;
      expect(c[i]!.text.startsWith(lastSentence)).toBe(true); // uma frase de sobreposição
    }
    expect(c[c.length - 1]!.end).toBe(Array.from(t).length);
  });

  it('sempre progride (frase maior que o limite é cortada, nunca trava)', () => {
    const t = 'x'.repeat(100);
    const c = chunkSource(t, 30);
    expect(c.map((x) => x.text.length)).toEqual([30, 30, 30, 10]);
  });

  it('texto vazio ou só espaços não gera passagem', () => {
    expect(chunkSource('')).toEqual([]);
    expect(chunkSource('  \n\n \n')).toEqual([]);
  });

  it('rejeita limite inválido', () => {
    expect(() => chunkSource('a', 0)).toThrow();
    expect(() => chunkSource('a', 1.5)).toThrow();
  });

  it('propriedade: passagens são recortes fiéis, em ordem, e cobrem todo caractere não branco', () => {
    const piece = fc.constantFrom('Ola mundo.', 'Isto e um teste!', 'Pergunta?', '😀 emoji.', 'sem ponto', 'é acento.');
    const para = fc.array(piece, { minLength: 1, maxLength: 6 });
    fc.assert(
      fc.property(fc.array(para, { minLength: 1, maxLength: 6 }), fc.integer({ min: 5, max: 80 }), (paras, max) => {
        const t = paras.map((p) => p.join(' ')).join('\n\n');
        const cps = Array.from(t);
        const chunks = chunkSource(t, max);
        const covered = new Array<boolean>(cps.length).fill(false);
        let lastStart = -1;
        for (const c of chunks) {
          if (c.text !== slice(t, c.start, c.end)) return false;
          if (c.start < lastStart) return false;
          lastStart = c.start;
          for (let i = c.start; i < c.end; i++) covered[i] = true;
        }
        return cps.every((ch, i) => /\s/.test(ch) || covered[i]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('chunkSource sobre o gabarito: nenhuma citação do gabarito cruza a fronteira de uma passagem', () => {
  const quotesOf = (id: string) => {
    const g = evalData.golds.find((x) => x.source === id)!;
    return [...g.items.flatMap((i) => i.quotes), ...g.traps.flatMap((t) => t.quotes), ...g.injections.map((i) => i.quote)];
  };
  for (const limit of [DEFAULT_MAX_CHUNK_CHARS, 1200, 700]) {
    for (const g of evalData.golds) {
      it(`${g.source} com limite ${limit}`, () => {
        const text = normalizeText(evalData.sources[g.source]!);
        const chunks = chunkSource(text, limit);
        for (const q of quotesOf(g.source)) {
          for (const span of locate(text, q)) {
            const inside = chunks.some((c) => span.start >= c.start && span.end <= c.end);
            expect(inside, `${q.slice(0, 50)}… cruza fronteira`).toBe(true);
          }
        }
      });
    }
  }

  it('com o limite padrão, cada fonte do gabarito cabe numa passagem só', () => {
    for (const g of evalData.golds) expect(chunkSource(normalizeText(evalData.sources[g.source]!))).toHaveLength(1);
  });
});
