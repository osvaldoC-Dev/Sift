import { canonicalize, sha256Hex } from './canonical';
import type { Hash, State } from './types';

export function emptyState(): State {
  return { version: 0, items: new Map(), relations: new Map() };
}

export function cloneState(s: State): State {
  return { version: s.version, items: new Map(s.items), relations: new Map(s.relations) };
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Hash canônico do estado, usado para provar que projeção == reconstrução. */
export function stateHash(s: State): Hash {
  return sha256Hex(
    canonicalize({
      version: s.version,
      items: [...s.items.values()].sort(byId),
      relations: [...s.relations.values()].sort(byId),
    }),
  );
}
