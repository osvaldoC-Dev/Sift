import { agent, human, updateItem } from '@sift/core/testing';
import type { ChangeDraft, ChangeId, ProjectId } from '@sift/core';
import { ResponseSchemas } from '@sift/contract';
import { verifyChain } from '@sift/core';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src';
import { PROJECT, capture, claim, ext, extract, harness, question, ver, type Harness } from './helpers';

/** Desfazer uma aceitação cuja compensação conflita com mudanças POSTERIORES nos mesmos itens (ponta a ponta). */
const P = `/projects/${PROJECT}`;
const body = (r: { body: unknown }) => r.body as Record<string, any>;
const undo = (h: Harness) => h.call('POST', `${P}/undo`, {});
const state = async (h: Harness) => body(await h.call('GET', `${P}/state`));

async function setup() {
  const h = harness([ext([question, claim]), ver('full'), ver('full')]);
  const sid = await capture(h);
  const props = body(await extract(h, sid)).proposals as { id: string; text: string }[];
  const idOf = (t: string) => props.find((p) => p.text === t)!.id;
  // pilha de decisões: primeiro a pergunta, depois a afirmação (a afirmação está no topo)
  await h.call('POST', `${P}/proposals/${idOf('Is Gamma ready?')}/decision`, { kind: 'accept' });
  await h.call('POST', `${P}/proposals/${idOf('Alpha is true.')}/decision`, { kind: 'accept' });
  const items = (await state(h)).items as { id: string; text: string }[];
  const ps = (await h.store.project(PROJECT))!;
  const humanEdit = async (itemId: string, from: string, to: string) => {
    const draft: ChangeDraft = {
      id: `humana-${itemId}` as ChangeId, projectId: PROJECT as ProjectId, baseVersion: (await ps.state()).version,
      schemaRef: { key: ps.schema.key, version: ps.schema.version }, origin: human('u1'), rationale: 'edição humana',
      createdAt: '2026-11-07T12:30:00.000Z',
      operations: [updateItem({ id: itemId, before: { content: from }, patch: { content: to } })],
    };
    const o = await ps.submitHuman(draft);
    if (!o.ok) throw new Error(`mudança humana recusada: ${JSON.stringify(o)}`);
  };
  return {
    h, ps, humanEdit, idOf,
    alpha: items.find((i) => i.text === 'Alpha is true.')!.id,
    gamma: items.find((i) => i.text === 'Is Gamma ready?')!.id,
  };
}
const snapshot = async (h: Harness) => {
  const ps = (await h.store.project(PROJECT))!;
  return { core: (await ps.entries()).length, audit: (await ps.audit()).length, state: await state(h) };
};

describe('desfazer em conflito', () => {
  it('a decisão do topo foi alterada depois: canUndo false, desfazer = 409 conflict, NADA gravado, cadeias íntegras', async () => {
    const { h, ps, humanEdit, alpha } = await setup();
    expect((await state(h)).canUndo).toBe(true);
    await humanEdit(alpha, 'Alpha is true.', 'Alpha is false.');
    expect((await state(h)).canUndo).toBe(false);
    const before = await snapshot(h);
    const r = await undo(h);
    expect(r.status).toBe(409);
    expect(ResponseSchemas.error.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ code: 'conflict' });
    expect(await snapshot(h)).toEqual(before);
    expect(verifyChain(await ps.entries()).ok).toBe(true);
    expect(verifyAuditChain((await h.call('GET', `${P}/log`)).body as never).ok).toBe(true);
    // o histórico do projeto continua com a edição humana e o item não foi retirado
    expect((await state(h)).items.map((i: any) => i.text)).toContain('Alpha is false.');
  });

  it('o conflito é do topo da pilha: não salta para uma decisão mais antiga (que seria desfeita sem o utilizador pedir)', async () => {
    const { h, humanEdit, alpha } = await setup();
    await humanEdit(alpha, 'Alpha is true.', 'Alpha is false.');
    const r = await undo(h);
    expect(r.status).toBe(409);
    expect((await state(h)).items.map((i: any) => i.text).sort()).toEqual(['Alpha is false.', 'Is Gamma ready?']);
  });

  it('conflito só na decisão mais antiga: o topo desfaz-se; depois canUndo passa a false e o desfazer seguinte dá 409', async () => {
    const { h, ps, humanEdit, gamma } = await setup();
    await humanEdit(gamma, 'Is Gamma ready?', 'Is Gamma done?');
    expect((await state(h)).canUndo).toBe(true);
    const first = await undo(h);
    expect(first.status).toBe(200);
    expect(ResponseSchemas.undo.safeParse(first.body).success).toBe(true);
    expect(body(first).proposal.status).toBe('undone');
    expect((await state(h)).canUndo).toBe(false);
    const before = await snapshot(h);
    const second = await undo(h);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'conflict' });
    expect(await snapshot(h)).toEqual(before);
    expect(verifyChain(await ps.entries()).ok).toBe(true);
  });

  it('depois de um conflito, decidir outras propostas e o próprio fluxo continuam a funcionar', async () => {
    const { h, humanEdit, alpha } = await setup();
    await humanEdit(alpha, 'Alpha is true.', 'Alpha is false.');
    expect((await undo(h)).status).toBe(409);
    const cap = await h.call('POST', `${P}/sources`, { name: 'n.txt', text: 'Outro texto.' });
    expect(cap.status).toBe(201);
  });
});
