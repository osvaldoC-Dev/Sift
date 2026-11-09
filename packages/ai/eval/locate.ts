import { normalizeText } from '@sift/core';

/** Intervalo em code points Unicode, início inclusivo e fim exclusivo, sobre o texto NORMALIZADO. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Todas as ocorrências (inclusive sobrepostas) de `quote` em `source`, comparando como o núcleo:
 * texto normalizado (NFC, quebras de linha) e comparação literal. Espaço duro e hifenização NÃO são
 * corrigidos: uma citação que os "conserta" não existe na fonte.
 */
export function locate(source: string, quote: string): Span[] {
  const text = normalizeText(source);
  const q = normalizeText(quote);
  if (q === '') return [];
  const qLen = Array.from(q).length;
  const out: Span[] = [];
  let from = 0;
  for (;;) {
    const unit = text.indexOf(q, from);
    if (unit < 0) break;
    const start = Array.from(text.slice(0, unit)).length;
    out.push({ start, end: start + qLen });
    from = unit + 1;
  }
  return out;
}

/** Tamanho da interseção de dois intervalos (0 se disjuntos). */
export function overlap(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}
