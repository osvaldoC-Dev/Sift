import { normalizeText } from '../evidence';
import type {
  Attrs, ChangeDraft, ChangeId, EvidenceRef, ItemFields, ItemId, Justification, Operation,
  Origin, ProjectId, RelationId, RunId, UserId,
} from '../types';
import type { InMemoryContents } from './contents';
import type { InMemoryLedger } from './ledger';

export const human = (id = 'u1'): Origin => ({ kind: 'human', actorId: id as UserId });
export const agent = (id = 'run1'): Origin => ({ kind: 'agent', runId: id as RunId });
export const iid = (s: string) => s as ItemId;
export const rid = (s: string) => s as RelationId;

export function createItem(p: {
  id: string; type: string; status: string; content?: string; contentHash?: string;
  attributes?: Attrs; evidence?: EvidenceRef[]; justification?: Justification;
}): Operation {
  return {
    op: 'create_item', itemId: iid(p.id), type: p.type, status: p.status,
    content: p.content, contentHash: p.contentHash,
    attributes: p.attributes ?? {}, evidence: p.evidence ?? [], justification: p.justification,
  };
}

export function updateItem(p: {
  id: string; before: Partial<ItemFields>; patch: Partial<ItemFields>;
  evidence?: EvidenceRef[]; justification?: Justification;
}): Operation {
  return {
    op: 'update_item', itemId: iid(p.id), before: p.before, patch: p.patch,
    evidence: p.evidence ?? [], justification: p.justification,
  };
}

export function createRelation(p: {
  id: string; type: string; from: string; to: string; attributes?: Attrs;
  evidence?: EvidenceRef[]; justification?: Justification;
}): Operation {
  return {
    op: 'create_relation', relationId: rid(p.id), type: p.type, from: iid(p.from), to: iid(p.to),
    attributes: p.attributes ?? {}, evidence: p.evidence ?? [], justification: p.justification,
  };
}

export function retire(p: {
  item?: string; relation?: string; retired?: boolean; reason?: string;
  evidence?: EvidenceRef[]; justification?: Justification;
}): Operation {
  const target = p.item !== undefined
    ? ({ kind: 'item', id: iid(p.item) } as const)
    : ({ kind: 'relation', id: rid(p.relation!) } as const);
  return {
    op: 'retire', target, retired: p.retired ?? true, reason: p.reason ?? 'motivo de teste',
    evidence: p.evidence ?? [], justification: p.justification,
  };
}

export function just(statement: string, ...basedOn: string[]): Justification {
  return { statement, basedOn: basedOn.map(iid) };
}

/** Registra o texto no armazém e devolve a evidência de um trecho exato (offsets em code points). */
export function evidenceFor(contents: InMemoryContents, text: string, quote: string): EvidenceRef {
  const hash = contents.add(text);
  const normalized = normalizeText(text);
  const idx = normalized.indexOf(normalizeText(quote));
  if (idx < 0) throw new Error(`trecho não encontrado: ${quote}`);
  const start = Array.from(normalized.slice(0, idx)).length;
  const end = start + Array.from(normalizeText(quote)).length;
  return { contentHash: hash, start, end, quote: normalizeText(quote) };
}

export function draftOf(
  l: InMemoryLedger,
  p: { origin: Origin; ops: Operation[]; base?: number; rationale?: string; idempotencyKey?: string },
): ChangeDraft {
  return {
    id: l.nextId<ChangeId>(),
    projectId: l.deps.projectId as ProjectId,
    baseVersion: p.base ?? l.head,
    schemaRef: { key: l.deps.schema.key, version: l.deps.schema.version },
    origin: p.origin,
    rationale: p.rationale ?? 'justificativa de teste',
    operations: p.ops,
    idempotencyKey: p.idempotencyKey,
    createdAt: l.deps.clock.now(),
  };
}
