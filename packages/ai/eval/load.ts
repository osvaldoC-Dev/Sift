import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalData, GoldRelations, GoldSource } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Carrega fontes e gabarito do disco. É o único lugar do conjunto que toca o sistema de arquivos. */
export function loadEval(root: string = HERE): EvalData {
  const goldDir = join(root, 'gold');
  const files = readdirSync(goldDir).filter((f) => f.endsWith('.json') && f !== 'relations.json').sort();
  const golds = files.map((f) => JSON.parse(readFileSync(join(goldDir, f), 'utf8')) as GoldSource);
  const relations = JSON.parse(readFileSync(join(goldDir, 'relations.json'), 'utf8')) as GoldRelations;
  const sources: Record<string, string> = {};
  for (const g of golds) sources[g.source] = readFileSync(join(root, g.file), 'utf8');
  return { golds, relations, sources };
}
