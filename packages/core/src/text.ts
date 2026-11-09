import { sha256Hex } from './canonical';
import type { Hash } from './types';

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
