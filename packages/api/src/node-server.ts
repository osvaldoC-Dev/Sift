import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Api } from './api';
import { JSON_HEADERS } from './http';

/** Teto do corpo em bytes (o contrato limita o texto a 2.000.000 caracteres; UTF-8 pode ter até 4 bytes cada). */
export const MAX_BODY_BYTES = 8_500_000;

class TooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new TooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Adaptador fino sobre `node:http`: monta o `ApiRequest`, chama `api.handle` e escreve a resposta. Sem lógica. */
export function createNodeServer(api: Api): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        const raw = req.method === 'GET' || req.method === 'OPTIONS' ? undefined : await readBody(req);
        const out = await api.handle({
          method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams),
          headers, ...(raw !== undefined ? { rawBody: raw } : {}),
        });
        res.writeHead(out.status, out.headers);
        res.end(out.body === null ? undefined : JSON.stringify(out.body));
      } catch (e) {
        const tooLarge = e instanceof TooLarge;
        res.writeHead(tooLarge ? 413 : 500, JSON_HEADERS);
        res.end(JSON.stringify(tooLarge
          ? { code: 'invalid_request', message: 'pedido grande demais' }
          : { code: 'internal', message: 'erro interno' }));
      }
    })();
  });
}
