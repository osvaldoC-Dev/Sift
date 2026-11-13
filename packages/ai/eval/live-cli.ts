/**
 * `eval:live` (3.3). NÃO foi executado contra o fornecedor nesta entrega: só o runner e o adaptador têm testes (com
 * transporte falso). Uso (depois que o Osvaldo definir as variáveis e a primeira chamada real mínima, K9, passar):
 *   MOONSHOT_API_KEY=... SIFT_LIVE_MAX_USD=... (ver live-config.ts) npx tsx packages/ai/eval/live-cli.ts <pasta-de-saída>
 * Escreve report.json, report.md, recording.json e raw.jsonl na pasta de saída. Nunca escreve no JSON dos limiares.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProjectSchema } from '@sift/core';
import { researchV1 } from '@sift/schemas';
import { KimiModel, fetchTransport, kimiConfigFromEnv, type RawRecord } from '../src/adapters/kimi';
import { loadEval } from './load';
import { runLive, type GitProbe } from './live';
import { parseLiveEnv } from './live-config';

const HERE = dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = join(HERE, 'approval-thresholds.json');

const git = (args: string[]): string => execFileSync('git', args, { cwd: HERE, encoding: 'utf8' });
const probe: GitProbe = {
  isTracked: (p) => { try { git(['ls-files', '--error-unmatch', p]); return true; } catch { return false; } },
  isModified: (p) => git(['status', '--porcelain', '--', p]).trim() !== '',
};

async function main(): Promise<void> {
  const out = process.argv[2];
  if (out === undefined) throw new Error('uso: live-cli.ts <pasta-de-saída>');
  const outDir = resolve(out);
  if (outDir === resolve(THRESHOLDS) || outDir.startsWith(resolve(HERE, 'gold')) || outDir.startsWith(resolve(HERE, 'sources'))) {
    throw new Error('recusado: a saída não pode ser o gabarito, as fontes nem os limiares');
  }
  const cfg = parseLiveEnv(process.env);
  const { apiKey, baseUrl } = kimiConfigFromEnv(process.env);
  const raws: RawRecord[] = [];
  const model = new KimiModel({
    apiKey, transport: fetchTransport, reasoningEffort: cfg.reasoningEffort, maxOutputTokens: cfg.maxOutputTokens,
    baseUrl: cfg.baseUrl ?? baseUrl, ...(cfg.model ? { model: cfg.model } : {}), onRaw: (r) => raws.push(r),
  });
  let n = 0;
  const outcome = await runLive(
    {
      model, modelInfo: { ...model.describe() }, evalData: loadEval(), schema: assertProjectSchema(researchV1), probe,
      thresholdsPath: THRESHOLDS, readThresholds: () => readFileSync(THRESHOLDS, 'utf8'),
      ids: { next: () => `live${++n}` }, clock: { now: () => new Date().toISOString() },
    },
    { label: `kimi-${new Date().toISOString().slice(0, 10)}`, perSourceCaps: cfg.perSourceCaps, totalCaps: cfg.totalCaps, prices: cfg.prices },
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(outcome.report, null, 2));
  writeFileSync(join(outDir, 'report.md'), outcome.markdown);
  writeFileSync(join(outDir, 'recording.json'), JSON.stringify(outcome.recording, null, 2));
  writeFileSync(join(outDir, 'raw.jsonl'), raws.map((r) => JSON.stringify(r)).join('\n'));
  console.log(`${outcome.report.verdict}: ${join(outDir, 'report.md')}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'erro');
  process.exit(1);
});
