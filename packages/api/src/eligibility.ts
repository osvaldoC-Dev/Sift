import {
  analyzeChange, checkDecision, staleReasons,
  type Change, type ChangeStatus, type ProjectSchema, type State, type SupportVerdict, type UserId,
} from '@sift/core';
import type { BlockCode } from '@sift/contract';

export type Availability = { ok: true } | { ok: false; code: BlockCode };
export interface Eligibility {
  canAccept: Availability;
  canReject: Availability;
  canBatchAccept: Availability;
}

const OK: Availability = { ok: true };
const no = (code: BlockCode): Availability => ({ ok: false, code });
/** Revisor de sonda: a elegibilidade pergunta ao núcleo "e se um humano decidisse agora?". Nada é gravado. */
const PROBE = { kind: 'human', id: 'eligibility-probe' as UserId } as const;

export const isPending = (s: ChangeStatus): boolean => s === 'proposed' || s === 'deferred' || s === 'stale';

export interface EligibilityInput {
  schema: ProjectSchema;
  /** Estado vigente (head). */
  state: State;
  change: Change;
  status: ChangeStatus;
  /** Nº de ocorrências da citação na fonte, vindo de `SourceKind.locate` (0 = não encontrada). */
  found: number;
  /** Suporte mais fraco entre as evidências efetivas. */
  support: SupportVerdict;
}

/**
 * Elegibilidade das três ações. As regras são as do NÚCLEO (`staleReasons`, `analyzeChange`, `checkDecision`):
 * aqui só se traduzem as recusas dele para os códigos do contrato. Nada da interface entra nesta conta.
 *
 * Traduções que o contrato não cobre por inteiro (ver OPEN-DECISIONS):
 *  - análise do núcleo com problemas no estado atual (a proposta já não se aplica) -> `stale`;
 *  - lote recusado pela estrutura (impacto fora de `batchEligibleImpact`, transição explícita, só justificativa)
 *    -> `relation_touches_adopted` se há relação no change, senão `decision_individual_only`.
 */
export function eligibility(i: EligibilityInput): Eligibility {
  if (!isPending(i.status)) {
    return { canAccept: no('already_decided'), canReject: no('already_decided'), canBatchAccept: no('already_decided') };
  }
  const canReject = OK; // o núcleo permite rejeitar (e dispensar) qualquer proposta pendente, inclusive stale
  const stale = i.status === 'stale' || staleReasons(i.change, i.state).length > 0;

  const gate = (): BlockCode | undefined => {
    if (i.found === 0) return 'citation_not_found';
    if (i.support === 'none') return 'support_none';
    if (stale) return 'stale';
    return undefined;
  };
  const blocked = gate();
  if (blocked !== undefined) {
    return {
      canAccept: no(blocked), canReject,
      // lote: citação inexistente e obsolescência valem igual; suporte `none` não chega a existir no livro
      canBatchAccept: no(blocked),
    };
  }

  const analysis = analyzeChange(i.schema, i.state, i.change);
  if (analysis.issues.length > 0) {
    return { canAccept: no('stale'), canReject, canBatchAccept: no('stale') };
  }
  const base = {
    reviewer: PROBE, change: i.change, analysis, effectiveOperations: i.change.operations, state: i.state,
  };

  const accept = checkDecision(i.schema, { ...base, decision: 'accept' });
  if (accept.length > 0) {
    // accept individual só falha por motivo que o núcleo reconhece como bug de uso: nunca mascarar
    throw new Error(`checkDecision recusou accept individual: ${accept.map((x) => x.code).join(',')}`);
  }

  const batch = checkDecision(i.schema, { ...base, decision: 'accept', batch: true });
  let canBatchAccept: Availability = OK;
  const codes = new Set(batch.map((x) => x.code));
  if (codes.has('batch_not_eligible')) {
    const hasRelation = i.change.operations.some((o) => o.op === 'create_relation');
    canBatchAccept = no(hasRelation ? 'relation_touches_adopted' : 'decision_individual_only');
  } else if (codes.has('support_not_full')) {
    canBatchAccept = no('support_not_full');
  } else if (i.found > 1) {
    // ambiguidade é regra do CONTRATO (invariante), não do núcleo: o núcleo aceita a citação, a pessoa confere
    canBatchAccept = no('citation_ambiguous');
  }
  return { canAccept: OK, canReject, canBatchAccept };
}
