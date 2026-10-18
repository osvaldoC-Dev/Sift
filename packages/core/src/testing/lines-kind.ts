import { contentHash, normalizeText } from '../text';
import type { EvidenceLimits, FidelityReason, SourceKind } from '../source';
import type { LocatedEvidence, Locator } from '../types';
import type { InMemoryContents } from './contents';

/**
 * Kind de fonte SÓ DE TESTE: conteúdo em linhas numeradas (como um arquivo de código). Prova que o contrato de
 * fonte não está preso a texto corrido: o localizador é `{ startLine, endLine }` (1-based, inclusivo) e a
 * citação é o texto dessas linhas, unidas por "\n". Não faz parte do produto.
 */
const lineRange = (ref: LocatedEvidence): { s: number; e: number } | undefined => {
  const s = ref.locator['startLine'];
  const e = ref.locator['endLine'];
  if (typeof s !== 'number' || typeof e !== 'number') return undefined;
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s) return undefined;
  return { s, e };
};

export const LINES_KIND: SourceKind = {
  kind: 'lines',
  hashOf: (content) => contentHash(content),
  locate(content, quote) {
    const lines = content.split('\n');
    const want = quote.split('\n');
    const out: Locator[] = [];
    if (quote === '') return out;
    for (let i = 0; i + want.length <= lines.length; i++) {
      if (want.every((w, k) => lines[i + k] === w)) out.push({ startLine: i + 1, endLine: i + want.length });
    }
    return out;
  },
  checkShape(ref) {
    const r = ref as LocatedEvidence;
    if (lineRange(r) === undefined) return 'localizador de linhas malformado';
    return typeof r.quote === 'string' && r.quote.length > 0 ? undefined : 'a evidência de linhas exige citação';
  },
  check(ref, limits: EvidenceLimits): FidelityReason | undefined {
    const r = ref as LocatedEvidence;
    if (lineRange(r) === undefined) return 'locator_invalid';
    const qlen = Array.from(r.quote ?? '').length;
    return qlen < limits.minQuote || qlen > limits.maxQuote ? 'quote_length' : undefined;
  },
  verify(ref, content) {
    const r = ref as LocatedEvidence;
    const range = lineRange(r)!;
    const lines = content.split('\n');
    if (range.e > lines.length) return 'out_of_range';
    return lines.slice(range.s - 1, range.e).join('\n') !== r.quote ? 'text_mismatch' : undefined;
  },
};

/** Evidência de linhas para um texto (registrado no armazém), com a citação tirada do próprio texto. */
export function linesEvidence(
  contents: InMemoryContents,
  text: string,
  startLine: number,
  endLine: number,
): LocatedEvidence {
  const lines = normalizeText(text).split('\n');
  return {
    kind: 'lines',
    contentHash: contents.add(text),
    locator: { startLine, endLine },
    quote: lines.slice(startLine - 1, endLine).join('\n'),
  };
}
