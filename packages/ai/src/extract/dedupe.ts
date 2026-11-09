/**
 * Duplicata = mesmo tipo + cobertura de citação >= DEDUPE_COVERAGE NOS DOIS SENTIDOS (a interseção cobre pelo
 * menos 90% de cada trecho). Valor inicial, constante nomeada (docs/OPEN-DECISIONS.md, seção 5).
 * Tipos diferentes nunca se fundem, mesmo com a mesma citação.
 */
export const DEDUPE_COVERAGE = 0.9;

export interface Span {
  start: number;
  end: number;
}
export interface DedupeKey {
  type: string;
  contentHash: string;
  span: Span;
}

export function coverageBothWays(a: Span, b: Span, min: number = DEDUPE_COVERAGE): boolean {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const la = a.end - a.start;
  const lb = b.end - b.start;
  if (la <= 0 || lb <= 0) return false;
  return inter / la >= min && inter / lb >= min;
}

export function isDuplicate(a: DedupeKey, b: DedupeKey): boolean {
  return a.type === b.type && a.contentHash === b.contentHash && coverageBothWays(a.span, b.span);
}
