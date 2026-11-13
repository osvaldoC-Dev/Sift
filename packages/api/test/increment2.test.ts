import { ResponseSchemas, ApiError, checkProposalInvariants } from '@sift/contract';
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain, type ProjectStore, type Store } from '../src';
import { PROJECT, TEXT, capture, claim, claim2, decision, ext, extract, harness, proposalsOf, question, ver } from './helpers';
import { withLatency } from './latency-store';

const P = `/projects/${PROJECT}`;
const body = (r: { body: unknown }) => r.body as Record<string, any>;
type H = ReturnType<typeof harness>;
const decide = (h: H, id: string, b: object) => h.call('POST', `${P}/proposals/${id}/decision`, b);
const batch = (h: H, ids: string[]) => h.call('POST', `${P}/proposals/batch-accept`, { ids });
const undo = (h: H) => h.call('POST', `${P}/undo`, {});
const state = async (h: H) => body(await h.call('GET', `${P}/state`));
const log = async (h: H) => body(await h.call('GET', `${P}/log`)) as unknown as { action: string; targetId: string }[];

async function setup(items: object[], seed?: number) {
  const steps = [ext(items as never), ...items.map(() => ver('full'))];
  const h = harness(steps, {}, seed === undefined ? undefined : (s) => withLatency(s, seed, 4));
  const sid = await capture(h);
  const props = body(await extract(h, sid)).proposals as { id: string; type: string }[];
  const idOf = (type: string) => props.find((p) => p.type === type)!.id;
  return { h, sid, props, idOf };
}

describe('decide', () => {
  it('accept: aceita, registra no histórico, a proposta fica decidida e o item entra no estado com a evidência', async () => {
    const { h, idOf, sid } = await setup([claim]);
    const r = await decide(h, idOf('claim'), { kind: 'accept' });
    expect(r.status).toBe(200);
    expect(ResponseSchemas.decision.safeParse(r.body).success).toBe(true);
    expect(body(r).proposal.status).toBe('accepted');
    expect(body(r).log.action).toBe('accept');
    const st = await state(h);
    expect(st.items).toHaveLength(1);
    expect(st.items[0].evidence).toEqual([{ sourceId: sid, quote: 'Alpha is true here.', start: 0, end: 19 }]);
    expect(st.canUndo).toBe(true);
  });

  it('reject: rejeita sem tocar o estado', async () => {
    const { h, idOf } = await setup([claim]);
    const r = await decide(h, idOf('claim'), { kind: 'reject' });
    expect(body(r).proposal.status).toBe('rejected');
    expect(body(r).log.action).toBe('reject');
    expect((await state(h)).items).toEqual([]);
    expect((await state(h)).canUndo).toBe(false);
  });

  it('edit: texto novo, suporte unchecked, edited true, log accept_edited, estado com o texto editado', async () => {
    const { h, idOf } = await setup([claim]);
    const r = await decide(h, idOf('claim'), { kind: 'edit', text: 'Alpha é verdadeira.' });
    expect(r.status).toBe(200);
    const p = body(r).proposal;
    expect(p).toMatchObject({ status: 'accepted', edited: true, support: 'unchecked', text: 'Alpha é verdadeira.' });
    expect(checkProposalInvariants(p)).toEqual([]);
    expect(body(r).log.action).toBe('accept_edited');
    expect((await state(h)).items[0].text).toBe('Alpha é verdadeira.');
  });

  it('edit com o mesmo texto: pedido inválido (aceite sem editar); texto vazio também', async () => {
    const { h, idOf } = await setup([claim]);
    expect((await decide(h, idOf('claim'), { kind: 'edit', text: 'Alpha is true.' })).status).toBe(400);
    expect((await decide(h, idOf('claim'), { kind: 'edit', text: '   ' })).status).toBe(400);
    expect((await decide(h, idOf('claim'), { kind: 'accept', text: 'x' })).status).toBe(400);
    expect((await proposalsOf(h, 'pending'))).toHaveLength(1);
  });

  it('repetir a decisão: already_decided e o histórico NÃO duplica', async () => {
    const { h, idOf } = await setup([claim]);
    await decide(h, idOf('claim'), { kind: 'accept' });
    const before = await log(h);
    for (const kind of ['accept', 'reject'] as const) {
      const r = await decide(h, idOf('claim'), { kind });
      expect(r.status).toBe(409);
      expect(body(r)).toMatchObject({ code: 'not_allowed', block: 'already_decided' });
      expect(ApiError.safeParse(r.body).success).toBe(true);
    }
    expect(await log(h)).toEqual(before);
  });

  it('proposta inexistente: not_found; projeto desconhecido continua not_found', async () => {
    const { h } = await setup([claim]);
    expect((await decide(h, 'nao-existe', { kind: 'accept' })).status).toBe(404);
  });

  it('proposta obsoleta: aceitar recusa com stale; rejeitar continua possível', async () => {
    const { h, props } = await setup([claim, decision]); // as duas citam o mesmo trecho
    const [a, b] = [props.find((p) => p.type === 'claim')!.id, props.find((p) => p.type === 'decision')!.id];
    expect((await decide(h, a, { kind: 'accept' })).status).toBe(200);
    const views = await proposalsOf(h, 'pending');
    // aceitar a primeira só invalida a segunda se tocarem o mesmo alvo; se não, ela segue pendente e aceitável
    const other = views.find((v) => v.id === b)!;
    if (other.stale) {
      const r = await decide(h, b, { kind: 'accept' });
      expect(r.status).toBe(409);
      expect(body(r).code).toBe('stale');
      expect((await decide(h, b, { kind: 'reject' })).status).toBe(200);
    } else {
      expect(other.canAccept).toEqual({ ok: true });
    }
  });
});

describe('batchAccept', () => {
  it('aceita só as elegíveis; recusa com código as outras; id inexistente não derruba o lote', async () => {
    const { h, idOf } = await setup([question, claim, decision]);
    const r = await batch(h, [idOf('question'), idOf('claim'), idOf('decision'), 'fantasma']);
    expect(r.status).toBe(200);
    expect(ResponseSchemas.batchAccept.safeParse(r.body).success).toBe(true);
    const b = body(r);
    expect(b.accepted).toEqual([idOf('question')]);
    expect(b.refused).toEqual([
      { id: idOf('claim'), code: 'needs_individual_review' },
      { id: idOf('decision'), code: 'decision_individual_only' },
      { id: 'fantasma', code: 'core_refused' },
    ]);
    expect(b.log).toHaveLength(1);
    expect(b.log[0].action).toBe('accept_batch');
    // `proposals` traz o estado ATUAL das propostas existentes (aceitas e recusadas), não o de antes do lote
    expect(b.proposals.map((p: any) => [p.id, p.status])).toEqual([
      [idOf('question'), 'accepted'], [idOf('claim'), 'pending'], [idOf('decision'), 'pending'],
    ]);
    for (const p of b.proposals) expect(checkProposalInvariants(p)).toEqual([]);
  });

  it('ids repetidos contam uma vez; repetir o lote recusa com already_decided e não duplica o histórico', async () => {
    const { h, idOf } = await setup([question]);
    const q = idOf('question');
    const first = body(await batch(h, [q, q]));
    expect(first.accepted).toEqual([q]);
    expect(first.refused).toEqual([]);
    const before = await log(h);
    const again = body(await batch(h, [q]));
    expect(again.accepted).toEqual([]);
    expect(again.refused).toEqual([{ id: q, code: 'already_decided' }]);
    expect(await log(h)).toEqual(before);
  });

  it('pedido inválido: ids vazio, ids demais, campo extra', async () => {
    const { h } = await setup([question]);
    expect((await h.call('POST', `${P}/proposals/batch-accept`, { ids: [] })).status).toBe(400);
    expect((await h.call('POST', `${P}/proposals/batch-accept`, { ids: Array.from({ length: 501 }, (_, i) => `i${i}`) })).status).toBe(400);
    expect((await h.call('POST', `${P}/proposals/batch-accept`, { ids: ['a'], extra: 1 })).status).toBe(400);
  });
});

describe('undo', () => {
  it('compensa a decisão mais recente, nunca apaga o histórico, e só uma de cada vez (pilha)', async () => {
    const { h, idOf } = await setup([question, claim]);
    await decide(h, idOf('question'), { kind: 'accept' });
    await decide(h, idOf('claim'), { kind: 'accept' });
    const ps = (await h.store.project(PROJECT))!;
    const coreBefore = (await ps.entries()).length;
    const auditBefore = await log(h);

    const r = await undo(h);
    expect(r.status).toBe(200);
    expect(ResponseSchemas.undo.safeParse(r.body).success).toBe(true);
    expect(body(r).log.action).toBe('undo');
    expect(body(r).proposal.id).toBe(idOf('claim'));
    expect(checkProposalInvariants(body(r).proposal)).toEqual([]);
    // histórico: só cresce
    expect((await ps.entries()).length).toBe(coreBefore + 1);
    expect((await log(h)).slice(0, auditBefore.length)).toEqual(auditBefore);
    expect(verifyAuditChain((await h.call('GET', `${P}/log`)).body as never).ok).toBe(true);
    expect((await state(h)).items.map((i: any) => i.text)).toEqual(['Is Gamma ready?']);

    expect((await state(h)).canUndo).toBe(true); // a pergunta ainda pode ser desfeita
    expect((await undo(h)).status).toBe(200);
    expect((await state(h)).canUndo).toBe(false);
    const none = await undo(h);
    expect(none.status).toBe(409);
    expect(body(none).code).toBe('not_allowed');
    expect((await state(h)).items).toEqual([]);
  });

  it('desfazer não ressuscita a proposta: ela fica fechada (já decidida) e não aceita nova decisão', async () => {
    const { h, idOf } = await setup([claim]);
    await decide(h, idOf('claim'), { kind: 'accept' });
    await undo(h);
    const all = await proposalsOf(h);
    expect(all[0]!.status).toBe('rejected');
    expect(all[0]!.canAccept).toEqual({ ok: false, code: 'already_decided' });
    expect((await decide(h, idOf('claim'), { kind: 'accept' })).status).toBe(409);
  });

  it('sem nada decidido: não há o que desfazer', async () => {
    const { h } = await setup([claim]);
    expect((await state(h)).canUndo).toBe(false);
    expect((await undo(h)).status).toBe(409);
  });

  it('uma captura (mudança humana) não é desfeita por este botão', async () => {
    const h = harness();
    await capture(h);
    expect((await state(h)).canUndo).toBe(false);
    expect((await undo(h)).status).toBe(409);
  });
});

describe('conformidade com as fixtures do contrato (formas emitidas parseiam com os schemas e invariantes)', () => {
  it('erro com `block`, decisão, lote, desfazer, estado, propostas e fonte', async () => {
    const { h, idOf, sid } = await setup([question, claim]);
    await batch(h, [idOf('question')]);
    const again = await decide(h, idOf('question'), { kind: 'accept' });
    expect(ResponseSchemas.error.safeParse(again.body).success).toBe(true);
    expect(body(again).block).toBe('already_decided');
    expect(ResponseSchemas.state.safeParse((await h.call('GET', `${P}/state`)).body).success).toBe(true);
    expect(ResponseSchemas.proposals.safeParse((await h.call('GET', `${P}/proposals`)).body).success).toBe(true);
    expect(ResponseSchemas.getSource.safeParse((await h.call('GET', `${P}/sources/${sid}`)).body).success).toBe(true);
    expect(ResponseSchemas.log.safeParse((await h.call('GET', `${P}/log`)).body).success).toBe(true);
  });
});

describe('concorrência (armazém com latência simulada; várias sementes)', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];

  it('duas decisões na mesma proposta: uma passa, a outra já decidida, histórico sem duplicar', async () => {
    for (const seed of seeds) {
      const { h, idOf } = await setup([claim], seed);
      const id = idOf('claim');
      const rs = await Promise.all([decide(h, id, { kind: 'accept' }), decide(h, id, { kind: 'reject' }), decide(h, id, { kind: 'accept' })]);
      expect(rs.filter((r) => r.status === 200), `semente ${seed}`).toHaveLength(1);
      for (const r of rs.filter((x) => x.status !== 200)) expect(body(r)).toMatchObject({ code: 'not_allowed', block: 'already_decided' });
      const decisions = (await log(h)).filter((e) => e.targetId === id && e.action !== 'propose');
      expect(decisions, `semente ${seed}`).toHaveLength(1);
    }
  });

  it('lote concorrente com decisão individual da mesma proposta: decidida uma única vez', async () => {
    for (const seed of seeds) {
      const { h, idOf } = await setup([question, claim2], seed);
      const q = idOf('question');
      const [b, d] = await Promise.all([batch(h, [q]), decide(h, q, { kind: 'reject' })]);
      expect(b.status).toBe(200);
      const decidedByBatch = body(b).accepted.length === 1;
      expect(d.status === 200, `semente ${seed}`).toBe(!decidedByBatch);
      const decisions = (await log(h)).filter((e) => e.targetId === q && e.action !== 'propose');
      expect(decisions, `semente ${seed}`).toHaveLength(1);
    }
  });

  it('desfazer concorrente com captura nova: as duas acontecem, nenhuma perde a outra, cadeia íntegra', async () => {
    for (const seed of seeds) {
      const { h, idOf } = await setup([claim], seed);
      await decide(h, idOf('claim'), { kind: 'accept' });
      const [u, c] = await Promise.all([undo(h), h.call('POST', `${P}/sources`, { name: 'b.txt', text: 'Outro texto.' })]);
      expect(u.status, `semente ${seed}`).toBe(200);
      expect(c.status, `semente ${seed}`).toBe(201);
      const actions = (await log(h)).map((e) => e.action);
      expect(actions.filter((a) => a === 'undo')).toHaveLength(1);
      expect(actions.filter((a) => a === 'capture_source')).toHaveLength(2);
      expect((await state(h)).items).toEqual([]);
      expect(verifyAuditChain((await h.call('GET', `${P}/log`)).body as never).ok).toBe(true);
    }
  });

  it('extração concorrente com decisão, desfazer e captura: nada se perde e nada intercala', async () => {
    for (const seed of seeds) {
      const steps = [ext([question, claim]), ver('full'), ver('full'), ext([claim2]), ver('full')];
      const h = harness(steps, {}, (s) => withLatency(s, seed, 4));
      const sid = await capture(h);
      const props = body(await extract(h, sid)).proposals as { id: string; type: string }[];
      const q = props.find((p) => p.type === 'question')!.id;
      const c = props.find((p) => p.type === 'claim')!.id;
      await decide(h, q, { kind: 'accept' });
      const rs = await Promise.all([
        extract(h, sid), decide(h, c, { kind: 'accept' }), undo(h), h.call('POST', `${P}/sources`, { name: 'c.txt', text: 'Mais um.' }),
      ]);
      for (const r of rs) expect(r.status, `semente ${seed}`).toBeLessThan(300);
      expect(await proposalsOf(h), `semente ${seed}`).toHaveLength(3);
      const entries = await log(h);
      // cada ação uma vez só
      expect(entries.filter((e) => e.action === 'undo')).toHaveLength(1);
      expect(entries.filter((e) => e.action === 'propose')).toHaveLength(3);
      expect(verifyAuditChain((await h.call('GET', `${P}/log`)).body as never).ok).toBe(true);
    }
  });
});

describe('toda rota de escrita passa pela fila do projeto (observado: núcleo e auditoria na MESMA ordem)', () => {
  /** Sem fila, duas escritas intercalam: a versão 2 do núcleo pode ser auditada antes da 1. Com fila, nunca. */
  const consistent = async (h: H) => {
    const ps = (await h.store.project(PROJECT))!;
    const entries = await ps.entries();
    const audit = await ps.audit();
    let last = 0;
    for (const a of audit) {
      if (a.coreVersion === undefined) continue;
      if (a.coreVersion <= last) return `auditoria fora de ordem: v${a.coreVersion} depois de v${last}`;
      last = a.coreVersion;
      const e = entries[a.coreVersion - 1]!;
      if (a.action === 'undo' || a.action === 'capture_source') continue; // audita o alvo (a proposta desfeita, o item-fonte), não a mudança do núcleo
      if (e.changeId !== a.targetId) return `auditoria de ${a.targetId} aponta a versão ${a.coreVersion}, que é de ${e.changeId}`;
    }
    return 'ok';
  };
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  /** Espia as chamadas que ESCREVEM, etiquetadas com o pedido que as fez (AsyncLocalStorage). */
  const WRITES = ['review', 'undo', 'submitHuman', 'appendAudit', 'proposeChange', 'saveMeta', 'saveSource'];
  const als = new AsyncLocalStorage<number>();
  const spy = (inner: Store, events: number[]): Store => ({
    async project(id) {
      const ps = await inner.project(id);
      if (ps === undefined) return undefined;
      return new Proxy(ps, {
        get(t, prop) {
          const v = Reflect.get(t, prop) as unknown;
          if (typeof v !== 'function') return v;
          return (...a: unknown[]) => {
            const tag = als.getStore();
            if (tag !== undefined && WRITES.includes(String(prop))) events.push(tag);
            return (v as (...x: unknown[]) => unknown).apply(t, a);
          };
        },
      }) as ProjectStore;
    },
  });
  /** Cada pedido escreve num bloco CONTÍGUO: nenhum outro pedido escreve entre a primeira e a última escrita dele. */
  const contiguous = (events: number[]): boolean => {
    const closed = new Set<number>();
    let cur: number | undefined;
    for (const e of events) {
      if (e === cur) continue;
      if (closed.has(e)) return false;
      if (cur !== undefined) closed.add(cur);
      cur = e;
    }
    return true;
  };

  it('várias decisões, um lote e um desfazer ao mesmo tempo: escritas em blocos, núcleo e auditoria na mesma ordem', async () => {
    for (const seed of seeds) {
      const events: number[] = [];
      const steps = [ext([question, claim, claim2, decision]), ver('full'), ver('full'), ver('full'), ver('full')];
      const h = harness(steps, {}, (s) => spy(withLatency(s, seed, 4), events));
      const sid = await capture(h);
      const props = body(await extract(h, sid)).proposals as { id: string; type: string }[];
      const id = (t: string) => props.find((p) => p.type === t)!.id;
      await decide(h, id('question'), { kind: 'accept' });
      events.length = 0;
      const calls: (() => Promise<unknown>)[] = [
        () => decide(h, id('claim'), { kind: 'accept' }), () => decide(h, id('decision'), { kind: 'reject' }),
        () => decide(h, id('claim'), { kind: 'edit', text: 'Outro texto.' }), () => undo(h),
        () => batch(h, props.map((p) => p.id)), () => h.call('POST', `${P}/sources`, { name: 'z.txt', text: 'Zzz.' }),
      ];
      await Promise.all(calls.map((c, n) => als.run(n, c)));
      expect(events.length, `semente ${seed}`).toBeGreaterThan(6);
      expect(contiguous(events), `semente ${seed}: ${events.join('')}`).toBe(true);
      expect(await consistent(h), `semente ${seed}`).toBe('ok');
    }
  });

  const QS = ['Is A ready?', 'Is B ready?', 'Is C ready?', 'Is D ready?', 'Is E ready?', 'Is F ready?'];
  const qItems = QS.map((q) => ({ type: 'question', statement: q, quote: q }));
  const many = async (seed: number, events: number[]) => {
    const steps = [ext(qItems as never), ...qItems.map(() => ver('full'))];
    const h = harness(steps, {}, (s) => spy(withLatency(s, seed, 5), events));
    const sid = await capture(h, QS.join('\n\n'));
    const props = body(await extract(h, sid)).proposals as { id: string; text: string }[];
    return { h, ids: props.map((p) => p.id) };
  };
  const seeds20 = Array.from({ length: 20 }, (_, i) => i + 1);

  it('lote (várias escritas) concorrente com decisões: o lote escreve em bloco', async () => {
    for (const seed of seeds20) {
      const events: number[] = [];
      const { h, ids } = await many(seed, events);
      events.length = 0;
      const calls = [
        () => batch(h, ids.slice(0, 4)), () => decide(h, ids[4]!, { kind: 'accept' }), () => decide(h, ids[5]!, { kind: 'reject' }),
      ];
      await Promise.all(calls.map((c, n) => als.run(n, c)));
      expect(events.length, `semente ${seed}`).toBeGreaterThanOrEqual(8);
      expect(contiguous(events), `semente ${seed}: ${events.join('')}`).toBe(true);
    }
  });

  it('desfazer concorrente com decisões: escreve em bloco', async () => {
    for (const seed of seeds20) {
      const events: number[] = [];
      const { h, ids } = await many(seed, events);
      await decide(h, ids[0]!, { kind: 'accept' });
      events.length = 0;
      // O desfazer chega no meio das decisões (a leitura que as precede leva dezenas de ms com esta latência).
      const late = <T>(ms: number, f: () => Promise<T>) => async () => { await new Promise((r) => setTimeout(r, ms)); return f(); };
      const calls = [
        late(10 + ((seed * 7) % 60), () => undo(h)), () => decide(h, ids[1]!, { kind: 'accept' }),
        () => decide(h, ids[2]!, { kind: 'reject' }), () => decide(h, ids[3]!, { kind: 'accept' }),
      ];
      await Promise.all(calls.map((c, n) => als.run(n, c)));
      expect(contiguous(events), `semente ${seed}: ${events.join('')}`).toBe(true);
    }
  });
});
