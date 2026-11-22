import { ConfigError, loadConfig, startServer, startupLines } from './main';

/**
 * Ponto de entrada (a "raiz de composição"): o ÚNICO ficheiro da API que liga o relógio, os ids, o ambiente e a
 * consola ao sistema. Tudo o resto recebe isso por parâmetro. Corre com `npm run start -w @sift/api`.
 */
const clock = { now: () => new Date().toISOString() };
const ids = { next: () => crypto.randomUUID() };
const logger = (e: unknown): void => { console.log(JSON.stringify(e)); };

try {
  const config = loadConfig(process.env);
  const running = await startServer(config, { clock, ids, logger });
  for (const line of startupLines(config, running.port)) console.log(line);
  const stop = (): void => { void running.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (e) {
  // Nunca se imprime o objeto do erro (poderia carregar o ambiente): só a mensagem de configuração ou o nome.
  console.error(e instanceof ConfigError ? e.message : `erro ao arrancar (${e instanceof Error ? e.name : 'desconhecido'})`);
  process.exit(e instanceof ConfigError ? 2 : 1);
}
