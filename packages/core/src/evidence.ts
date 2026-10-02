import { sha256Hex } from './canonical';
import type { ContentReader } from './ports';
import type { EvidenceRef, Hash, Operation } from './types';

/** Normalização do texto de conteúdo: sem BOM, \r\n e \r viram \n, NFC. */
export function normalizeText(s: string): string {
  return s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC');
}

/** Hash de um texto JÁ normalizado. */
export function contentHash(normalized: string): Hash {
  return sha256Hex(normalized);
}

/** Recorte por code points Unicode: início inclusivo, fim exclusivo. */
export function sliceCodePoints(text: string, start: number, end: number): string | undefined {
  const cps = Array.from(text);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if (start < 0 || end > cps.length || start >= end) return undefined;
  return cps.slice(start, end).join('');
}

export type FidelityReason = 'content_missing' | 'out_of_range' | 'text_mismatch' | 'quote_length';
export interface FidelityFailure {
  opIndex: number;
  evidenceIndex: number;
  reason: FidelityReason;
  ref: EvidenceRef;
}
export interface EvidenceLimits {
  minQuote: number;
  maxQuote: number;
}
export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = { minQuote: 5, maxQuote: 2000 };

/**
 * Verificação MECÂNICA: o trecho citado existe, exatamente, na versão imutável da fonte.
 * Prova existência, não que o trecho sustenta a afirmação.
 */
export async function verifyEvidence(
  ops: Operation[],
  reader: ContentReader,
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
): Promise<FidelityFailure[]> {
  const failures: FidelityFailure[] = [];
  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const evidence = ops[opIndex]!.evidence;
    for (let evidenceIndex = 0; evidenceIndex < evidence.length; evidenceIndex++) {
      const ref = evidence[evidenceIndex]!;
      const fail = (reason: FidelityReason) =>
        failures.push({ opIndex, evidenceIndex, reason, ref });
      const qlen = Array.from(ref.quote).length;
      if (qlen < limits.minQuote || qlen > limits.maxQuote) {
        fail('quote_length');
        continue;
      }
      const body = await reader.get(ref.contentHash);
      if (body === undefined) {
        fail('content_missing');
        continue;
      }
      const slice = sliceCodePoints(body, ref.start, ref.end);
      if (slice === undefined) {
        fail('out_of_range');
        continue;
      }
      if (slice !== ref.quote) fail('text_mismatch');
    }
  }
  return failures;
}
