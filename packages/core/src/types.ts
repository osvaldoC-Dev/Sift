// Tipos do núcleo. Nada aqui conhece um domínio (claim, decision, ...): isso vive no Project Schema.

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ProjectId = Brand<string, 'ProjectId'>;
export type ItemId = Brand<string, 'ItemId'>;
export type RelationId = Brand<string, 'RelationId'>;
export type ChangeId = Brand<string, 'ChangeId'>;
export type ChangeSetId = Brand<string, 'ChangeSetId'>;
export type RunId = Brand<string, 'RunId'>;
export type UserId = Brand<string, 'UserId'>;

export type Version = number;
export type Hash = string;
export type Impact = 'low' | 'medium' | 'high';
export type BasisKind = 'evidence' | 'justification_only' | 'none';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Attrs = { [key: string]: JsonValue };

export type Origin = { kind: 'human'; actorId: UserId } | { kind: 'agent'; runId: RunId };

export interface EvidenceRef {
  contentHash: Hash;
  start: number; // code points, inclusivo
  end: number; // code points, exclusivo
  quote: string;
}

export interface Justification {
  statement: string;
  basedOn: ItemId[];
}

export type Target = { kind: 'item'; id: ItemId } | { kind: 'relation'; id: RelationId };

export interface ItemFields {
  status: string;
  content: string;
  contentHash: Hash;
  attributes: Attrs;
}

interface OpBase {
  evidence: EvidenceRef[];
  justification?: Justification;
}

export type CreateItemOp = OpBase & {
  op: 'create_item';
  itemId: ItemId;
  type: string;
  status: string;
  content?: string;
  contentHash?: Hash;
  attributes: Attrs;
};
export type UpdateItemOp = OpBase & {
  op: 'update_item';
  itemId: ItemId;
  before: Partial<ItemFields>;
  patch: Partial<ItemFields>;
};
export type CreateRelationOp = OpBase & {
  op: 'create_relation';
  relationId: RelationId;
  type: string;
  from: ItemId;
  to: ItemId;
  attributes: Attrs;
};
export type RetireOp = OpBase & {
  op: 'retire';
  target: Target;
  retired: boolean; // false = reinstate (usado por desfazer)
  reason: string;
};
// Reservada, NÃO implementada no beta: set_schema.
export type Operation = CreateItemOp | UpdateItemOp | CreateRelationOp | RetireOp;

export interface SchemaRef {
  key: string;
  version: number;
}

export interface Change {
  id: ChangeId;
  projectId: ProjectId;
  changeSetId?: ChangeSetId;
  baseVersion: Version;
  schemaRef: SchemaRef;
  origin: Origin;
  rationale: string;
  operations: Operation[];
  impact: Impact; // derivado pelo core
  basisKind: BasisKind; // derivado pelo core
  compensates?: Version;
  idempotencyKey?: string;
  createdAt: string;
}
export type ChangeDraft = Omit<Change, 'impact' | 'basisKind'>;

export type Decision = 'accept' | 'accept_provisional' | 'accept_edited' | 'reject' | 'defer';
export type Reviewer =
  | { kind: 'human'; id: UserId }
  | { kind: 'system' }
  | { kind: 'policy'; id: string };
export type ChangeStatus =
  | 'proposed'
  | 'deferred'
  | 'stale'
  | 'accepted'
  | 'accepted_provisional'
  | 'accepted_edited'
  | 'rejected';

export interface ReviewEvent {
  id: string;
  changeId: ChangeId;
  decision: Decision | 'stale';
  reviewer: Reviewer;
  at: string;
  reason?: string;
  reasonCode?: string;
  editedOperations?: Operation[];
  appliedVersion?: Version;
  batch?: boolean;
}

export interface LogEntryBody {
  projectId: ProjectId;
  version: Version;
  changeId: ChangeId;
  origin: Origin;
  appliedOperations: Operation[];
  schemaRef: SchemaRef;
  appliedBy: Reviewer;
  appliedAt: string;
  baseVersion: Version;
  decision: Decision;
  appliedBasisKind: BasisKind;
}
export interface LogEntry extends LogEntryBody {
  prevHash: Hash;
  entryHash: Hash;
}

export interface Item {
  id: ItemId;
  type: string;
  status: string;
  content?: string;
  contentHash?: Hash;
  attributes: Attrs;
  origin: Origin;
  createdByChange: ChangeId;
  createdVersion: Version;
  lastVersion: Version;
  retired: boolean;
  evidence: EvidenceRef[];
}
export interface Relation {
  id: RelationId;
  type: string;
  from: ItemId;
  to: ItemId;
  attributes: Attrs;
  origin: Origin;
  createdByChange: ChangeId;
  createdVersion: Version;
  lastVersion: Version;
  retired: boolean;
  evidence: EvidenceRef[];
}
export interface State {
  version: Version;
  items: Map<ItemId, Item>;
  relations: Map<RelationId, Relation>;
}
