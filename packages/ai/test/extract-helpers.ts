import {
  assertProjectSchema, contentHash, emptyState, normalizeText,
  type Change, type ProjectId, type RunId,
} from '@sift/core';
import { researchV1 } from '@sift/schemas';
import { FakeModel, type FakeStep } from '../src/testing';
import {
  extractFromSource, type ExtractDeps, type ExtractInput, type ExtractResult,
} from '../src';
import { loadEval, type EvalData, type Prediction } from '../eval';

export const schema = assertProjectSchema(researchV1);
export const evalData: EvalData = loadEval();

export function makeDeps(steps: FakeStep[]): ExtractDeps & { model: FakeModel } {
  let n = 0;
  const model = new FakeModel(steps, { model: 'fake-extractor' });
  return { model, schema, ids: { next: () => `id${++n}` }, clock: { now: () => '2026-10-18T10:00:00Z' } };
}

export function inputFor(id: string, rawText: string, over: Partial<ExtractInput> = {}): ExtractInput {
  const text = normalizeText(rawText);
  return {
    runId: 'run-1' as RunId, projectId: 'p1' as ProjectId, baseVersion: 0,
    schemaRef: { key: 'research', version: 1 }, state: emptyState(),
    source: { id, label: id, contentHash: contentHash(text), text },
    ...over,
  };
}

export const goldInput = (sourceId: string, over: Partial<ExtractInput> = {}): ExtractInput =>
  inputFor(sourceId, evalData.sources[sourceId]!, over);

const ext = (items: { type: string; statement: string; quote: string }[]): FakeStep => ({ output: { items } });
const ver = (verdict: string): FakeStep => ({ output: { verdict } });
export { ext, ver };

/** Roteiro de um modelo PERFEITO para uma fonte do gabarito (uma passagem): extrai todos os itens, suporte full. */
export function perfectScript(sourceId: string): FakeStep[] {
  const g = evalData.golds.find((x) => x.source === sourceId)!;
  return [
    ext(g.items.map((i) => ({ type: i.type, statement: i.statement, quote: i.quotes[0]! }))),
    ...g.items.map((i) => ver(i.key === 'cost.network-tooling-rise' ? 'partial' : 'full')),
  ];
}

export async function run(steps: FakeStep[], input: ExtractInput): Promise<ExtractResult & { deps: ReturnType<typeof makeDeps> }> {
  const deps = makeDeps(steps);
  const r = await extractFromSource(deps, input);
  return Object.assign(r, { deps });
}

/** Changes mantidos viram previsões para o harness de pontuação do 3.1. */
export function toPredictions(sourceId: string, changes: Change[]): Prediction[] {
  return changes.map((c) => {
    const op = c.operations[0]!;
    if (op.op !== 'create_item') throw new Error('esperado create_item');
    const ev = op.evidence[0]!;
    return { sourceId, type: op.type as Prediction['type'], text: op.content ?? '', quote: ev.quote ?? '' };
  });
}
