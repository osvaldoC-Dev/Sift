import type {
  Change, ChangeDraft, ChangeId, ChangeStatus, Hash, LogEntry as CoreLogEntry, ProjectId, ProjectSchema,
  ReviewEvent, State, UserId, Version,
} from '@sift/core';
import type { Outcome, ReviewInput } from '@sift/core/testing';
import type { LogEntry as LogEntryView } from '@sift/contract';

export type { Outcome, ReviewInput };

/** Fonte capturada. O texto vive no armazém de conteúdo, indexado pelo hash do núcleo. */
export interface SourceRecord {
  id: string;
  name: string;
  contentHash: Hash;
  /** Guardados sem entrar em lógica (critério 10). */
  originType: 'human' | 'ai';
  originLabel?: string;
  /** Execução de IA de origem (só `originType = ai`). */
  originRunId?: string;
  capturedAt?: string;
  createdAt: string;
}

/** O que a API sabe de uma proposta e o núcleo não (o relatório da execução não entra no log). */
export interface ProposalMeta {
  runId: string;
  sourceId: string;
  /** Referência local do pipeline (`c0.1`). */
  ref: string;
  verifierFailed: boolean;
}

export type AuditAction = LogEntryView['action'];
export interface AuditInput {
  action: AuditAction;
  targetId: string;
  /** Versão do núcleo gravada por esta ação, quando houve aplicação. Não vai ao cliente. */
  coreVersion?: Version;
}
export interface AuditEntry extends LogEntryView {
  coreVersion?: Version;
}

/**
 * Tudo o que a API precisa de UM projeto. É a fronteira para o Postgres do marco 1b: a mesma suíte de testes da API
 * corre contra qualquer implementação (ver `test/store-factory.ts`). Cada método é uma unidade que o Postgres faz
 * numa transação; a API serializa as escritas de um projeto (`ProjectLock`), mas a atomicidade entre o núcleo e a
 * auditoria é responsabilidade da implementação durável.
 */
export interface ProjectStore {
  readonly projectId: ProjectId;
  readonly schema: ProjectSchema;

  // conteúdo (instantâneos imutáveis de fonte)
  /** Normaliza (NFC), guarda e devolve o hash do núcleo. */
  putContent(text: string): Promise<Hash>;
  getContent(hash: Hash): Promise<string | undefined>;

  // fontes
  saveSource(rec: SourceRecord): Promise<void>;
  getSource(id: string): Promise<SourceRecord | undefined>;
  sourceByHash(hash: Hash): Promise<SourceRecord | undefined>;

  // livro-razão (núcleo)
  state(): Promise<State>;
  entries(): Promise<readonly CoreLogEntry[]>;
  proposeChange(draft: ChangeDraft): Promise<Outcome>;
  submitHuman(draft: ChangeDraft): Promise<Outcome>;
  review(input: ReviewInput): Promise<Outcome>;
  undo(version: Version, actor: UserId): Promise<Outcome>;
  changes(): Promise<readonly Change[]>;
  statusOf(changeId: ChangeId): Promise<ChangeStatus>;
  reviewEvents(changeId: ChangeId): Promise<readonly ReviewEvent[]>;

  // metadados de proposta
  saveMeta(changeId: ChangeId, meta: ProposalMeta): Promise<void>;
  getMeta(changeId: ChangeId): Promise<ProposalMeta | undefined>;

  // auditoria (cadeia da API)
  appendAudit(input: AuditInput): Promise<AuditEntry>;
  audit(): Promise<readonly AuditEntry[]>;
}

export interface Store {
  /** undefined = projeto desconhecido (a API responde `not_found`). */
  project(projectId: string): Promise<ProjectStore | undefined>;
}
