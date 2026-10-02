import type { Change, Operation, State, Target, Version } from './types';

export interface StaleReason {
  kind: 'target_changed' | 'target_missing';
  target: Target;
  lastVersion?: Version;
  baseVersion: Version;
}

export const targetKey = (t: Target): string => `${t.kind}:${t.id}`;

/**
 * Alvos que o change lê ou altera de itens/relações já existentes: atualizados, aposentados e
 * extremos de relações. O que é criado dentro do próprio change não conta.
 */
export function touchedTargets(ops: Operation[]): Target[] {
  const created = new Set<string>();
  const out = new Map<string, Target>();
  const add = (t: Target) => {
    const k = targetKey(t);
    if (!created.has(k) && !out.has(k)) out.set(k, t);
  };
  for (const op of ops) {
    switch (op.op) {
      case 'create_item':
        created.add(targetKey({ kind: 'item', id: op.itemId }));
        break;
      case 'update_item':
        add({ kind: 'item', id: op.itemId });
        break;
      case 'create_relation':
        created.add(targetKey({ kind: 'relation', id: op.relationId }));
        add({ kind: 'item', id: op.from });
        add({ kind: 'item', id: op.to });
        break;
      case 'retire':
        add(op.target);
        break;
    }
  }
  return [...out.values()];
}

/**
 * Um change é stale se algum alvo tocado mudou depois da versão-base. Ter a base diferente do
 * head não basta: só conta se um alvo tocado mudou.
 */
export function staleReasons(change: Pick<Change, 'operations' | 'baseVersion'>, state: State): StaleReason[] {
  const reasons: StaleReason[] = [];
  for (const target of touchedTargets(change.operations)) {
    const el = target.kind === 'item' ? state.items.get(target.id) : state.relations.get(target.id);
    if (!el) {
      reasons.push({ kind: 'target_missing', target, baseVersion: change.baseVersion });
    } else if (el.lastVersion > change.baseVersion) {
      reasons.push({
        kind: 'target_changed',
        target,
        lastVersion: el.lastVersion,
        baseVersion: change.baseVersion,
      });
    }
  }
  return reasons;
}
