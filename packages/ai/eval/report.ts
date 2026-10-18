import type { EvalScore, Metrics } from './score';

/** Relatório de uma avaliação. O `label` identifica a execução (ex.: "fake", "extract@1 / modelo X"). */
export interface EvalReport {
  version: 1;
  label: string;
  /** Texto livre, definido por quem chama (data, commit...). O harness não lê o relógio. */
  meta: Record<string, string>;
  score: EvalScore;
}

export function makeReport(label: string, score: EvalScore, meta: Record<string, string> = {}): EvalReport {
  return { version: 1, label, meta, score };
}

export const toJson = (r: EvalReport): string => JSON.stringify(r, null, 2);

export function fromJson(text: string): EvalReport {
  const r = JSON.parse(text) as EvalReport;
  if (r.version !== 1) throw new Error(`relatório de versão não suportada: ${String(r.version)}`);
  return r;
}

const pct = (x: number | null): string => (x === null ? 'n/d' : `${(x * 100).toFixed(1)}%`);
const list = (xs: string[]): string => (xs.length === 0 ? 'nenhum' : xs.join(', '));

function row(name: string, m: Metrics): string {
  return `| ${name} | ${m.goldMatched}/${m.goldItems} | ${pct(m.recall)} | ${m.predictions} | ${pct(m.citationValidRate)} | ${pct(m.precisionFloor)} | ${m.unjudged} | ${m.trapsHit.length} | ${m.injectionsObeyed.length} |`;
}

export function toMarkdown(r: EvalReport): string {
  const o = r.score.overall;
  const lines: string[] = [];
  lines.push(`# Avaliação: ${r.label}`, '');
  const meta = Object.entries(r.meta).sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of meta) lines.push(`- ${k}: ${v}`);
  if (meta.length > 0) lines.push('');
  lines.push('| Fonte | Acertos | Recall | Previsões | Citação válida | Piso de precisão | Sem julgamento | Armadilhas | Injeções |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const [id, m] of Object.entries(r.score.perSource).sort(([a], [b]) => a.localeCompare(b))) lines.push(row(id, m));
  lines.push(row('**total**', o), '');
  lines.push(`- Itens do gabarito não encontrados: ${list(o.missed)}`);
  lines.push(`- Armadilhas atingidas: ${list(o.trapsHit)}`);
  lines.push(`- Injeções obedecidas ou citadas: ${list(o.injectionsObeyed)}`);
  lines.push(`- Citações inválidas: ${o.invalidCitations}; sem citação: ${o.noCitation}; ambíguas: ${o.ambiguousCitations}`);
  lines.push(`- Excesso de previsões sobre o mesmo item: ${o.duplicateMatches}`);
  lines.push(`- Duplicatas conhecidas emitidas (os dois lados): ${list(o.duplicatePairsPredicted)}`);
  lines.push('', '"Sem julgamento" são previsões com citação válida que o gabarito não cobre. Elas não são erro: precisam de uma pessoa. O piso de precisão trata todas como erro.');
  return lines.join('\n') + '\n';
}

/**
 * Para cada métrica: `higher` diz se um valor MAIOR é melhor. `informational` marca as que NÃO são erro
 * ("sem julgamento" precisa de uma pessoa; excesso e duplicatas dependem de outra etapa): mudar nelas é
 * `mudou`, nunca `piorou`, e não conta como regressão.
 */
const HIGHER_BETTER: Array<{ name: string; get: (m: Metrics) => number | null; higher: boolean; informational?: boolean }> = [
  { name: 'recall', get: (m) => m.recall, higher: true },
  { name: 'citação válida', get: (m) => m.citationValidRate, higher: true },
  { name: 'piso de precisão', get: (m) => m.precisionFloor, higher: true },
  { name: 'armadilhas atingidas', get: (m) => m.trapsHit.length, higher: false },
  { name: 'injeções obedecidas', get: (m) => m.injectionsObeyed.length, higher: false },
  { name: 'citações inválidas', get: (m) => m.invalidCitations, higher: false },
  { name: 'sem citação', get: (m) => m.noCitation, higher: false },
  { name: 'sem julgamento', get: (m) => m.unjudged, higher: false, informational: true },
  { name: 'excesso de previsões', get: (m) => m.duplicateMatches, higher: false, informational: true },
  { name: 'duplicatas conhecidas emitidas', get: (m) => m.duplicatePairsPredicted.length, higher: false, informational: true },
];

export interface MetricDelta {
  name: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  verdict: 'melhorou' | 'piorou' | 'mudou' | 'igual' | 'indefinido';
}

/** Compara o total de duas avaliações. `piorou` é regressão: quem chama decide o que fazer com ela. */
export function compare(before: EvalReport, after: EvalReport): { deltas: MetricDelta[]; regressions: string[] } {
  const deltas = HIGHER_BETTER.map(({ name, get, higher, informational }): MetricDelta => {
    const b = get(before.score.overall);
    const a = get(after.score.overall);
    if (b === null || a === null) return { name, before: b, after: a, delta: null, verdict: 'indefinido' };
    const delta = a - b;
    const verdict = Math.abs(delta) < 1e-12 ? 'igual' : informational ? 'mudou' : (delta > 0) === higher ? 'melhorou' : 'piorou';
    return { name, before: b, after: a, delta, verdict };
  });
  return { deltas, regressions: deltas.filter((d) => d.verdict === 'piorou').map((d) => d.name) };
}

export function compareMarkdown(before: EvalReport, after: EvalReport): string {
  const { deltas, regressions } = compare(before, after);
  const f = (x: number | null) => (x === null ? 'n/d' : Number.isInteger(x) ? String(x) : x.toFixed(3));
  const lines = [`# Comparação: ${before.label} → ${after.label}`, '', '| Métrica | Antes | Depois | Variação | |', '|---|---|---|---|---|'];
  for (const d of deltas) lines.push(`| ${d.name} | ${f(d.before)} | ${f(d.after)} | ${f(d.delta)} | ${d.verdict} |`);
  lines.push('', regressions.length === 0 ? 'Nenhuma regressão.' : `Regressões: ${regressions.join(', ')}.`);
  return lines.join('\n') + '\n';
}
