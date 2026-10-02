import type { ProjectSchema } from './schema';
import type { Analysis } from './validate';
import type { Change, ChangeStatus, Decision, ReviewEvent, Reviewer } from './types';

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
 * Só vale se NADA no change cria compromisso:
 *  - só create_item e create_relation, origem agente, sem promoções nem transições explícitas;
 *  - create_item de tipo COM provisionalStatus: o status criado tem de ser o provisório;
 *  - create_item de tipo SEM provisionalStatus (ex.: pergunta): permitido, porque o schema declara
 *    que esse tipo não tem distinção provisório/compromisso. As regras de criação por origem e de
 *    basis continuam valendo (a validação roda antes). Tipos que o agente não pode criar
 *    (ex.: fonte, nota) já falham na validação de criação;
 *  - create_relation de tipo com impacto alto (ex.: desafia, afeta, substitui) NÃO entra: relação
 *    não tem status provisório, então exige revisão individual com accept.
 */
function acceptProvisionalOk(schema: ProjectSchema, input: DecisionInput): boolean {
  const ops = input.effectiveOperations;
  if (input.change.origin.kind !== 'agent') return false;
  if (input.analysis.explicitTransitions.length > 0 || input.analysis.promotions > 0) return false;
  return ops.every((o) => {
    if (o.op === 'create_item') {
      const t = Object.hasOwn(schema.itemTypes, o.type) ? schema.itemTypes[o.type] : undefined;
      if (!t) return false;
      return t.provisionalStatus === undefined || o.status === t.provisionalStatus;
    }
    if (o.op === 'create_relation') {
      const rt = Object.hasOwn(schema.relationTypes, o.type) ? schema.relationTypes[o.type] : undefined;
      return rt !== undefined && rt.impact !== 'high';
    }
    return false;
  });
}

export interface DecisionInput {
  decision: Decision;
  reviewer: Reviewer;
  batch?: boolean;
  edited?: boolean;
  change: Change; // proposta original
  analysis: Analysis; // análise das operações efetivas
  effectiveOperations: Change['operations'];
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
    if (!acceptProvisionalOk(schema, input)) {
      add(
        'accept_provisional_invalid',
        'accept_provisional só vale para criações de agente que não criam compromisso',
      );
    }
  }

  if (input.batch && !isBatchEligible(schema, input.change, input.analysis)) {
    add('batch_not_eligible', 'este change exige revisão individual');
  }
  return issues;
}
