import { FakeModel, type FakeStep } from '@sift/ai/testing';
import { createApi, type Api, type ApiDeps, type ApiResponse, type LogEvent, type Store } from '../src';
import { makeStore } from './store-factory';

export const PROJECT = 'p1';
export const TEXT = 'Alpha is true here.\n\nBeta is also true here.\n\nIs Gamma ready?';

export const ext = (items: { type: string; statement: string; quote: string }[]): FakeStep => ({ output: { items } });
export const ver = (verdict: string): FakeStep => ({ output: { verdict } });

export const claim = { type: 'claim', statement: 'Alpha is true.', quote: 'Alpha is true here.' };
export const claim2 = { type: 'claim', statement: 'Beta is also true.', quote: 'Beta is also true here.' };
export const question = { type: 'question', statement: 'Is Gamma ready?', quote: 'Is Gamma ready?' };
export const decision = { type: 'decision', statement: 'Ship Alpha first.', quote: 'Alpha is true here.' };

export interface Harness {
  api: Api;
  store: Store;
  model: FakeModel;
  logs: LogEvent[];
  call(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<ApiResponse>;
}

export function harness(
  steps: FakeStep[] = [], over: Partial<ApiDeps> = {}, wrap?: (s: Store) => Store, schema?: unknown,
): Harness {
  let n = 0;
  let t = 0;
  const ids = { next: () => `id${++n}` };
  const clock = { now: () => new Date(Date.UTC(2026, 10, 7, 12, 0, ++t)).toISOString() };
  const base = makeStore({ projects: [PROJECT], clock, ids, ...(schema !== undefined ? { schema } : {}) });
  const store = wrap ? wrap(base) : base;
  const model = new FakeModel(steps, { model: 'fake-extractor' });
  const logs: LogEvent[] = [];
  const api = createApi({ store, model, clock, ids, logger: (e) => logs.push(e), ...over });
  return {
    api, store, model, logs,
    call: (method, path, body, query) =>
      api.handle({ method, path, ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) }),
  };
}

export const capture = async (h: Harness, text = TEXT, name = 'ata.txt'): Promise<string> => {
  const r = await h.call('POST', `/projects/${PROJECT}/sources`, { name, text });
  if (r.status !== 201) throw new Error(`captura falhou: ${JSON.stringify(r.body)}`);
  return (r.body as { source: { id: string } }).source.id;
};

export const extract = (h: Harness, sourceId: string) =>
  h.call('POST', `/projects/${PROJECT}/extractions`, { sourceId });

export const proposalsOf = async (h: Harness, status?: string) =>
  (await h.call('GET', `/projects/${PROJECT}/proposals`, undefined, status ? { status } : undefined)).body as {
    id: string; type: string; status: string; canAccept: unknown; canBatchAccept: unknown; quote: { found: number; start: number | null };
    support: string; verifierFailed: boolean; stale: boolean; provisional: boolean; edited: boolean; text: string;
  }[];
