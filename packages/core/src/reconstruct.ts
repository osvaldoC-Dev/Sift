import { applyOperations } from './apply';
import { verifyChain } from './log';
import { emptyState } from './state';
import type { LogEntry, State } from './types';

export class ReconstructError extends Error {}

/** O estado atual é uma dobra determinística do log: sem relógio, sem aleatoriedade. */
export function reconstruct(entries: Iterable<LogEntry>, opts: { verify?: boolean } = {}): State {
  const list = [...entries];
  if (opts.verify !== false) {
    const r = verifyChain(list);
    if (!r.ok) throw new ReconstructError(`cadeia inválida na versão ${r.version}: ${r.reason}`);
  }
  let state = emptyState();
  for (const e of list) {
    if (e.version !== state.version + 1) {
      throw new ReconstructError(`versão fora de sequência: esperado ${state.version + 1}, veio ${e.version}`);
    }
    state = applyOperations(state, e.appliedOperations, {
      version: e.version,
      changeId: e.changeId,
      origin: e.origin,
    }).state;
  }
  return state;
}
