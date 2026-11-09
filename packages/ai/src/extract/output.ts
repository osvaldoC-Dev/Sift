import type { JsonValue } from '@sift/core';
import { ITEM_TYPES, VERDICTS, type ExtractedType, type VerifierVerdict } from './prompt';

/**
 * Validação ESTRITA da saída do modelo, escrita à mão (o pacote ai não depende de zod).
 *  - forma da saída inteira errada (não é objeto, chaves a mais ou a menos, `items` não é lista):
 *    a execução inteira é descartada (`schema_invalid`);
 *  - um item inválido (não é objeto, tipo fora da lista, texto vazio, QUALQUER campo a mais — id, start,
 *    end... — ): só esse item é descartado (`malformed_item`). Lista vazia é válida.
 */

export interface ParsedItem {
  type: ExtractedType;
  statement: string;
  quote: string;
}
export type ParsedExtraction =
  | { ok: true; items: { index: number; item: ParsedItem }[]; malformed: { index: number; detail: string }[] }
  | { ok: false; detail: string };

const isObj = (v: JsonValue | undefined): v is { [k: string]: JsonValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function sameKeys(o: object, keys: string[]): string | undefined {
  const got = Object.keys(o).sort();
  const want = [...keys].sort();
  if (got.length === want.length && got.every((k, i) => k === want[i])) return undefined;
  const extra = got.filter((k) => !want.includes(k));
  const missing = want.filter((k) => !got.includes(k));
  return [extra.length ? `campos a mais: ${extra.join(', ')}` : '', missing.length ? `faltam: ${missing.join(', ')}` : '']
    .filter(Boolean)
    .join('; ');
}

export function parseExtraction(output: JsonValue): ParsedExtraction {
  if (!isObj(output)) return { ok: false, detail: 'a saída não é um objeto' };
  const shape = sameKeys(output, ['items']);
  if (shape !== undefined) return { ok: false, detail: `saída com forma errada (${shape})` };
  const list = output.items;
  if (!Array.isArray(list)) return { ok: false, detail: '`items` não é uma lista' };

  const items: { index: number; item: ParsedItem }[] = [];
  const malformed: { index: number; detail: string }[] = [];
  list.forEach((raw, index) => {
    if (!isObj(raw)) return void malformed.push({ index, detail: 'o item não é um objeto' });
    const bad = sameKeys(raw, ['type', 'statement', 'quote']);
    if (bad !== undefined) return void malformed.push({ index, detail: bad });
    const { type, statement, quote } = raw;
    if (typeof type !== 'string' || !(ITEM_TYPES as readonly string[]).includes(type)) {
      return void malformed.push({ index, detail: 'tipo fora da lista' });
    }
    if (typeof statement !== 'string' || statement.trim() === '') return void malformed.push({ index, detail: 'statement vazio ou não texto' });
    if (typeof quote !== 'string' || quote.trim() === '') return void malformed.push({ index, detail: 'quote vazia ou não texto' });
    items.push({ index, item: { type: type as ExtractedType, statement, quote } });
  });
  return { ok: true, items, malformed };
}

export type ParsedVerdict = { ok: true; verdict: VerifierVerdict } | { ok: false; detail: string };

export function parseVerdict(output: JsonValue): ParsedVerdict {
  if (!isObj(output)) return { ok: false, detail: 'a saída do verificador não é um objeto' };
  const bad = sameKeys(output, ['verdict']);
  if (bad !== undefined) return { ok: false, detail: `verificador com forma errada (${bad})` };
  const v = output.verdict;
  if (typeof v !== 'string' || !(VERDICTS as readonly string[]).includes(v)) return { ok: false, detail: 'veredito fora da lista' };
  return { ok: true, verdict: v as VerifierVerdict };
}
