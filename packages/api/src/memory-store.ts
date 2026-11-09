import {
  assertProjectSchema, type Change, type ChangeDraft, type ChangeId, type Clock, type Hash, type IdGenerator,
  type LogEntry as CoreLogEntry, type ProjectId, type ProjectSchema, type UserId, type Version,
} from '@sift/core';
// A implementação em memória embrulha o livro-razão de referência do núcleo. É o ÚNICO arquivo de `src` que toca
// `@sift/core/testing` (um teste de arquitetura impõe isso); o Postgres do 1b o substitui.
import { InMemoryLedger, type Outcome, type ReviewInput } from '@sift/core/testing';
import { researchV1 } from '@sift/schemas';
import { auditHash } from './audit';
import type { AuditEntry, AuditInput, ProjectStore, ProposalMeta, SourceRecord, Store } from './store';

export class MemoryProjectStore implements ProjectStore {
  readonly projectId: ProjectId;
  readonly schema: ProjectSchema;
  private readonly ledger: InMemoryLedger;
  private readonly clock: Clock;
  private readonly sources = new Map<string, SourceRecord>();
  private readonly byHash = new Map<Hash, SourceRecord>();
  private readonly metas = new Map<ChangeId, ProposalMeta>();
  private readonly trail: AuditEntry[] = [];

  constructor(opts: { projectId: string; schema: ProjectSchema; clock: Clock; ids: IdGenerator }) {
    this.projectId = opts.projectId as ProjectId;
    this.schema = opts.schema;
    this.clock = opts.clock;
    this.ledger = new InMemoryLedger({
      schema: opts.schema, projectId: this.projectId, clock: opts.clock, ids: opts.ids,
    });
  }

  async putContent(text: string): Promise<Hash> {
    return this.ledger.contents.add(text);
  }
  getContent(hash: Hash): Promise<string | undefined> {
    return this.ledger.contents.get(hash);
  }

  async saveSource(rec: SourceRecord): Promise<void> {
    this.sources.set(rec.id, { ...rec });
    this.byHash.set(rec.contentHash, { ...rec });
  }
  async getSource(id: string): Promise<SourceRecord | undefined> {
    const r = this.sources.get(id);
    return r ? { ...r } : undefined;
  }
  async sourceByHash(hash: Hash): Promise<SourceRecord | undefined> {
    const r = this.byHash.get(hash);
    return r ? { ...r } : undefined;
  }

  async state() {
    return this.ledger.state;
  }
  async entries(): Promise<readonly CoreLogEntry[]> {
    return [...this.ledger.log];
  }
  proposeChange(draft: ChangeDraft): Promise<Outcome> {
    return this.ledger.propose(draft);
  }
  submitHuman(draft: ChangeDraft): Promise<Outcome> {
    return this.ledger.submitHuman(draft);
  }
  review(input: ReviewInput): Promise<Outcome> {
    return this.ledger.review(input);
  }
  undo(version: Version, actor: UserId): Promise<Outcome> {
    return this.ledger.undo(version, actor);
  }
  async changes(): Promise<readonly Change[]> {
    return [...this.ledger.changes.values()];
  }
  async statusOf(changeId: ChangeId) {
    return this.ledger.statusOf(changeId);
  }
  async reviewEvents(changeId: ChangeId) {
    return this.ledger.reviews.filter((r) => r.changeId === changeId);
  }

  async saveMeta(changeId: ChangeId, meta: ProposalMeta): Promise<void> {
    this.metas.set(changeId, { ...meta });
  }
  async getMeta(changeId: ChangeId): Promise<ProposalMeta | undefined> {
    const m = this.metas.get(changeId);
    return m ? { ...m } : undefined;
  }

  async appendAudit(input: AuditInput): Promise<AuditEntry> {
    const prev = this.trail.length > 0 ? this.trail[this.trail.length - 1]!.hash : null;
    const base = { seq: this.trail.length + 1, action: input.action, targetId: input.targetId, at: this.clock.now() };
    const entry: AuditEntry = {
      ...base, prevHash: prev, hash: auditHash(prev, base),
      ...(input.coreVersion !== undefined ? { coreVersion: input.coreVersion } : {}),
    };
    this.trail.push(entry);
    return { ...entry };
  }
  async audit(): Promise<readonly AuditEntry[]> {
    return this.trail.map((e) => ({ ...e }));
  }
}

export interface MemoryStoreOptions {
  /** Projetos conhecidos. Qualquer outro id é `not_found` (a API não cria projetos). */
  projects: readonly string[];
  clock: Clock;
  ids: IdGenerator;
  /** Project Schema (padrão: research@1). */
  schema?: unknown;
}

export function createMemoryStore(opts: MemoryStoreOptions): Store {
  const schema = assertProjectSchema(opts.schema ?? researchV1);
  const map = new Map(
    opts.projects.map((id) => [id, new MemoryProjectStore({ projectId: id, schema, clock: opts.clock, ids: opts.ids })]),
  );
  return { project: async (id) => map.get(id) };
}
