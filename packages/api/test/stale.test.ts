import { InMemoryContents, agent, createRelation, evidenceFor, human, updateItem } from '@sift/core/testing';
import type { ChangeDraft, ChangeId, ProjectId } from '@sift/core';
import { ResponseSchemas, checkProposalInvariants } from '@sift/contract';
import { describe, expect, it } from 'vitest';
import { PROJECT, TEXT, capture, claim, claim2, ext, extract, harness, proposalsOf, question, ver, type Harness } from './helpers';

/**
 * Obsolescência provada de ponta a ponta. A extração só cria itens novos (nunca fica obsoleta sozinha), por isso a
 * proposta obsoleta é forjada PELO ARMAZÉM: uma relação de agente entre dois itens já adotados, e depois uma mudança
 * humana que altera um desses itens. Tudo o resto (listar, decidir, lote) passa pela API.
 */
const P = `/projects/${PROJECT}`;
const body = (r: { body: unknown }) => r.body as Record<string, any>;

async function setup() {
  const h = harness([ext([claim, claim2, question]), ver('full'), ver('full'), ver('full')]);
  const sid = await capture(h);
  const props = body(await extract(h, sid)).proposals as { id: string; type: string; text: string }[];
  const idOf = (text: string) => props.find((p) => p.text === text)!.id;
  await h.call('POST', `${P}/proposals/${idOf('Alpha is true.')}/decision`, { kind: 'accept' });
  await h.call('POST', `${P}/proposals/${idOf('Beta is also true.')}/decision`, { kind: 'accept' });
  const items = body(await h.call('GET', `${P}/state`)).items as { id: string; text: string }[];
  const alpha = items.find((i) => i.text === 'Alpha is true.')!.id;
  const beta = items.find((i) => i.text === 'Beta is also true.')!.id;
  const ps = (await h.store.project(PROJECT))!;
  const version = (await ps.state()).version;
  const contents = new InMemoryContents();
  const draft = (id: string, over: Partial<ChangeDraft>): ChangeDraft => ({
    id: id as ChangeId, projectId: PROJECT as ProjectId, baseVersion: version,
    schemaRef: { key: ps.schema.key, version: ps.schema.version }, origin: agent('run-forjada'),
    rationale: 'Beta sustenta Alpha.', createdAt: '2026-11-07T12:30:00.000Z', operations: [], ...over,
  });
  // proposta de relação, de agente, sobre os dois itens adotados
  const rel = draft('forjada', {
    operations: [createRelation({ id: 'rel-forjada', type: 'supports', from: beta, to: alpha, evidence: [evidenceFor(contents, TEXT, 'Alpha is true here.')] })],
  });
  const out = await ps.proposeChange(rel);
  if (!out.ok) throw new Error(`forja falhou: ${JSON.stringify(out)}`);
  await ps.saveMeta('forjada' as ChangeId, { runId: 'run-forjada', sourceId: 'x', ref: 'forjada', verifierFailed: false });
  const edit = async () => {
    const o = await ps.submitHuman(draft('humana', {
      origin: human('u1'), baseVersion: (await ps.state()).version, rationale: 'corrige Alpha',
      operations: [updateItem({ id: alpha, before: { content: 'Alpha is true.' }, patch: { content: 'Alpha is false.' } })],
    }));
    if (!o.ok) throw new Error(`mudança humana recusada: ${JSON.stringify(o)}`);
  };
  return { h, idOf, ps, edit, alpha, beta };
}
const view = async (h: Harness, id: string) => (await proposalsOf(h)).find((p) => p.id === id)!;

describe('proposta obsoleta (forjada pelo armazém), provada pela API', () => {
  it('antes da mudança: a relação pende e pode ser aceite (a forja é válida)', async () => {
    const { h } = await setup();
    const v = await view(h, 'forjada');
    expect(v).toMatchObject({ status: 'pending', stale: false, canAccept: { ok: true } });
  });

  it('depois da mudança: stale true, canAccept e canBatchAccept = stale, rejeitar continua possível, invariantes ok', async () => {
    const { h, edit } = await setup();
    await edit();
    const r = await h.call('GET', `${P}/proposals`);
    expect(ResponseSchemas.proposals.safeParse(r.body).success).toBe(true);
    const v = (r.body as any[]).find((p) => p.id === 'forjada');
    expect(v).toMatchObject({
      status: 'pending', stale: true, canAccept: { ok: false, code: 'stale' }, canBatchAccept: { ok: false, code: 'stale' }, canReject: { ok: true },
    });
    expect(checkProposalInvariants(v)).toEqual([]);
  });

  it('decide accept recusado com 409 stale e NADA gravado; reject passa', async () => {
    const { h, edit, ps } = await setup();
    await edit();
    const before = { core: (await ps.entries()).length, audit: (await ps.audit()).length };
    const r = await h.call('POST', `${P}/proposals/forjada/decision`, { kind: 'accept' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'stale' });
    expect({ core: (await ps.entries()).length, audit: (await ps.audit()).length }).toEqual(before);
    const e = await h.call('POST', `${P}/proposals/forjada/decision`, { kind: 'edit', text: 'x' });
    expect(e.status).toBe(409);
    const rej = await h.call('POST', `${P}/proposals/forjada/decision`, { kind: 'reject' });
    expect(rej.status).toBe(200);
    expect(body(rej).proposal.status).toBe('rejected');
  });

  it('lote: a obsoleta sai em refused com stale, a elegível passa, e a ordem é a pedida', async () => {
    const { h, edit, idOf } = await setup();
    await edit();
    const q = idOf('Is Gamma ready?');
    const r = await h.call('POST', `${P}/proposals/batch-accept`, { ids: ['forjada', q] });
    expect(r.status).toBe(200);
    expect(ResponseSchemas.batchAccept.safeParse(r.body).success).toBe(true);
    expect(body(r).accepted).toEqual([q]);
    expect(body(r).refused).toEqual([{ id: 'forjada', code: 'stale' }]);
    expect(body(r).proposals.find((p: any) => p.id === 'forjada')).toMatchObject({ stale: true, status: 'pending' });
  });

  it('antes da mudança o lote recusa a relação pela estrutura, não por stale (os dois códigos não se confundem)', async () => {
    const { h } = await setup();
    const r = await h.call('POST', `${P}/proposals/batch-accept`, { ids: ['forjada'] });
    expect(body(r).refused).toHaveLength(1);
    expect(body(r).refused[0].code).not.toBe('stale');
  });
});
