import { CostGuard, KIMI_K3_PRICES, type ModelPort } from '@sift/ai';
import { KimiModel, fetchTransport, kimiConfigFromEnv, type HttpTransport, type ReasoningEffort } from '@sift/ai/adapters/kimi';
import type { Clock, IdGenerator } from '@sift/core';
import type { Server } from 'node:http';
import { createApi, type Api, type LogEvent } from './api';
import { createDemoModel } from './demo-model';
import { createMemoryStore } from './memory-store';
import { createNodeServer } from './node-server';
import type { Store } from './store';

/**
 * Montagem do servidor a partir do AMBIENTE. Aqui não há relógio, aleatoriedade, `process` nem `console`: o ambiente,
 * o relógio e os ids entram por parâmetro (quem os liga ao sistema é `start.ts`). Tudo é testável sem rede.
 */
export class ConfigError extends Error {}

export type ModelConfig =
  | { kind: 'fake' }
  | {
    kind: 'kimi';
    apiKey: string;
    baseUrl: string;
    model?: string;
    reasoningEffort: ReasoningEffort;
    maxOutputTokens: number;
    caps: { maxUsd: number; maxTotalTokens: number };
  };

export interface ServerConfig {
  port: number;
  project: string;
  allowedOrigins: string[];
  model: ModelConfig;
}

const KIMI_REQUIRED = ['MOONSHOT_API_KEY', 'SIFT_KIMI_MAX_USD', 'SIFT_KIMI_MAX_TOKENS', 'SIFT_KIMI_MAX_OUTPUT_TOKENS'] as const;
const ORIGIN = /^https?:\/\/[^/\s*]+$/;

/** Lê e valida o ambiente. As mensagens dizem QUAIS variáveis estão erradas e nunca repetem um valor secreto. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const get = (k: string): string | undefined => (env[k] === undefined || env[k]!.trim() === '' ? undefined : env[k]!.trim());

  const portText = get('PORT') ?? '8787';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) throw new ConfigError('recusado: PORT tem de ser um inteiro entre 0 e 65535');

  const project = get('SIFT_PROJECT') ?? 'local';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(project)) throw new ConfigError('recusado: SIFT_PROJECT só pode ter letras, números, "-" e "_" (até 64)');

  const allowedOrigins = (get('SIFT_ALLOWED_ORIGIN') ?? '').split(',').map((o) => o.trim()).filter((o) => o !== '');
  for (const o of allowedOrigins) {
    if (!ORIGIN.test(o)) throw new ConfigError('recusado: SIFT_ALLOWED_ORIGIN tem de ser uma origem exata (por exemplo http://localhost:5173), sem caminho e sem "*"');
  }

  const kind = get('SIFT_MODEL') ?? 'fake';
  if (kind === 'fake') return { port, project, allowedOrigins, model: { kind: 'fake' } };
  if (kind !== 'kimi') throw new ConfigError('recusado: SIFT_MODEL tem de ser fake ou kimi');

  const missing = KIMI_REQUIRED.filter((k) => get(k) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(`recusado: SIFT_MODEL=kimi exige a chave e os tetos de custo; faltam: ${missing.join(', ')}`);
  }
  const positive = (k: string): number => {
    const n = Number(get(k));
    if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`recusado: ${k} tem de ser um número positivo`);
    return n;
  };
  let key: { apiKey: string; baseUrl: string };
  try {
    key = kimiConfigFromEnv(env);
  } catch (e) {
    throw new ConfigError(`recusado: ${e instanceof Error ? e.message : 'configuração do Kimi inválida'}`);
  }
  const effort = get('SIFT_KIMI_REASONING_EFFORT') ?? 'low';
  if (effort !== 'low' && effort !== 'high' && effort !== 'max') throw new ConfigError('recusado: SIFT_KIMI_REASONING_EFFORT tem de ser low, high ou max');
  const model = get('SIFT_KIMI_MODEL');
  return {
    port, project, allowedOrigins,
    model: {
      kind: 'kimi', ...key, ...(model !== undefined ? { model } : {}), reasoningEffort: effort,
      maxOutputTokens: positive('SIFT_KIMI_MAX_OUTPUT_TOKENS'),
      caps: { maxUsd: positive('SIFT_KIMI_MAX_USD'), maxTotalTokens: positive('SIFT_KIMI_MAX_TOKENS') },
    },
  };
}

/** Versão da configuração que pode ser impressa: nunca leva a chave. */
export function describeConfig(c: ServerConfig): Record<string, unknown> {
  return {
    port: c.port, project: c.project, allowedOrigins: c.allowedOrigins,
    model: c.model.kind === 'fake' ? { kind: 'fake' } : {
      kind: 'kimi', baseUrl: c.model.baseUrl, model: c.model.model ?? 'kimi-k3', reasoningEffort: c.model.reasoningEffort,
      maxOutputTokens: c.model.maxOutputTokens, caps: c.model.caps,
    },
  };
}

export interface System {
  clock: Clock;
  ids: IdGenerator;
  logger?: (e: LogEvent) => void;
  /** Só para testes do modo kimi: sem isto usa a rede real. */
  transport?: HttpTransport;
}

export function buildModel(c: ModelConfig, transport?: HttpTransport): ModelPort {
  if (c.kind === 'fake') return createDemoModel();
  const kimi = new KimiModel({
    apiKey: c.apiKey, transport: transport ?? fetchTransport, reasoningEffort: c.reasoningEffort,
    maxOutputTokens: c.maxOutputTokens, baseUrl: c.baseUrl, ...(c.model !== undefined ? { model: c.model } : {}),
  });
  // Teto de custo do SERVIDOR (todas as extrações somadas, até ao reinício): sem ele o adaptador não é ligado.
  return new CostGuard(c.caps, KIMI_K3_PRICES, 'servidor').wrap(kimi);
}

export function buildApp(config: ServerConfig, sys: System): { api: Api; store: Store } {
  // O projeto por omissão nasce no ARRANQUE (research@1). A API HTTP continua sem rota para criar projetos.
  const store = createMemoryStore({ projects: [config.project], clock: sys.clock, ids: sys.ids });
  const api = createApi({
    store, model: buildModel(config.model, sys.transport), clock: sys.clock, ids: sys.ids,
    corsOrigins: config.allowedOrigins, ...(sys.logger ? { logger: sys.logger } : {}),
  });
  return { api, store };
}

export interface Running {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Sobe o servidor SÓ no endereço local (127.0.0.1). Com `port: 0` o sistema escolhe uma porta livre. */
export function startServer(config: ServerConfig, sys: System): Promise<Running> {
  const { api } = buildApp(config, sys);
  const server = createNodeServer(api);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      const a = server.address();
      resolve({
        server, port: typeof a === 'object' && a !== null ? a.port : config.port,
        close: () => new Promise<void>((res, rej) => { server.close((e) => (e ? rej(e) : res())); server.closeAllConnections(); }),
      });
    });
  });
}

/** Linhas do arranque. Nunca incluem a chave. */
export function startupLines(c: ServerConfig, port: number): string[] {
  const lines = [
    `Sift API a ouvir em http://127.0.0.1:${port} (projeto "${c.project}")`,
    c.model.kind === 'fake'
      ? 'Modelo: fake (extrator determinístico, sem custo e sem rede)'
      : `Modelo: kimi (${c.model.model ?? 'kimi-k3'}), teto do servidor US$ ${c.model.caps.maxUsd} e ${c.model.caps.maxTotalTokens} tokens`,
    c.allowedOrigins.length === 0 ? 'CORS: fechado' : `CORS: ${c.allowedOrigins.join(', ')}`,
    'ATENÇÃO: os dados ficam em memória e perdem-se ao parar o servidor.',
  ];
  return lines;
}
