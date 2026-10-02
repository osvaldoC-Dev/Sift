import { targetKey } from './stale';
import type {
  ChangeDraft, ChangeId, LogEntry, Operation, ProjectId, SchemaRef, State, Target, UserId,
} from './types';

export type CompensateResult =
  | { ok: true; draft: ChangeDraft }
  | { ok: false; conflicts: Target[] };

export interface CompensateCtx {
  changeId: ChangeId;
  projectId: ProjectId;
  schemaRef: SchemaRef;
  actor: UserId;
  now: string;
}

/**
 * Desfazer = um NOVO change compensatório (o histórico nunca é reescrito). Só é possível se
 * nenhuma versão posterior tocou os mesmos alvos; caso contrário devolve os conflitos.
 */
export function compensate(entry: LogEntry, state: State, ctx: CompensateCtx): CompensateResult {
  const targets = new Map<string, Target>();
  for (const op of entry.appliedOperations) {
    const t: Target =
      op.op === 'create_item' ? { kind: 'item', id: op.itemId }
      : op.op === 'update_item' ? { kind: 'item', id: op.itemId }
      : op.op === 'create_relation' ? { kind: 'relation', id: op.relationId }
      : op.target;
    targets.set(targetKey(t), t);
  }
  const conflicts: Target[] = [];
  for (const t of targets.values()) {
    const el = t.kind === 'item' ? state.items.get(t.id) : state.relations.get(t.id);
    if (!el || el.lastVersion > entry.version) conflicts.push(t);
  }
  if (conflicts.length > 0) return { ok: false, conflicts };

  const reason = `Desfaz a versão ${entry.version}`;
  const ops: Operation[] = [];
  for (const op of [...entry.appliedOperations].reverse()) {
    switch (op.op) {
      case 'create_item':
        ops.push({ op: 'retire', target: { kind: 'item', id: op.itemId }, retired: true, reason, evidence: [] });
        break;
      case 'create_relation':
        ops.push({ op: 'retire', target: { kind: 'relation', id: op.relationId }, retired: true, reason, evidence: [] });
        break;
      case 'update_item':
        ops.push({
          op: 'update_item', itemId: op.itemId, before: op.patch, patch: op.before, evidence: [],
          justification: { statement: reason, basedOn: [] },
        });
        break;
      case 'retire':
        ops.push({ op: 'retire', target: op.target, retired: !op.retired, reason, evidence: [] });
        break;
    }
  }
  return {
    ok: true,
    draft: {
      id: ctx.changeId,
      projectId: ctx.projectId,
      baseVersion: state.version,
      schemaRef: ctx.schemaRef,
      origin: { kind: 'human', actorId: ctx.actor },
      rationale: reason,
      operations: ops,
      compensates: entry.version,
      createdAt: ctx.now,
    },
  };
}
