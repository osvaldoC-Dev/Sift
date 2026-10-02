import { cloneState } from './state';
import type {
  ChangeId, Item, ItemId, Operation, Origin, Relation, RelationId, State, Target, Version,
} from './types';

export class InvariantError extends Error {}

export interface ApplyMeta {
  version: Version;
  changeId: ChangeId;
  origin: Origin;
}

/**
 * Aplicação mecânica de uma operação. NÃO consulta o schema (por isso a reconstrução do log é
 * independente do schema). A validação acontece antes, em validate.ts.
 */
export function applyInto(
  items: Map<ItemId, Item>,
  relations: Map<RelationId, Relation>,
  op: Operation,
  meta: ApplyMeta,
  touched?: Target[],
): void {
  switch (op.op) {
    case 'create_item': {
      if (items.has(op.itemId)) throw new InvariantError(`item já existe: ${op.itemId}`);
      items.set(op.itemId, {
        id: op.itemId,
        type: op.type,
        status: op.status,
        content: op.content,
        contentHash: op.contentHash,
        attributes: op.attributes,
        origin: meta.origin,
        createdByChange: meta.changeId,
        createdVersion: meta.version,
        lastVersion: meta.version,
        retired: false,
        evidence: [...op.evidence],
      });
      touched?.push({ kind: 'item', id: op.itemId });
      return;
    }
    case 'update_item': {
      const cur = items.get(op.itemId);
      if (!cur) throw new InvariantError(`item inexistente: ${op.itemId}`);
      const next: Item = { ...cur, lastVersion: meta.version, evidence: [...cur.evidence, ...op.evidence] };
      if (op.patch.status !== undefined) next.status = op.patch.status;
      if (op.patch.content !== undefined) next.content = op.patch.content;
      if (op.patch.contentHash !== undefined) next.contentHash = op.patch.contentHash;
      if (op.patch.attributes !== undefined) next.attributes = op.patch.attributes;
      items.set(op.itemId, next);
      touched?.push({ kind: 'item', id: op.itemId });
      return;
    }
    case 'create_relation': {
      if (relations.has(op.relationId)) throw new InvariantError(`relação já existe: ${op.relationId}`);
      if (!items.has(op.from) || !items.has(op.to)) throw new InvariantError('extremo inexistente');
      relations.set(op.relationId, {
        id: op.relationId,
        type: op.type,
        from: op.from,
        to: op.to,
        attributes: op.attributes,
        origin: meta.origin,
        createdByChange: meta.changeId,
        createdVersion: meta.version,
        lastVersion: meta.version,
        retired: false,
        evidence: [...op.evidence],
      });
      touched?.push({ kind: 'relation', id: op.relationId });
      return;
    }
    case 'retire': {
      if (op.target.kind === 'item') {
        const cur = items.get(op.target.id);
        if (!cur) throw new InvariantError(`item inexistente: ${op.target.id}`);
        items.set(op.target.id, {
          ...cur,
          retired: op.retired,
          lastVersion: meta.version,
          evidence: [...cur.evidence, ...op.evidence],
        });
      } else {
        const cur = relations.get(op.target.id);
        if (!cur) throw new InvariantError(`relação inexistente: ${op.target.id}`);
        relations.set(op.target.id, {
          ...cur,
          retired: op.retired,
          lastVersion: meta.version,
          evidence: [...cur.evidence, ...op.evidence],
        });
      }
      touched?.push(op.target);
      return;
    }
  }
}

export function applyOperations(
  state: State,
  ops: Operation[],
  meta: ApplyMeta,
): { state: State; touched: Target[] } {
  const next = cloneState(state);
  const touched: Target[] = [];
  for (const op of ops) applyInto(next.items, next.relations, op, meta, touched);
  next.version = meta.version;
  const seen = new Set<string>();
  const unique = touched.filter((t) => {
    const k = `${t.kind}:${t.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { state: next, touched: unique };
}
