import { applyOperations } from '../apply';
import { compensate } from '../compensate';
import type { Clock, ContentReader, IdGenerator } from '../ports';
import { reconstruct } from '../reconstruct';
import { verifyEvidence, type FidelityFailure } from '../evidence';
import { GENESIS_HASH, sealEntry } from '../log';
import { checkDecision, deriveStatus, type DecisionIssue } from '../review';
import type { ProjectSchema } from '../schema';
import { staleReasons, touchedTargets, targetKey, type StaleReason } from '../stale';
import { emptyState } from '../state';
import { analyzeChange, prepareChange, type Analysis, type Issue } from '../validate';
import type {
  Change, ChangeDraft, ChangeId, ChangeStatus, Decision, LogEntry, Operation, ProjectId,
  ReviewEvent, Reviewer, State, Target, UserId, Version,
} from '../types';
import { InMemoryContents } from './contents';

export type Outcome =
  | { ok: true; applied: true; version: Version; entry: LogEntry }
  | { ok: true; applied: false; status: ChangeStatus; change?: Change }
  | {
      ok: false;
      code:
        | 'unknown_change' | 'not_pending' | 'stale' | 'conflict' | 'invalid'
        | 'decision_not_allowed' | 'fidelity' | 'undo_conflict' | 'wrong_origin';
      issues?: Issue[];
      decisionIssues?: DecisionIssue[];
      reasons?: StaleReason[];
      failures?: FidelityFailure[];
      conflicts?: Target[];
    };

export interface ReviewInput {
  changeId: ChangeId;
  decision: Decision;
  reviewer: Reviewer;
  batch?: boolean;
  editedOperations?: Operation[];
  reason?: string;
  reasonCode?: string;
}

export interface LedgerDeps {
  schema: ProjectSchema;
  projectId: ProjectId;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * Livro-razão em memória: especificação executável do que o `db` fará numa transação
 * (propostas imutáveis + eventos de revisão + log aplicado + projeção). Serve para testar as
 * invariantes do core antes de existir banco.
 */
export class InMemoryLedger implements ContentReader {
  readonly deps: LedgerDeps;
  readonly contents = new InMemoryContents();
  readonly log: LogEntry[] = [];
  readonly changes = new Map<ChangeId, Change>();
  readonly reviews: ReviewEvent[] = [];
  state: State = emptyState();
  private readonly idem = new Map<string, Outcome>();

  constructor(deps: LedgerDeps) {
    this.deps = deps;
  }

  get(hash: string): Promise<string | undefined> {
    return this.contents.get(hash);
  }
  nextId<T extends string>(): T {
    return this.deps.ids.next() as T;
  }
  get head(): Version {
    return this.state.version;
  }
  statusOf(changeId: ChangeId): ChangeStatus {
    return deriveStatus(this.reviews.filter((r) => r.changeId === changeId));
  }
  stateAt(version: Version): State {
    return reconstruct(this.log.slice(0, version));
  }

  private pushEvent(e: Omit<ReviewEvent, 'id' | 'at'>): void {
    this.reviews.push({ ...e, id: this.deps.ids.next(), at: this.deps.clock.now() });
  }
  private markStale(changeId: ChangeId): void {
    this.pushEvent({ changeId, decision: 'stale', reviewer: { kind: 'system' } });
  }

  /** Proposta de agente: validada contra o snapshot da versão-base e com evidência verificada. */
  async propose(draft: ChangeDraft): Promise<Outcome> {
    if (draft.origin.kind !== 'agent') return { ok: false, code: 'wrong_origin' };
    if (!Number.isInteger(draft.baseVersion) || draft.baseVersion < 0 || draft.baseVersion > this.head) {
      return { ok: false, code: 'invalid', issues: [{ code: 'base_version_invalid', message: 'baseVersion inválida' }] };
    }
    const base = this.stateAt(draft.baseVersion);
    const prep = prepareChange(this.deps.schema, base, draft);
    if (prep.issues.length > 0) return { ok: false, code: 'invalid', issues: prep.issues };
    const failures = await verifyEvidence(prep.change.operations, this);
    if (failures.length > 0) return { ok: false, code: 'fidelity', failures };
    this.changes.set(prep.change.id, prep.change);
    if (staleReasons(prep.change, this.state).length > 0) this.markStale(prep.change.id);
    return { ok: true, applied: false, status: this.statusOf(prep.change.id), change: prep.change };
  }

  async review(input: ReviewInput): Promise<Outcome> {
    const change = this.changes.get(input.changeId);
    if (!change) return { ok: false, code: 'unknown_change' };
    const status = this.statusOf(change.id);
    if (status === 'stale' && input.decision !== 'reject') {
      return { ok: false, code: 'stale', reasons: staleReasons(change, this.state) };
    }
    if (status !== 'proposed' && status !== 'deferred' && status !== 'stale') {
      return { ok: false, code: 'not_pending' };
    }
    if (input.reviewer.kind !== 'human') {
      return {
        ok: false, code: 'decision_not_allowed',
        decisionIssues: [{ code: 'reviewer_must_be_human', message: 'a decisão exige revisor humano' }],
      };
    }
    if (input.decision === 'reject' || input.decision === 'defer') {
      this.pushEvent({
        changeId: change.id, decision: input.decision, reviewer: input.reviewer,
        reason: input.reason, reasonCode: input.reasonCode,
      });
      return { ok: true, applied: false, status: this.statusOf(change.id) };
    }
    const edited = input.decision === 'accept_edited';
    if (edited !== (input.editedOperations !== undefined)) {
      return {
        ok: false, code: 'decision_not_allowed',
        decisionIssues: [{
          code: edited ? 'edited_operations_required' : 'unexpected_edited_operations',
          message: 'operações editadas inconsistentes com a decisão',
        }],
      };
    }
    const ops = edited ? input.editedOperations! : change.operations;
    return this.applyAccepted(change, ops, input.decision, input.reviewer, input.batch ?? false, edited);
  }

  /** Mudança humana: mesmo caminho de escrita; aceita na hora, com conflito otimista (D3). */
  async submitHuman(draft: ChangeDraft): Promise<Outcome> {
    if (draft.origin.kind !== 'human') return { ok: false, code: 'wrong_origin' };
    if (draft.idempotencyKey !== undefined) {
      const prev = this.idem.get(draft.idempotencyKey);
      if (prev) return prev;
    }
    const prep = prepareChange(this.deps.schema, this.state, draft);
    let outcome: Outcome;
    const stale = staleReasons(prep.change, this.state);
    if (stale.length > 0) {
      outcome = { ok: false, code: 'conflict', reasons: stale };
    } else if (prep.issues.length > 0) {
      outcome = { ok: false, code: 'invalid', issues: prep.issues };
    } else {
      const failures = await verifyEvidence(prep.change.operations, this);
      if (failures.length > 0) {
        outcome = { ok: false, code: 'fidelity', failures };
      } else {
        const reviewer: Reviewer = { kind: 'human', id: draft.origin.actorId };
        outcome = this.commit(prep.change, prep.analysis, prep.change.operations, 'accept', reviewer, false);
      }
    }
    if (draft.idempotencyKey !== undefined) this.idem.set(draft.idempotencyKey, outcome);
    return outcome;
  }

  async undo(version: Version, actor: UserId): Promise<Outcome> {
    const entry = this.log[version - 1];
    if (!entry) return { ok: false, code: 'unknown_change' };
    const res = compensate(entry, this.state, {
      changeId: this.nextId<ChangeId>(),
      projectId: this.deps.projectId,
      schemaRef: { key: this.deps.schema.key, version: this.deps.schema.version },
      actor,
      now: this.deps.clock.now(),
    });
    if (!res.ok) return { ok: false, code: 'undo_conflict', conflicts: res.conflicts };
    return this.submitHuman(res.draft);
  }

  private async applyAccepted(
    change: Change, ops: Operation[], decision: Decision, reviewer: Reviewer, batch: boolean, edited: boolean,
  ): Promise<Outcome> {
    const effective: Change = { ...change, operations: ops };
    const stale = staleReasons(effective, this.state);
    if (stale.length > 0) {
      if (this.statusOf(change.id) !== 'stale') this.markStale(change.id);
      return { ok: false, code: 'stale', reasons: stale };
    }
    const analysis: Analysis = analyzeChange(this.deps.schema, this.state, effective);
    if (analysis.issues.length > 0) return { ok: false, code: 'invalid', issues: analysis.issues };
    const di = checkDecision(this.deps.schema, {
      decision, reviewer, batch, edited, change, analysis, effectiveOperations: ops,
    });
    if (di.length > 0) return { ok: false, code: 'decision_not_allowed', decisionIssues: di };
    if (edited) {
      const failures = await verifyEvidence(ops, this);
      if (failures.length > 0) return { ok: false, code: 'fidelity', failures };
    }
    return this.commit(change, analysis, ops, decision, reviewer, batch);
  }

  /** O equivalente da transação "aceitar": versão nova + review + log + projeção + invalidação. */
  private commit(
    change: Change, analysis: Analysis, ops: Operation[], decision: Decision, reviewer: Reviewer, batch: boolean,
  ): Outcome {
    const version = this.state.version + 1;
    const { state, touched } = applyOperations(this.state, ops, {
      version, changeId: change.id, origin: change.origin,
    });
    const prevHash = this.log.length > 0 ? this.log[this.log.length - 1]!.entryHash : GENESIS_HASH;
    const entry = sealEntry(prevHash, {
      projectId: this.deps.projectId,
      version,
      changeId: change.id,
      origin: change.origin,
      appliedOperations: ops,
      schemaRef: change.schemaRef,
      appliedBy: reviewer,
      appliedAt: this.deps.clock.now(),
      baseVersion: change.baseVersion,
      decision,
      appliedBasisKind: analysis.basisKind,
    });
    this.log.push(entry);
    this.state = state;
    if (!this.changes.has(change.id)) this.changes.set(change.id, change);
    this.pushEvent({
      changeId: change.id, decision, reviewer, appliedVersion: version, batch,
      editedOperations: decision === 'accept_edited' ? ops : undefined,
    });
    // Invalidação na escrita: pendentes cujos alvos foram tocados viram stale (origem sistema).
    const touchedKeys = new Set(touched.map(targetKey));
    for (const [id, other] of this.changes) {
      if (id === change.id) continue;
      const st = this.statusOf(id);
      if (st !== 'proposed' && st !== 'deferred') continue;
      if (touchedTargets(other.operations).some((t) => touchedKeys.has(targetKey(t)))) this.markStale(id);
    }
    return { ok: true, applied: true, version, entry };
  }
}
