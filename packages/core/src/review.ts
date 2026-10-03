import type { ProjectSchema } from './schema';
import type { Analysis } from './validate';
import type { Change, ChangeStatus, Decision, ReviewEvent, Reviewer, State } from './types';

/** Máquina de estados da proposta. undefined = transição inválida. */
export function nextStatus(current: ChangeStatus, decision: Decision | 'stale'): ChangeStatus | undefined {
  if (current === 'proposed' || current === 'deferred') {
    switch (decision) {
      case 'accept': return 'accepted';
      case 'accept_provisional': return 'accepted_provisional';
      case 'accept_edited': return 'accepted_edited';
      case 'reject': return 'rejected';
      case 'defer': return 'deferred';
      case 'stale': return 'stale';
    }
  }
  if (current === 'stale') {
    if (decision === 'reject') return 'rejected'; // dispensar
    if (decision === 'stale') return 'stale';
  }
  return undefined;
}

/** O status é derivado dos eventos de revisão; a proposta em si nunca muda. */
export function deriveStatus(events: readonly ReviewEvent[]): ChangeStatus {
  let status: ChangeStatus = 'proposed';
  for (const e of events) {
    const next = nextStatus(status, e.decision);
    if (next === undefined) throw new Error(`transição inválida: ${status} + ${e.decision}`);
    status = next;
  }
  return status;
}

export type DecisionIssueCode =
  | 'reviewer_must_be_human'
  | 'accept_provisional_invalid'
  | 'batch_not_eligible'
  | 'edited_operations_required'
  | 'unexpected_edited_operations';
export interface DecisionIssue {
  code: DecisionIssueCode;
  message: string;
}

/**
 * Elegível a revisão em lote: origem agente, impacto em batchEligibleImpact, sem transição
 * explícita e NÃO sustentado só por justificativa.
 */
export function isBatchEligible(schema: ProjectSchema, change: Pick<Change, 'origin'>, analysis: Analysis): boolean {
  return (
    change.origin.kind === 'agent' &&
    schema.review.batchEligibleImpact.includes(analysis.impact) &&
    analysis.basisKind !== 'justification_only' &&
    analysis.explicitTransitions.length === 0
  );
}

/**
 * accept_provisional (usado na inicialização do projeto): uma decisão leve sobre uma visão geral.
 * Só vale se NADA no change cria compromisso. Devolve o motivo da recusa, ou undefined se vale:
 *  - só create_item e create_relation, origem agente, sem promoções nem transições explícitas;
 *  - NÃO pode ser sustentado só por justificativa (justification_only exige revisão individual);
 *  - create_item de tipo COM provisionalStatus: o status criado tem de ser o provisório;
 *  - create_item de tipo SEM provisionalStatus (ex.: pergunta): permitido, porque o schema declara
 *    que esse tipo não tem distinção provisório/compromisso. As regras de criação por origem e de
 *    basis continuam valendo (a validação roda antes);
 *  - create_relation de tipo com impacto alto NÃO entra (exige accept individual);
 *  - create_relation só vale se os DOIS extremos forem criados no mesmo change, ou itens existentes
 *    ainda provisórios, ou de tipo sem provisionalStatus. Ligar algo provisório a um item já adotado
 *    (compromisso) exige revisão individual.
 */
function acceptProvisionalProblem(schema: ProjectSchema, input: DecisionInput): string | undefined {
  const ops = input.effectiveOperations;
  if (input.change.origin.kind !== 'agent') return 'só changes de agente';
  if (input.analysis.explicitTransitions.length > 0 || input.analysis.promotions > 0) return 'há promoção ou transição explícita';
  if (input.analysis.basisKind === 'justification_only') return 'sustentado só por justificativa: exige revisão individual';
  const createdHere = new Set<string>();
  for (const o of ops) if (o.op === 'create_item') createdHere.add(o.itemId);
  const endpointOk = (id: string): boolean => {
    if (createdHere.has(id)) return true;
    const it = input.state.items.get(id as never);
    if (!it) return false;
    const t = Object.hasOwn(schema.itemTypes, it.type) ? schema.itemTypes[it.type] : undefined;
    if (!t) return false;
    return t.provisionalStatus === undefined || it.status === t.provisionalStatus;
  };
  for (const o of ops) {
    if (o.op === 'create_item') {
      const t = Object.hasOwn(schema.itemTypes, o.type) ? schema.itemTypes[o.type] : undefined;
      if (!t) return 'tipo de item desconhecido';
      if (t.provisionalStatus !== undefined && o.status !== t.provisionalStatus) return 'item criado fora do status provisório';
    } else if (o.op === 'create_relation') {
      const rt = Object.hasOwn(schema.relationTypes, o.type) ? schema.relationTypes[o.type] : undefined;
      if (rt === undefined || rt.impact === 'high') return 'relação de impacto alto exige revisão individual';
      if (!endpointOk(o.from) || !endpointOk(o.to)) return 'relação liga a um item já adotado: exige revisão individual';
    } else {
      return 'só create_item e create_relation';
    }
  }
  return undefined;
}

export interface DecisionInput {
  decision: Decision;
  reviewer: Reviewer;
  batch?: boolean;
  edited?: boolean;
  change: Change; // proposta original
  analysis: Analysis; // análise das operações efetivas
  effectiveOperations: Change['operations'];
  state: State; // estado vigente no momento da decisão
}

/**
 * Regras de decisão. Toda decisão exige revisor humano (impacto alto e transições explícitas
 * nunca são autoaplicados). Transição explícita exige accept/accept_edited individual.
 */
export function checkDecision(schema: ProjectSchema, input: DecisionInput): DecisionIssue[] {
  const issues: DecisionIssue[] = [];
  const add = (code: DecisionIssueCode, message: string) => issues.push({ code, message });

  if (input.reviewer.kind !== 'human') add('reviewer_must_be_human', 'a decisão exige revisor humano');
  if (input.decision === 'accept_edited' && !input.edited) {
    add('edited_operations_required', 'accept_edited exige as operações editadas');
  }
  if (input.decision !== 'accept_edited' && input.edited) {
    add('unexpected_edited_operations', 'operações editadas só em accept_edited');
  }

  if (input.decision === 'accept_provisional') {
    const problem = acceptProvisionalProblem(schema, input);
    if (problem !== undefined) {
      add('accept_provisional_invalid', `accept_provisional não vale: ${problem}`);
    }
  }

  if (input.batch && !isBatchEligible(schema, input.change, input.analysis)) {
    add('batch_not_eligible', 'este change exige revisão individual');
  }
  return issues;
}
