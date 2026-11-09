/**
 * Divisão da fonte em passagens (chunks). Regras (3.2):
 *  - corta só em quebra de parágrafo (linha em branco);
 *  - um parágrafo maior que o limite é cortado no fim de uma frase, e a frase final de cada passagem se repete
 *    como primeira da seguinte (uma frase de sobreposição);
 *  - cada passagem é um recorte CONTÍGUO da fonte, em code points: `text === slice(source, start, end)`.
 *    Por isso `start` é o deslocamento que o pipeline soma ao índice achado DENTRO da passagem.
 * Um único trecho com mais de `maxChars` sem fim de frase é cortado em `maxChars` (último recurso): aí uma
 * citação pode cruzar a fronteira, e ela será descartada como inválida, nunca remendada.
 */

export const DEFAULT_MAX_CHUNK_CHARS = 6000;

export interface Chunk {
  index: number;
  /** Code points, inclusivo, relativo à fonte inteira. */
  start: number;
  /** Code points, exclusivo. */
  end: number;
  text: string;
}

interface Span {
  start: number;
  end: number;
}

const isNl = (c: string | undefined): boolean => c === '\n';
const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t';

/** Parágrafos: trechos separados por uma ou mais linhas em branco. Só o conteúdo, sem os separadores. */
function paragraphs(cps: string[]): Span[] {
  const out: Span[] = [];
  let start = -1;
  let i = 0;
  while (i < cps.length) {
    if (isNl(cps[i])) {
      // fim de linha: é quebra de parágrafo se, pulando espaços, vier outra quebra de linha
      let j = i + 1;
      while (isBlank(cps[j])) j++;
      if (isNl(cps[j])) {
        if (start >= 0) out.push({ start, end: i });
        start = -1;
        while (j < cps.length && (isNl(cps[j]) || isBlank(cps[j]))) j++;
        i = j;
        continue;
      }
    }
    if (start < 0 && !isNl(cps[i]) && !isBlank(cps[i])) start = i;
    i++;
  }
  if (start >= 0) {
    let end = cps.length;
    while (end > start && (isNl(cps[end - 1]) || isBlank(cps[end - 1]))) end--;
    out.push({ start, end });
  }
  return out;
}

/** Frases de um parágrafo: terminam em . ! ? (seguido de espaço, quebra de linha ou fim). */
function sentences(cps: string[], p: Span): Span[] {
  const out: Span[] = [];
  let start = p.start;
  for (let i = p.start; i < p.end; i++) {
    const c = cps[i];
    if ((c === '.' || c === '!' || c === '?') && (i + 1 >= p.end || isBlank(cps[i + 1]) || isNl(cps[i + 1]))) {
      out.push({ start, end: i + 1 });
      let j = i + 1;
      while (j < p.end && (isBlank(cps[j]) || isNl(cps[j]))) j++;
      start = j;
      i = j - 1;
    }
  }
  if (start < p.end) out.push({ start, end: p.end });
  return out;
}

/** Corte duro de um trecho sem fim de frase que não cabe: pedaços de `max` code points. */
function hardCut(s: Span, max: number): Span[] {
  const out: Span[] = [];
  for (let a = s.start; a < s.end; a += max) out.push({ start: a, end: Math.min(a + max, s.end) });
  return out;
}

export function chunkSource(text: string, maxChars: number = DEFAULT_MAX_CHUNK_CHARS): Chunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars deve ser um inteiro positivo');
  const cps = Array.from(text);
  const spans: Span[] = [];

  let cur: Span | undefined;
  const flush = (): void => {
    if (cur) spans.push(cur);
    cur = undefined;
  };

  for (const para of paragraphs(cps)) {
    if (para.end - para.start <= maxChars) {
      if (cur && para.end - cur.start <= maxChars) cur = { start: cur.start, end: para.end };
      else {
        flush();
        cur = { ...para };
      }
      continue;
    }
    // parágrafo grande: fecha a passagem em curso e corta por frases, com uma frase de sobreposição
    flush();
    const units = sentences(cps, para).flatMap((s) => (s.end - s.start > maxChars ? hardCut(s, maxChars) : [s]));
    let from = 0;
    while (from < units.length) {
      let to = from; // índice da última unidade incluída
      while (to + 1 < units.length && units[to + 1]!.end - units[from]!.start <= maxChars) to++;
      spans.push({ start: units[from]!.start, end: units[to]!.end });
      if (to + 1 >= units.length) break;
      // sobreposição: a última frase desta passagem abre a próxima, desde que haja progresso
      from = to > from ? to : to + 1;
    }
  }
  flush();

  return spans.map((s, index) => ({ index, start: s.start, end: s.end, text: cps.slice(s.start, s.end).join('') }));
}
