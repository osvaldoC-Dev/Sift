import type { FidelityReason, Hash, IssueCode } from '@sift/core';
import type { ModelUsage } from './ports';

/**
 * Relatório de execução (run report). Descreve o que o pipeline fez com a saída do modelo.
 * NÃO entra no log do núcleo nem no estado: é um registro à parte, ligado à execução pelo `runId`
 * (que já consta na origem de agente de cada change).
 */

export const DISCARD_REASONS = [
  'invalid_citation', // o trecho citado não existe na fonte (ou é ambíguo)
  'not_supported', // o trecho existe, mas não sustenta a afirmação (supportVerdict none)
  'duplicate', // já existe no estado, ou repete outro change da mesma execução
  'validation_refused', // o núcleo recusou o change (schema, basis, tipos...)
] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

interface DiscardBase {
  /** Referência local do change na saída do modelo (nunca um ID do sistema). */
  ref: string;
  /** Explicação curta, em português, para quem audita a execução. */
  detail: string;
}

export type DiscardedItem =
  | (DiscardBase & {
      reason: 'invalid_citation';
      quote: string;
      /** `ambiguous` (o trecho aparece mais de uma vez) é detectado no pipeline, não em verifyEvidence. */
      problem: FidelityReason | 'ambiguous';
    })
  | (DiscardBase & { reason: 'not_supported'; quote: string; verdict: 'none' })
  | (DiscardBase & { reason: 'duplicate'; duplicateOf: string })
  | (DiscardBase & { reason: 'validation_refused'; issueCodes: IssueCode[] });

/**
 * Cobertura por fonte: quanto do material enviado ao modelo gerou alguma proposta mantida.
 * "Passagem" é a unidade de contexto enviada ao modelo; como as fontes são divididas é do 3.2.
 */
export interface SourceCoverage {
  sourceId: string;
  contentHash: Hash;
  passagesTotal: number;
  passagesCited: number;
}

export interface RunReport {
  runId: string;
  /** Versão do estado sobre a qual o modelo trabalhou. */
  baseVersion: number;
  model: string;
  promptVersion: string;
  usage: ModelUsage;
  /** Quantos changes o modelo devolveu. Invariante: modelChanges = kept + discarded.length. */
  modelChanges: number;
  kept: number;
  discarded: DiscardedItem[];
  coverage: SourceCoverage[];
}
