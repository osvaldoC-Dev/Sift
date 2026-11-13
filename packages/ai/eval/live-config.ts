import { KIMI_K3_PRICES, type CostCaps, type Prices } from '../src';
import type { ReasoningEffort } from '../src/adapters/kimi';

/**
 * Configuração da corrida ao vivo a partir do ambiente. Pura: não lê `process`, recebe o objeto. Diz QUAIS variáveis
 * faltam, nunca imprime valor nenhum (a chave não pode aparecer em mensagem).
 */
export interface LiveEnvConfig {
  perSourceCaps: CostCaps;
  totalCaps: CostCaps;
  prices: Prices;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  model?: string;
  baseUrl?: string;
}

const REQUIRED = [
  'MOONSHOT_API_KEY', 'SIFT_LIVE_MAX_USD', 'SIFT_LIVE_MAX_TOKENS', 'SIFT_LIVE_SOURCE_MAX_USD', 'SIFT_LIVE_SOURCE_MAX_TOKENS', 'SIFT_LIVE_MAX_OUTPUT_TOKENS',
] as const;

export function parseLiveEnv(env: Record<string, string | undefined>): LiveEnvConfig {
  const missing = REQUIRED.filter((k) => env[k] === undefined || env[k]!.trim() === '');
  if (missing.length > 0) throw new Error(`recusado: faltam variáveis de ambiente: ${missing.join(', ')}`);
  const pos = (k: string): number => {
    const n = Number(env[k]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`recusado: ${k} tem de ser um número positivo`);
    return n;
  };
  const effort = env.SIFT_LIVE_REASONING_EFFORT ?? 'low';
  if (effort !== 'low' && effort !== 'high' && effort !== 'max') throw new Error('recusado: SIFT_LIVE_REASONING_EFFORT deve ser low, high ou max');
  return {
    perSourceCaps: { maxUsd: pos('SIFT_LIVE_SOURCE_MAX_USD'), maxTotalTokens: pos('SIFT_LIVE_SOURCE_MAX_TOKENS') },
    totalCaps: { maxUsd: pos('SIFT_LIVE_MAX_USD'), maxTotalTokens: pos('SIFT_LIVE_MAX_TOKENS') },
    prices: KIMI_K3_PRICES, reasoningEffort: effort, maxOutputTokens: pos('SIFT_LIVE_MAX_OUTPUT_TOKENS'),
    ...(env.SIFT_LIVE_MODEL ? { model: env.SIFT_LIVE_MODEL } : {}),
    ...(env.MOONSHOT_BASE_URL ? { baseUrl: env.MOONSHOT_BASE_URL } : {}),
  };
}
