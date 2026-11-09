import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, createNodeServer } from '../src';
import { PROJECT, ext, harness, ver } from './helpers';

// Só laço local (127.0.0.1, porta efêmera): nada sai da máquina.
describe('adaptador node:http', () => {
  const h = harness([ext([{ type: 'question', statement: 'Is Gamma ready?', quote: 'Is Gamma ready?' }]), ver('full')]);
  const server = createNodeServer(h.api);
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const post = (path: string, body: string) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  it('captura -> extração -> propostas, em JSON, com query string', async () => {
    const cap = await post(`/projects/${PROJECT}/sources`, JSON.stringify({ name: 'a', text: 'Is Gamma ready?\n\nOutro.' }));
    expect(cap.status).toBe(201);
    expect(cap.headers.get('content-type')).toContain('application/json');
    const { source } = (await cap.json()) as { source: { id: string } };
    const ex = await post(`/projects/${PROJECT}/extractions`, JSON.stringify({ sourceId: source.id }));
    expect(ex.status).toBe(200);
    const list = await fetch(`${base}/projects/${PROJECT}/proposals?status=pending`);
    expect(((await list.json()) as unknown[]).length).toBe(1);
    expect(((await (await fetch(`${base}/projects/${PROJECT}/proposals?status=accepted`)).json()) as unknown[]).length).toBe(0);
  });

  it('JSON malformado -> 400 invalid_request; rota desconhecida -> 404; corpo gigante -> 413', async () => {
    const bad = await post(`/projects/${PROJECT}/sources`, '{nao-json');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('invalid_request');
    expect((await fetch(`${base}/nada`)).status).toBe(404);
    const big = await post(`/projects/${PROJECT}/sources`, 'x'.repeat(MAX_BODY_BYTES + 10)).catch(() => undefined);
    expect(big === undefined || big.status === 413).toBe(true);
  });
});
