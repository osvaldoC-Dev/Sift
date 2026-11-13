import {
  TEXT_KIND, resolveKind, staleReasons,
  type Change, type ChangeStatus, type EvidenceRef, type Operation, type ProjectSchema, type ReviewEvent, type State,
  type SupportVerdict,
} from '@sift/core';
import type { ProposalView } from '@sift/contract';
import { eligibility, isPending } from './eligibility';
import type { ProjectStore, ProposalMeta } from './store';

/** Proposta que o contrato não sabe representar (só create_item/create_relation com 1+ evidência de texto). */
export class UnsupportedProposal extends Error {}

const VIEW_TYPES = ['claim', 'assumption', 'question', 'decision'] as const;
type ViewType = (typeof VIEW_TYPES)[number];
const isViewType = (t: string): t is ViewType => (VIEW_TYPES as readonly string[]).includes(t);

const WEAKNESS: SupportVerdict[] = ['none', 'unchecked', 'partial', 'full'];
export const weakest = (evidence: readonly EvidenceRef[]): SupportVerdict => {
  if (evidence.length === 0) return 'unchecked';
  let w = 3;
  for (const e of evidence) w = Math.min(w, WEAKNESS.indexOf(e.supportVerdict ?? 'unchecked'));
  return WEAKNESS[w]!;
};

export function viewStatus(s: ChangeStatus): ProposalView['status'] {
  if (s === 'rejected') return 'rejected';
  if (isPending(s)) return 'pending';
  return 'accepted';
}

export interface ViewInput {
  schema: ProjectSchema;
  state: State;
  change: Change;
  status: ChangeStatus;
  events: readonly ReviewEvent[];
  meta: ProposalMeta | undefined;
  /** Fonte a que a citação se refere: id e texto exato guardado. */
  source: { id: string; text: string };
  /** A decisão foi desfeita (compensada). O núcleo não tem estado "desfeita": a API a mostra como `rejected`. */
  undone?: boolean;
}

const DECIDED = { ok: false, code: 'already_decided' } as const;

/** Operações que valem agora: as editadas pela pessoa (já reconciliadas pelo núcleo), se houve `accept_edited`. */
export function effectiveOperations(change: Change, events: readonly ReviewEvent[]): Operation[] {
  const edit = [...events].reverse().find((e) => e.decision === 'accept_edited' && e.editedOperations !== undefined);
  return edit?.editedOperations ?? change.operations;
}

/** Monta a ProposalView. `quote.found/start/end` vêm de `SourceKind.locate` do núcleo; nenhuma busca própria. */
export function buildProposalView(i: ViewInput): ProposalView {
  const ops = effectiveOperations(i.change, i.events);
  const op = ops[0];
  if (op === undefined || (op.op !== 'create_item' && op.op !== 'create_relation')) {
    throw new UnsupportedProposal('só propostas create_item/create_relation são representáveis');
  }
  const ev = op.evidence[0];
  if (ev === undefined || ev.quote === undefined || ev.quote === '') {
    throw new UnsupportedProposal('proposta sem citação não é representável');
  }
  const kind = resolveKind(ev, new Map([[TEXT_KIND.kind, TEXT_KIND]]));
  if (kind === undefined) throw new UnsupportedProposal('tipo de fonte sem verificador de texto');
  const where = kind.locate(i.source.text, ev.quote);
  const first = where[0] as { start: number; end: number } | undefined;

  let type: ProposalView['type'];
  let text: string;
  let createdStatus: string | undefined;
  if (op.op === 'create_item') {
    if (!isViewType(op.type)) throw new UnsupportedProposal(`tipo de item fora do contrato: ${op.type}`);
    type = op.type;
    text = op.content ?? '';
    createdStatus = op.status;
  } else {
    type = 'relation';
    text = i.change.rationale;
  }
  const support = weakest(ops.flatMap((o) => o.evidence));
  const typeDef = op.op === 'create_item' && Object.hasOwn(i.schema.itemTypes, op.type) ? i.schema.itemTypes[op.type] : undefined;
  const stale = i.status === 'stale' || (isPending(i.status) && staleReasons(i.change, i.state).length > 0);
  const undone = i.undone === true;
  // Desfeita = fora de vigor e fechada: nada mais se decide sobre ela (OPEN-DECISIONS: não há estado "desfeita" no contrato).
  const elig = undone
    ? { canAccept: DECIDED, canReject: DECIDED, canBatchAccept: DECIDED }
    : eligibility({
      schema: i.schema, state: i.state, change: i.change, status: i.status, found: where.length, support,
    });

  const view: ProposalView = {
    id: i.change.id,
    type,
    text,
    quote: {
      text: ev.quote, sourceId: i.source.id, found: where.length,
      start: first ? first.start : null, end: first ? first.end : null,
    },
    support,
    status: undone ? 'rejected' : viewStatus(i.status),
    provisional: typeDef?.provisionalStatus !== undefined && createdStatus === typeDef.provisionalStatus,
    edited: i.status === 'accepted_edited',
    verifierFailed: i.meta?.verifierFailed ?? false,
    stale: undone ? false : stale,
    runId: i.change.origin.kind === 'agent' ? i.change.origin.runId : (i.meta?.runId ?? ''),
    originType: i.change.origin.kind === 'agent' ? 'ai' : 'human',
    ...(i.change.origin.kind === 'agent' ? { originLabel: i.change.origin.model } : {}),
    canAccept: elig.canAccept, canReject: elig.canReject, canBatchAccept: elig.canBatchAccept,
  };
  return view;
}

/** Propostas da API = changes de agente. Os changes humanos (captura, desfazer) não são propostas. */
/** Ids das propostas cuja decisão já foi desfeita (o histórico de auditoria é a fonte, nada é apagado). */
export async function undoneIds(ps: ProjectStore): Promise<Set<string>> {
  return new Set((await ps.audit()).filter((a) => a.action === 'undo').map((a) => a.targetId));
}

export async function loadProposalView(ps: ProjectStore, change: Change, undone?: Set<string>): Promise<ProposalView> {
  const [state, status, events, meta, gone] = await Promise.all([
    ps.state(), ps.statusOf(change.id), ps.reviewEvents(change.id), ps.getMeta(change.id), undone ?? undoneIds(ps),
  ]);
  const ops = effectiveOperations(change, events);
  const hash = ops[0]?.evidence[0]?.contentHash;
  const src = hash === undefined ? undefined : await ps.sourceByHash(hash);
  const text = hash === undefined ? undefined : await ps.getContent(hash);
  if (src === undefined || text === undefined) throw new UnsupportedProposal('fonte da citação não encontrada');
  return buildProposalView({
    schema: ps.schema, state, change, status, events, meta, source: { id: src.id, text }, undone: gone.has(change.id),
  });
}

export async function listProposalViews(ps: ProjectStore, filter?: ProposalView['status']): Promise<ProposalView[]> {
  const out: ProposalView[] = [];
  const gone = await undoneIds(ps);
  for (const change of await ps.changes()) {
    if (change.origin.kind !== 'agent') continue;
    const v = await loadProposalView(ps, change, gone);
    if (filter === undefined || v.status === filter) out.push(v);
  }
  return out;
}
