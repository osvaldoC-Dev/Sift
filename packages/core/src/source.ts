import { contentHash, sliceCodePoints } from './text';
import type { EvidenceRef, Hash, Locator, TextEvidence } from './types';

/**
 * Contrato de fonte (Marco 3.2a). Cada KIND de fonte sabe verificar, mecanicamente, que um trecho existe
 * dentro do conteúdo imutável (snapshot) a que a evidência se refere. O núcleo não conhece o formato do
 * conteúdo: quem conhece é o kind. Hoje só existe o kind `text`.
 *
 * Verificar prova EXISTÊNCIA do trecho, nunca que ele sustenta a afirmação (isso é o `supportVerdict`).
 */

export type FidelityReason =
  | 'content_missing' | 'hash_mismatch' | 'out_of_range' | 'text_mismatch' | 'quote_length'
  | 'unknown_kind' | 'locator_invalid';

export interface EvidenceLimits {
  minQuote: number;
  maxQuote: number;
}
export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = { minQuote: 5, maxQuote: 2000 };

export interface SourceKind {
  readonly kind: string;
  /**
   * Hash do conteúdo EXATAMENTE como o armazém o guarda (para texto: o texto já normalizado). O verificador
   * confere que o que o armazém devolveu é o snapshot que a evidência cita (`hash_mismatch`).
   */
  hashOf(content: string): Hash;
  /**
   * Forma da evidência DESTE kind (usada na validação da proposta, antes de qualquer conteúdo). Devolve a
   * mensagem do problema, ou undefined. O formato do hash (comum a todos) é conferido fora do kind.
   */
  checkShape(ref: EvidenceRef): string | undefined;
  /** Checagem que não precisa do conteúdo (localizador e tamanho). Devolve a razão da recusa, ou undefined. */
  check(ref: EvidenceRef, limits: EvidenceLimits): FidelityReason | undefined;
  /**
   * Onde `quote` aparece em `content`: todas as ocorrências (inclusive sobrepostas), em ordem, como localizadores
   * do kind. `content` e `quote` chegam JÁ normalizados por quem chama. Comparação literal: nada é "consertado".
   */
  locate(content: string, quote: string): Locator[];
  /** O trecho existe neste conteúdo? Devolve a razão da recusa, ou undefined. */
  verify(ref: EvidenceRef, content: string): FidelityReason | undefined;
}

/** Kind `text`: offsets em code points, citação idêntica ao recorte. É a forma canônica de hoje (sem campo `kind`). */
export const TEXT_KIND: SourceKind = {
  kind: 'text',
  hashOf: (content) => contentHash(content),
  locate(content, quote) {
    // Varredura por code points, de propósito diferente de indexOf + conversão de unidades UTF-16:
    // o `eval/locate.ts` é o oráculo independente e um teste diferencial exige que os dois concordem.
    const hay = Array.from(content);
    const needle = Array.from(quote);
    const out: Locator[] = [];
    if (needle.length === 0) return out;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      let j = 0;
      while (j < needle.length && hay[i + j] === needle[j]) j++;
      if (j === needle.length) out.push({ start: i, end: i + needle.length });
    }
    return out;
  },
  checkShape(ref) {
    const t = ref as TextEvidence;
    const ok =
      Number.isInteger(t.start) && Number.isInteger(t.end) && t.start >= 0 && t.end > t.start &&
      typeof t.quote === 'string' && t.quote.length > 0;
    return ok ? undefined : 'evidência malformada';
  },
  check(ref, limits) {
    const qlen = Array.from((ref as TextEvidence).quote).length;
    return qlen < limits.minQuote || qlen > limits.maxQuote ? 'quote_length' : undefined;
  },
  verify(ref, content) {
    const t = ref as TextEvidence;
    const slice = sliceCodePoints(content, t.start, t.end);
    if (slice === undefined) return 'out_of_range';
    return slice !== t.quote ? 'text_mismatch' : undefined;
  },
};

export type SourceKinds = ReadonlyMap<string, SourceKind>;
export const DEFAULT_SOURCE_KINDS: SourceKinds = new Map([[TEXT_KIND.kind, TEXT_KIND]]);

/**
 * Qual kind verifica esta evidência. Sem campo `kind` = texto. `kind: 'text'` escrito explicitamente NÃO resolve
 * (recusado na validação; aqui também, por defesa): só existe uma forma canônica da evidência de texto.
 */
export function resolveKind(ref: EvidenceRef, kinds: SourceKinds): SourceKind | undefined {
  if (ref.kind === undefined) return kinds.get(TEXT_KIND.kind);
  if (ref.kind === TEXT_KIND.kind) return undefined;
  return kinds.get(ref.kind);
}
