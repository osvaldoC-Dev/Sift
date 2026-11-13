import {
  contentHash, emptyState, normalizeText, sha256Hex,
  type Change, type ProjectId, type ProjectSchema, type RunId,
} from '@sift/core';
import {
  CostGuard, assertCaps, extractFromSource,
  type CostCaps, type CostSnapshot, type ExtractError, type ModelPort, type ModelRequest, type ModelResponse, type Prices,
} from '../src';
import { requestHash, type Recording } from '../src/testing/recorded-model';
import { scoreEval, type EvalScore } from './score';
import type { EvalData, Prediction } from './types';

/**
 * Corrida ao vivo (3.3), SEM rede aqui dentro: recebe uma `ModelPort` pronta (o CLI monta a real; os testes, uma falsa).
 * Regras que este arquivo impõe:
 *  - recusa correr sem teto de custo (por fonte e total);
 *  - recusa correr se `approval-thresholds.json` não está commitado e inalterado, e LÊ os limiares só desse JSON;
 *  - só as 7 fontes sintéticas do eval (nunca texto real);
 *  - nunca escreve em arquivo nenhum (quem grava é o CLI, e nunca no JSON dos limiares);
 *  - nunca toca no log nem no ledger (usa só `extractFromSource`);
 *  - falha de fornecedor não é item errado: a fonte fica "não avaliada" e, com fontes em falta, NÃO há veredicto.
 */

export const SYNTHETIC_SOURCE_COUNT = 7;

export type LiveRefusalCode = 'no_caps' | 'thresholds_not_committed' | 'thresholds_modified' | 'thresholds_invalid' | 'not_the_synthetic_set';
export class LiveRefusal extends Error {
  constructor(readonly code: LiveRefusalCode, message: string) {
    super(message);
    this.name = 'LiveRefusal';
  }
}

export interface Thresholds {
  version: number;
  gates: {
    injectionsObeyedOrCited: { max: number };
    validCitationRate: { min: number };
    recall: { min: number };
    trapsHit: { max: number; of: number };
  };
}

/** O que o runner precisa saber do git. O CLI implementa com `git`; os testes, com um falso. */
export interface GitProbe {
  isTracked(path: string): boolean;
  isModified(path: string): boolean;
}

export interface LiveDeps {
  model: ModelPort;
  /** Descrição do modelo para o relatório (id, URL base, esforço de raciocínio, temperatura NÃO enviada...). */
  modelInfo: Record<string, string | number | boolean>;
  evalData: EvalData;
  schema: ProjectSchema;
  probe: GitProbe;
  thresholdsPath: string;
  /** Texto do JSON dos limiares. É a ÚNICA fonte dos limiares. */
  readThresholds(): string;
  ids: { next(): string };
  clock: { now(): string };
}

export interface LiveConfig {
  label: string;
  perSourceCaps: CostCaps;
  totalCaps: CostCaps;
  prices: Prices;
  /** Tentativas por fonte para falha retentável (padrão 2 = uma nova tentativa). */
  maxAttempts?: number;
  maxChunkChars?: number;
}

export interface SourceOutcome {
  sourceId: string;
  status: 'evaluated' | 'failed' | 'not_run';
  error?: { code: string; retryable: boolean; detail: string };
  attempts: number;
  kept: number;
  discarded: number;
  uncheckedByVerifier: number;
  verifierDegraded: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

export interface GateResult {
  name: string;
  value: number | null;
  threshold: string;
  passed: boolean;
}

export interface LiveReport {
  version: 1;
  label: string;
  startedAt: string;
  model: Record<string, string | number | boolean>;
  thresholdsSha256: string;
  caps: { perSource: CostCaps; total: CostCaps };
  cost: CostSnapshot;
  sources: SourceOutcome[];
  /** "incompleto" sempre que falta alguma fonte: nunca há veredicto com fontes em falta. */
  verdict: 'aprovado' | 'reprovado' | 'incompleto';
  stoppedByCostCap: boolean;
  gates: GateResult[];
  score: EvalScore | null;
}

export interface LiveOutcome {
  report: LiveReport;
  /** Respostas do modelo (já interpretadas) no formato do RecordedModel, para repetir offline e de graça. */
  recording: Recording;
  markdown: string;
}

function parseThresholds(text: string): Thresholds {
  let t: unknown;
  try {
    t = JSON.parse(text);
  } catch {
    throw new LiveRefusal('thresholds_invalid', 'approval-thresholds.json não é JSON');
  }
  const g = (t as { gates?: Record<string, Record<string, unknown>> } | null)?.gates;
  const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!g || !n(g.injectionsObeyedOrCited?.max) || !n(g.validCitationRate?.min) || !n(g.recall?.min) || !n(g.trapsHit?.max) || !n(g.trapsHit?.of)) {
    throw new LiveRefusal('thresholds_invalid', 'approval-thresholds.json sem os quatro limiares esperados');
  }
  return t as Thresholds;
}

function toPredictions(sourceId: string, changes: Change[]): Prediction[] {
  return changes.map((c) => {
    const op = c.operations[0]!;
    if (op.op !== 'create_item') throw new Error('esperado create_item');
    const ev = op.evidence[0]!;
    return { sourceId, type: op.type as Prediction['type'], text: op.content ?? '', quote: ev.quote ?? '' };
  });
}

function evaluateGates(th: Thresholds, score: EvalScore): GateResult[] {
  const o = score.overall;
  const max = (name: string, value: number, limit: number, extra = ''): GateResult => ({ name, value, threshold: `<= ${limit}${extra}`, passed: value <= limit });
  const min = (name: string, value: number | null, limit: number): GateResult => ({ name, value, threshold: `>= ${limit}`, passed: value !== null && value >= limit });
  return [
    max('injeções obedecidas ou citadas', o.injectionsObeyed.length, th.gates.injectionsObeyedOrCited.max),
    min('taxa de citação válida', o.citationValidRate, th.gates.validCitationRate.min),
    min('recall', o.recall, th.gates.recall.min),
    max('armadilhas atingidas', o.trapsHit.length, th.gates.trapsHit.max, ` de ${th.gates.trapsHit.of}`),
  ];
}

const pct = (x: number | null): string => (x === null ? 'n/d' : `${(x * 100).toFixed(1)}%`);

export function liveMarkdown(r: LiveReport): string {
  const L: string[] = [`# Corrida ao vivo: ${r.label}`, ''];
  L.push(`- Modelo: ${Object.entries(r.model).map(([k, v]) => `${k}=${String(v)}`).join(', ')}`);
  L.push(`- Início: ${r.startedAt}; limiares (sha256): ${r.thresholdsSha256}`);
  L.push(`- Custo: US$ ${r.cost.usd.toFixed(4)} (teto US$ ${r.caps.total.maxUsd}); ${r.cost.totalTokens} tokens; ${r.cost.calls} chamadas${r.cost.estimatedCalls > 0 ? `; ${r.cost.estimatedCalls} com uso estimado` : ''}`);
  if (r.stoppedByCostCap) L.push('- **A corrida PAROU por atingir o teto de custo.**');
  L.push('', `## Veredicto: **${r.verdict.toUpperCase()}**`, '');
  if (r.verdict === 'incompleto') L.push('Há fontes não avaliadas: nenhum veredicto é emitido e nenhum número abaixo vale como resultado.', '');
  L.push('| Fonte | Estado | Mantidos | Descartados | unchecked | Tentativas |', '|---|---|---|---|---|---|');
  for (const s of r.sources) {
    L.push(`| ${s.sourceId} | ${s.status}${s.error ? ` (${s.error.code})` : ''} | ${s.kept} | ${s.discarded} | ${s.uncheckedByVerifier}${s.verifierDegraded ? ' (verificador degradado)' : ''} | ${s.attempts} |`);
  }
  if (r.gates.length > 0) {
    L.push('', '| Limiar | Valor | Exigido | Resultado |', '|---|---|---|---|');
    for (const g of r.gates) L.push(`| ${g.name} | ${g.value === null ? 'n/d' : g.name.includes('taxa') || g.name === 'recall' ? pct(g.value) : g.value} | ${g.threshold} | ${g.passed ? 'passou' : 'FALHOU'} |`);
  }
  return `${L.join('\n')}\n`;
}

export async function runLive(deps: LiveDeps, cfg: LiveConfig): Promise<LiveOutcome> {
  // 1. Recusas, antes de gastar qualquer coisa.
  try {
    assertCaps(cfg.perSourceCaps);
    assertCaps(cfg.totalCaps);
  } catch {
    throw new LiveRefusal('no_caps', 'recusado: defina o teto de custo (dólares e tokens) por fonte e total');
  }
  if (!deps.probe.isTracked(deps.thresholdsPath)) throw new LiveRefusal('thresholds_not_committed', 'recusado: approval-thresholds.json não está commitado');
  if (deps.probe.isModified(deps.thresholdsPath)) throw new LiveRefusal('thresholds_modified', 'recusado: approval-thresholds.json tem alterações por commitar');
  const thresholdsText = deps.readThresholds();
  const thresholds = parseThresholds(thresholdsText);

  const ids = Object.keys(deps.evalData.sources).sort();
  const goldIds = deps.evalData.golds.map((g) => g.source).sort();
  if (ids.length !== SYNTHETIC_SOURCE_COUNT || ids.join('|') !== goldIds.join('|')) {
    throw new LiveRefusal('not_the_synthetic_set', `recusado: a corrida usa SÓ as ${SYNTHETIC_SOURCE_COUNT} fontes sintéticas do eval`);
  }

  // 2. Corrida.
  const total = new CostGuard(cfg.totalCaps, cfg.prices, 'corrida');
  const entries: Recording['entries'] = [];
  const tee: ModelPort = {
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      const res = await deps.model.generate(request);
      entries.push({ requestHash: requestHash(request), response: JSON.parse(JSON.stringify(res)) as ModelResponse });
      return res;
    },
  };
  const maxAttempts = Math.max(1, cfg.maxAttempts ?? 2);
  const outcomes: SourceOutcome[] = [];
  const predictions: Prediction[] = [];
  let stopped = false;

  for (const sourceId of ids) {
    const base: SourceOutcome = {
      sourceId, status: 'not_run', attempts: 0, kept: 0, discarded: 0, uncheckedByVerifier: 0, verifierDegraded: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    if (stopped) { outcomes.push(base); continue; }
    const text = normalizeText(deps.evalData.sources[sourceId]!);
    const perSource = new CostGuard(cfg.perSourceCaps, cfg.prices, `fonte ${sourceId}`);
    const model = total.wrap(perSource.wrap(tee));
    let last: { error: ExtractError; usage: { inputTokens: number; outputTokens: number } } | undefined;
    let done = false;
    for (let attempt = 1; attempt <= maxAttempts && !done; attempt++) {
      base.attempts = attempt;
      const r = await extractFromSource(
        { model, schema: deps.schema, ids: deps.ids, clock: deps.clock },
        {
          runId: `${cfg.label}:${sourceId}:${attempt}` as RunId, projectId: 'live-eval' as ProjectId, baseVersion: 0,
          schemaRef: { key: deps.schema.key, version: deps.schema.version }, state: emptyState(),
          source: { id: sourceId, label: sourceId, contentHash: contentHash(text), text },
          ...(cfg.maxChunkChars !== undefined ? { maxChunkChars: cfg.maxChunkChars } : {}),
        },
      );
      if (r.ok) {
        predictions.push(...toPredictions(sourceId, r.changes));
        Object.assign(base, {
          status: 'evaluated', kept: r.report.kept, discarded: r.report.discarded.length,
          uncheckedByVerifier: r.report.uncheckedByVerifier.length, verifierDegraded: r.report.verifierDegraded !== null,
          usage: r.report.usage,
        });
        delete base.error;
        done = true;
      } else {
        last = { error: r.error, usage: r.report.usage };
        base.usage = r.report.usage;
        if (r.error.code === 'cost_cap_exceeded') { stopped = true; break; }
        if (!r.error.retryable) break;
      }
    }
    if (!done) {
      base.status = last?.error.code === 'cost_cap_exceeded' ? 'not_run' : 'failed';
      if (last) base.error = { code: last.error.code, retryable: last.error.retryable, detail: last.error.detail };
    }
    outcomes.push(base);
  }

  // 3. Veredicto: só com as 7 fontes avaliadas.
  const allEvaluated = outcomes.every((o) => o.status === 'evaluated');
  const score = allEvaluated ? scoreEval(deps.evalData, predictions) : null;
  const gates = score ? evaluateGates(thresholds, score) : [];
  const report: LiveReport = {
    version: 1, label: cfg.label, startedAt: deps.clock.now(), model: deps.modelInfo,
    thresholdsSha256: sha256Hex(thresholdsText),
    caps: { perSource: cfg.perSourceCaps, total: cfg.totalCaps }, cost: total.snapshot(),
    sources: outcomes, stoppedByCostCap: stopped,
    verdict: !allEvaluated ? 'incompleto' : gates.every((g) => g.passed) ? 'aprovado' : 'reprovado',
    gates, score,
  };
  return { report, recording: { version: 1, entries }, markdown: liveMarkdown(report) };
}

