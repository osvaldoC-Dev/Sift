import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEval } from './load';
import type { EvalData, ItemType } from './types';

/**
 * Exportador do fixture do grafo (UI). Lê o gabarito (`eval/gold/*.json` + `relations.json`) e escreve
 * `eval/fixture-estado.json`. NÃO toca o núcleo nem o gabarito; é função pura sobre `EvalData` + um `main`.
 *
 * Formato:
 *  - items[]:     { id, type, source, text, quote }   id = chave do gabarito; text = paráfrase; quote = 1ª citação
 *  - relations[]: { from, to, kind, note }            kind = contradiction | near_miss | duplicate
 *                 duplicatas em cadeia: grupo [a,b,c] vira a-b e b-c
 *  - status e support: DADOS DE DEMONSTRAÇÃO, atribuídos por regra fixa (abaixo). Não vêm do gabarito.
 *
 * REGRA (determinística, sem relógio nem aleatoriedade), com i = posição do item em items[]:
 *  - status  = STATUS_CYCLE[type][i % 3]
 *  - support = SUPPORT_CYCLE[i % 4]
 * Ordem de items[]: fontes em ordem alfabética do arquivo, itens na ordem do gabarito.
 */

export type RelationKind = 'contradiction' | 'near_miss' | 'duplicate';
export type DemoSupport = 'full' | 'partial' | 'unchecked';

export const STATUS_CYCLE: Record<ItemType, readonly [string, string, string]> = {
  claim: ['provisional', 'active', 'provisional'],
  assumption: ['provisional', 'adopted', 'provisional'],
  decision: ['provisional', 'adopted', 'provisional'],
  question: ['open', 'closed', 'open'],
};
export const SUPPORT_CYCLE: readonly DemoSupport[] = ['full', 'full', 'partial', 'unchecked'];

export const DUPLICATE_NOTE = 'Mesmo fato dito duas vezes (grupo de duplicatas do gabarito).';
export const FIXTURE_WARNING =
  'DADOS DE DEMONSTRAÇÃO. `status` e `support` foram atribuídos por uma regra fixa (ciclo pelo índice do item), ' +
  'não por revisão nem por modelo. Itens, citações e relações vêm do gabarito sintético do eval.';

export interface FixtureItem {
  id: string;
  type: ItemType;
  source: string;
  text: string;
  quote: string;
  status: string;
  support: DemoSupport;
}
export interface FixtureRelation {
  from: string;
  to: string;
  kind: RelationKind;
  note: string;
}
export interface GraphFixture {
  _aviso: string;
  _regra: { status: string; support: string };
  items: FixtureItem[];
  relations: FixtureRelation[];
}

export function buildGraphFixture(data: EvalData): GraphFixture {
  const items: FixtureItem[] = [];
  for (const g of data.golds) {
    for (const it of g.items) {
      const i = items.length;
      const quote = it.quotes[0];
      if (quote === undefined) throw new Error(`item ${it.key} sem citação`);
      items.push({
        id: it.key, type: it.type, source: g.source, text: it.statement, quote,
        status: STATUS_CYCLE[it.type][i % 3]!, support: SUPPORT_CYCLE[i % SUPPORT_CYCLE.length]!,
      });
    }
  }
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) throw new Error(`id repetido: ${it.id}`);
    ids.add(it.id);
  }

  const relations: FixtureRelation[] = [];
  const add = (from: string, to: string, kind: RelationKind, note: string): void => {
    if (!ids.has(from)) throw new Error(`relação aponta para item inexistente: ${from}`);
    if (!ids.has(to)) throw new Error(`relação aponta para item inexistente: ${to}`);
    relations.push({ from, to, kind, note });
  };
  for (const p of data.relations.contradictions) add(p.a, p.b, 'contradiction', p.note);
  for (const p of data.relations.near_misses) add(p.a, p.b, 'near_miss', p.note);
  for (const group of data.relations.duplicates) {
    for (let k = 0; k + 1 < group.length; k++) add(group[k]!, group[k + 1]!, 'duplicate', DUPLICATE_NOTE);
  }

  return {
    _aviso: FIXTURE_WARNING,
    _regra: {
      status: 'STATUS_CYCLE[type][i % 3], i = posição do item em items[]',
      support: "['full','full','partial','unchecked'][i % 4], i = posição do item em items[]",
    },
    items,
    relations,
  };
}

/** Texto exato do arquivo: JSON com 2 espaços e uma quebra de linha final. */
export const renderFixture = (f: GraphFixture): string => `${JSON.stringify(f, null, 2)}\n`;

const HERE = dirname(fileURLToPath(import.meta.url));

export function exportGraphFixture(out: string = join(HERE, 'fixture-estado.json'), root?: string): string {
  const text = renderFixture(buildGraphFixture(loadEval(root)));
  writeFileSync(out, text, 'utf8');
  return text;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2];
  exportGraphFixture(out);
  console.log(`fixture escrito em ${out ?? join(HERE, 'fixture-estado.json')}`);
}
