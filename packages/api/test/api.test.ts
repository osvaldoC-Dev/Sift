import { contentHash, normalizeText } from '@sift/core';
import { Routes, checkProposalInvariants, ProposalView } from '@sift/contract';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain, type Store } from '../src';
import {
  PROJECT, TEXT, capture, claim, claim2, decision, ext, extract, harness, proposalsOf, question, ver,
} from './helpers';

const P = `/projects/${PROJECT}`;
const body = (r: { body: unknown }) => r.body as Record<string, any>;

describe('A. forma: rotas, validação de pedido, validação de resposta', () => {
  it('1. só as rotas do contrato existem; o resto é not_found', async () => {
    const h = harness();
    for (const spec of Object.values(Routes)) {
      const [method, rest] = spec.split(' ') as [string, string];
      const path = rest.split('?')[0]!.replace(':projectId', PROJECT).replace(':sourceId', 'x').replace(':proposalId', 'x');
      const r = await h.call(method, path, method === 'POST' ? {} : undefined);
      // 404 só é aceitável para recursos inexistentes (fonte/proposta); nunca "rota não encontrada"
      expect(r.status === 404 ? body(r).message : 'ok').not.toBe('rota não encontrada');
    }
    for (const [m, p] of [['GET', `${P}/segredo`], ['DELETE', `${P}/state`], ['PUT', `${P}/sources`], ['GET', '/']] as const) {
      const r = await h.call(m, p);
      expect(r.status).toBe(404);
      expect(body(r)).toEqual({ code: 'not_found', message: 'rota não encontrada' });
    }
    expect(body(await h.call('GET', '/projects/outro/state'))).toMatchObject({ code: 'not_found' });
  });

  it('2. resposta fora do contrato vira erro interno e nada dela sai ao cliente', async () => {
    const h = harness([], {}, (s) => ({
      project: async (id) => {
        const ps = await s.project(id);
        if (!ps) return ps;
        return new Proxy(ps, {
          get(t, k, r) {
            if (k === 'getSource') {
              return async (sid: string) => {
                const rec = await t.getSource(sid);
                return rec && { ...rec, name: '' }; // nome vazio: o contrato proíbe
              };
            }
            const v = Reflect.get(t, k, r);
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      },
    }));
    const id = await capture(h);
    const r = await h.call('GET', `${P}/sources/${id}`);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ code: 'internal', message: 'erro interno' });
    expect(JSON.stringify(r)).not.toContain('ata.txt');
    expect(h.logs.some((l) => l.event === 'response_invalid')).toBe(true);
  });

  it('3. proposta que viola as invariantes do contrato não sai (erro interno)', async () => {
    // Um armazém que afirma "verificador falhou" para uma proposta de suporte full: o contrato proíbe a combinação.
    const h = harness([ext([claim]), ver('full')], {}, (s) => ({
      project: async (id) => {
        const ps = await s.project(id);
        if (!ps) return ps;
        return new Proxy(ps, {
          get(t, k, r) {
            if (k === 'getMeta') return async (c: never) => { const m = await t.getMeta(c); return m && { ...m, verifierFailed: true }; };
            const v = Reflect.get(t, k, r);
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      },
    }));
    const id = await capture(h);
    const r = await extract(h, id);
    expect(r.status).toBe(500);
    expect(body(r)).toEqual({ code: 'internal', message: 'erro interno' });
    expect(h.logs.find((l) => l.event === 'response_invalid')?.detail).toContain('verificador falhou');
  });

  it('3b. toda ProposalView emitida (extração e listagem) passa checkProposalInvariants', async () => {
    const h = harness([ext([claim, claim2, question, decision]), ver('full'), ver('partial'), ver('full'), ver('full')]);
    const id = await capture(h);
    const r = await extract(h, id);
    const all = [...body(r).proposals, ...(await proposalsOf(h))];
    expect(all).toHaveLength(8);
    for (const p of all) {
      expect(ProposalView.safeParse(p).success).toBe(true);
      expect(checkProposalInvariants(p as never)).toEqual([]);
    }
  });

  it('4. pedido inválido, com campo desconhecido ou acima do limite -> invalid_request', async () => {
    const h = harness();
    const bad: [string, string, unknown][] = [
      ['POST', `${P}/sources`, { name: 'a', text: 'x', status: 'accepted' }], // campo desconhecido
      ['POST', `${P}/sources`, { name: '', text: 'x' }],
      ['POST', `${P}/sources`, { name: 'a' }],
      ['POST', `${P}/sources`, { name: 'a', text: 'x'.repeat(2_000_001) }], // acima do limite do contrato
      ['POST', `${P}/sources`, { name: 'a'.repeat(201), text: 'x' }],
      ['POST', `${P}/sources`, { name: 'a', text: 'x', capturedAt: 'ontem' }],
      ['POST', `${P}/sources`, { name: 'a', text: '   \n  ' }],
      ['POST', `${P}/sources`, 'texto solto'],
      ['POST', `${P}/extractions`, {}],
      ['POST', `${P}/extractions`, { sourceId: 'x', model: 'outro' }],
    ];
    for (const [m, p, b] of bad) {
      const r = await h.call(m, p, b);
      expect(r.status, JSON.stringify(b).slice(0, 60)).toBe(400);
      expect(body(r).code).toBe('invalid_request');
    }
    expect(body(await h.call('GET', `${P}/proposals`, undefined, { status: 'qualquer' })).code).toBe('invalid_request');
    expect(body(await h.api.handle({ method: 'POST', path: `${P}/sources`, rawBody: '{nao-json' })).code).toBe('invalid_request');
    expect(body(await h.api.handle({ method: 'POST', path: `${P}/sources` })).code).toBe('invalid_request');
  });

  it('4b. a mensagem de pedido inválido nunca repete o texto recebido', async () => {
    const h = harness();
    const r = await h.call('POST', `${P}/sources`, { name: 'a', text: 'SEGREDO-NO-TEXTO', extra: 'SEGREDO-NO-CAMPO' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r)).not.toContain('SEGREDO');
  });
});

describe('C. fontes e citações', () => {
  it('8. a captura guarda o texto como instantâneo, com o hash do núcleo; offsets valem sobre esse texto', async () => {
    const h = harness([ext([claim, question]), ver('full'), ver('full')]);
    const raw = 'Café aberto.\n\n' + TEXT; // "e + acento" decomposto: o núcleo normaliza para NFC
    const id = await capture(h, raw);
    const src = body(await h.call('GET', `${P}/sources/${id}`)).source;
    expect(src.text).toBe(normalizeText(raw));
    expect(src.text).not.toBe(raw);
    expect(src.contentHash).toBe(contentHash(normalizeText(raw)));
    const props = body(await extract(h, id)).proposals as { quote: { text: string; start: number; end: number; sourceId: string } }[];
    expect(props).toHaveLength(2);
    for (const p of props) {
      expect(p.quote.sourceId).toBe(id);
      expect(Array.from(src.text as string).slice(p.quote.start, p.quote.end).join('')).toBe(p.quote.text);
    }
  });

  it('9. found/start/end: citação repetida -> found 2 e start na primeira ocorrência (quem acha é o núcleo)', async () => {
    const text = 'Is Gamma ready?\n\nOutra coisa aqui.\n\nIs Gamma ready?';
    const h = harness([ext([question]), ver('full')]);
    const id = await capture(h, text);
    const r = await extract(h, id);
    const p = body(r).proposals[0];
    expect(p.quote).toMatchObject({ found: 2, start: 0, end: 15 });
    expect(p.canBatchAccept).toEqual({ ok: false, code: 'citation_ambiguous' });
    expect(p.canAccept).toEqual({ ok: true });
    expect(body(r).ambiguousCitations).toBe(1);
  });

  it('10. capturedAt e originLabel são guardados e não mudam nada na lógica', async () => {
    const mk = async (extra: object) => {
      const h = harness([ext([claim]), ver('full')]);
      const id = await h.call('POST', `${P}/sources`, { name: 'a', text: TEXT, ...extra });
      const sid = body(id).source.id as string;
      const props = body(await extract(h, sid)).proposals;
      return { h, sid, resp: body(id), props };
    };
    const plain = await mk({});
    const rich = await mk({ capturedAt: '2020-01-01T10:00:00+01:00', originLabel: 'ata da reunião' });
    expect(rich.resp.source.capturedAt).toBe('2020-01-01T10:00:00+01:00');
    expect(plain.resp.source.capturedAt).toBeUndefined();
    const ps = (await rich.h.store.project(PROJECT))!;
    expect(await ps.getSource(rich.sid)).toMatchObject({ originLabel: 'ata da reunião', originType: 'human' });
    const strip = (p: any) => ({ ...p, id: 0, runId: 0, quote: { ...p.quote, sourceId: 0 } });
    expect(rich.props.map(strip)).toEqual(plain.props.map(strip));
  });

  it('10b. fonte de IA exige originRunId de uma execução que existe; humano não pode tê-lo (contrato 0.3.0)', async () => {
    const h = harness([ext([claim]), ver('full')]);
    const sid = await capture(h);
    const runId = body(await extract(h, sid)).runId as string;
    const post = (b: object) => h.call('POST', `${P}/sources`, { name: 'a', text: TEXT + ' ', ...b });
    expect((await post({ originType: 'ai' })).status).toBe(400); // sem originRunId
    expect((await post({ originType: 'ai', originRunId: 'run-que-nao-existe' })).status).toBe(400);
    expect((await post({ originType: 'human', originRunId: runId })).status).toBe(400);
    const ok = await post({ originType: 'ai', originRunId: runId });
    expect(ok.status).toBe(201);
    const ps = (await h.store.project(PROJECT))!;
    expect(await ps.getSource(body(ok).source.id)).toMatchObject({ originType: 'ai', originRunId: runId });
  });
});

describe('D. extração', () => {
  it('11/14. com modelo falso, extrair só cria propostas PENDENTES: nada é aceito nem rejeitado', async () => {
    const h = harness([ext([claim, question]), ver('full'), ver('full')]);
    const id = await capture(h);
    const r = await extract(h, id);
    expect(r.status).toBe(200);
    expect(body(r)).toMatchObject({ ok: true, modelId: 'fake-extractor', discarded: 0 });
    const ps = (await h.store.project(PROJECT))!;
    expect((await proposalsOf(h)).map((p) => p.status)).toEqual(['pending', 'pending']);
    expect((await ps.entries()).map((e) => e.decision)).toEqual(['accept']); // só a captura da fonte (humana)
    expect((await ps.state()).version).toBe(1);
    expect(await proposalsOf(h, 'accepted')).toEqual([]);
    expect(await proposalsOf(h, 'rejected')).toEqual([]);
    expect(h.model.calls).toHaveLength(3); // 1 extração + 2 verificações; nenhuma outra chamada
  });

  it('12. falha do fornecedor -> ok:false, erro tipado, retryable; nunca lista vazia a fingir sucesso', async () => {
    const h = harness([{ error: 'tempo esgotado sk-chave-secreta' }]);
    const id = await capture(h);
    const r = await extract(h, id);
    expect(body(r)).toEqual({
      ok: false,
      error: { code: 'provider_failure', retryable: true, message: 'O modelo não respondeu. Tente de novo.' },
    });
    expect(body(r).proposals).toBeUndefined();
    expect(JSON.stringify([r, h.logs])).not.toContain('sk-chave-secreta');
    const ps = (await h.store.project(PROJECT))!;
    expect(await ps.changes()).toHaveLength(1); // só a captura (humana): nada foi proposto
  });

  it('12b. saída do modelo fora do formato -> ok:false schema_invalid (retryable), nada proposto', async () => {
    const h = harness([{ output: { itens: [] } }]);
    const id = await capture(h);
    const r = await extract(h, id);
    expect(body(r)).toMatchObject({ ok: false, error: { code: 'schema_invalid', retryable: true } });
    expect(await proposalsOf(h)).toEqual([]);
  });

  it('12c. modelo sem resposta ou abortado -> provider_failure NÃO retryable', async () => {
    const h = harness([]); // roteiro vazio: no_response
    const id = await capture(h);
    expect(body(await extract(h, id))).toMatchObject({ ok: false, error: { code: 'provider_failure', retryable: false } });
  });

  it('13. verificador inválido -> item mantido, unchecked e verifierFailed; os outros não são afetados; modelId sempre', async () => {
    const h = harness([ext([claim, question]), { output: { verdict: 'talvez' } }, ver('full')]);
    const id = await capture(h);
    const r = await extract(h, id);
    expect(body(r).ok).toBe(true);
    expect(body(r).modelId).toBe('fake-extractor');
    const [a, b] = body(r).proposals;
    expect(a).toMatchObject({ type: 'claim', support: 'unchecked', verifierFailed: true, edited: false });
    expect(a.canBatchAccept.ok).toBe(false);
    expect(a.canAccept).toEqual({ ok: true }); // revisão individual continua possível
    expect(b).toMatchObject({ type: 'question', support: 'full', verifierFailed: false });
  });

  it('11b. extração sobre fonte inexistente -> not_found; nada é chamado no modelo', async () => {
    const h = harness([]);
    const r = await extract(h, 'nao-existe');
    expect(r.status).toBe(404);
    expect(h.model.calls).toHaveLength(0);
  });

  it('proposta a proposta: type, text, runId, originType e provisional vêm do núcleo', async () => {
    const h = harness([ext([claim, question, decision]), ver('full'), ver('full'), ver('full')]);
    const id = await capture(h);
    const props = body(await extract(h, id)).proposals;
    expect(props.map((p: any) => [p.type, p.text, p.provisional, p.originType, p.originLabel])).toEqual([
      ['claim', 'Alpha is true.', true, 'ai', 'fake-extractor'],
      ['question', 'Is Gamma ready?', false, 'ai', 'fake-extractor'],
      ['decision', 'Ship Alpha first.', true, 'ai', 'fake-extractor'],
    ]);
    expect(new Set(props.map((p: any) => p.runId)).size).toBe(1);
  });
});

describe('E/F/G. estado, histórico, reinício, segurança', () => {
  it('19. reiniciar o servidor (nova API sobre o mesmo armazém) não aceita nem rejeita nada', async () => {
    const h = harness([ext([claim, question]), ver('full'), ver('full')]);
    const id = await capture(h);
    await extract(h, id);
    const before = JSON.stringify([await proposalsOf(h), body(await h.call('GET', `${P}/state`)), body(await h.call('GET', `${P}/log`))]);
    const { createApi } = await import('../src');
    const again = createApi({ store: h.store, model: h.model, clock: { now: () => '2026-11-08T00:00:00.000Z' }, ids: { next: () => 'zz' } });
    const call = (p: string) => again.handle({ method: 'GET', path: `${P}/${p}` });
    const after = JSON.stringify([(await call('proposals')).body, (await call('state')).body, (await call('log')).body]);
    expect(after).toBe(before);
  });

  it('estado: sem itens aceitos o estado está vazio; headHash é o da cadeia do núcleo', async () => {
    const h = harness([ext([claim]), ver('full')]);
    const id = await capture(h);
    await extract(h, id);
    const st = body(await h.call('GET', `${P}/state`));
    expect(st.items).toEqual([]);
    const ps = (await h.store.project(PROJECT))!;
    const entries = await ps.entries();
    expect(st.headHash).toBe(entries[entries.length - 1]!.entryHash);
    expect(body(await harness().call('GET', `${P}/state`))).toEqual({ items: [], relations: [], headHash: null, canUndo: false });
  });

  it('estado depois de uma aceitação (feita direto no armazém): item com texto e fonte', async () => {
    const h = harness([ext([claim]), ver('full')]);
    const sid = await capture(h);
    const prop = body(await extract(h, sid)).proposals[0];
    const ps = (await h.store.project(PROJECT))!;
    const out = await ps.review({ changeId: prop.id, decision: 'accept', reviewer: { kind: 'human', id: 'u1' as never } });
    expect(out.ok).toBe(true);
    const st = body(await h.call('GET', `${P}/state`));
    expect(st.items).toHaveLength(1);
    expect(st.items[0]).toMatchObject({ type: 'claim', text: 'Alpha is true.', sourceIds: [sid] });
    const accepted = await proposalsOf(h, 'accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.canAccept).toEqual({ ok: false, code: 'already_decided' });
    expect(checkProposalInvariants(accepted[0] as never)).toEqual([]);
  });

  it('17. o histórico é uma cadeia de hashes conferida; alterar uma entrada quebra a verificação', async () => {
    const h = harness([ext([claim, question]), ver('full'), ver('full')]);
    const id = await capture(h);
    await extract(h, id);
    const log = body(await h.call('GET', `${P}/log`)) as unknown as { seq: number; action: string; targetId: string; prevHash: string | null; hash: string; at: string }[];
    expect(log.map((e) => e.action)).toEqual(['capture_source', 'propose', 'propose']);
    expect(log[0]!.prevHash).toBeNull();
    expect(log[1]!.prevHash).toBe(log[0]!.hash);
    expect(verifyAuditChain(log as never)).toEqual({ ok: true });
    const tamper = (i: number, patch: object) => log.map((e, k) => (k === i ? { ...e, ...patch } : e));
    expect(verifyAuditChain(tamper(1, { targetId: 'outro' }) as never)).toMatchObject({ ok: false, seq: 2, reason: 'hash_mismatch' });
    expect(verifyAuditChain(tamper(1, { action: 'accept' }) as never)).toMatchObject({ ok: false, reason: 'hash_mismatch' });
    expect(verifyAuditChain(tamper(2, { at: '2030-01-01T00:00:00.000Z' }) as never)).toMatchObject({ ok: false, reason: 'hash_mismatch' });
    expect(verifyAuditChain(tamper(1, { prevHash: 'a'.repeat(64) }) as never)).toMatchObject({ ok: false, reason: 'prev_hash_mismatch' });
    expect(verifyAuditChain([log[0]!, log[2]!] as never)).toMatchObject({ ok: false, reason: 'seq_out_of_order' });
    expect(verifyAuditChain(log.slice(1) as never)).toMatchObject({ ok: false });
  });

  it('a auditoria liga cada captura à versão do núcleo que a gravou', async () => {
    const h = harness();
    const id = await capture(h);
    const ps = (await h.store.project(PROJECT))!;
    const [entry] = await ps.audit();
    const core = (await ps.entries())[0]!;
    expect(entry).toMatchObject({ action: 'capture_source', targetId: id, coreVersion: core.version });
    expect(core.appliedOperations[0]).toMatchObject({ op: 'create_item', type: 'source', itemId: id });
  });

  it('21. nenhuma chave nem texto de fonte nos logs; erros sem pilha para o cliente', async () => {
    const h = harness([{ error: 'falhou com sk-live-123456' }]);
    const writes: string[] = [];
    const orig = [console.log, console.error, console.warn, console.info];
    for (const k of ['log', 'error', 'warn', 'info'] as const) (console as any)[k] = (...a: unknown[]) => writes.push(a.join(' '));
    let all: string;
    try {
      const id = await capture(h, 'MARCADOR-DE-FONTE-998 é um texto secreto.\n\nOutro parágrafo qualquer.');
      const r = await extract(h, id);
      const bad = await h.call('POST', `${P}/sources`, { name: 'a', text: 'MARCADOR-DE-FONTE-998', extra: 1 });
      all = JSON.stringify({ logs: h.logs, writes, errs: [r, bad] });
    } finally {
      [console.log, console.error, console.warn, console.info] = orig;
    }
    expect(all).not.toContain('MARCADOR-DE-FONTE-998');
    expect(all).not.toContain('sk-live-123456');
    expect(h.logs.length).toBeGreaterThan(0);
  });

  it('21b. exceção inesperada -> erro interno genérico, sem pilha nem mensagem original', async () => {
    const h = harness([], {}, (s) => ({
      project: async (id) => {
        const ps = await s.project(id);
        if (!ps) return ps;
        return new Proxy(ps, {
          get(t, k, r) {
            if (k === 'state') return async () => { throw new Error('explodiu com MARCADOR-X em /home/segredo/arquivo.ts:12'); };
            const v = Reflect.get(t, k, r);
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      },
    }));
    const r = await h.call('GET', `${P}/state`);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ code: 'internal', message: 'erro interno' });
    expect(JSON.stringify([r, h.logs])).not.toMatch(/MARCADOR-X|segredo|\.ts:|\bat \w/);
  });

  it('21c. CORS fechado por omissão; abre só para as origens configuradas', async () => {
    const closed = harness();
    const get = (h: typeof closed, origin: string) =>
      h.api.handle({ method: 'GET', path: `${P}/state`, headers: { origin } });
    expect((await get(closed, 'https://app.exemplo')).headers['access-control-allow-origin']).toBeUndefined();
    expect(await closed.api.handle({ method: 'OPTIONS', path: `${P}/state`, headers: { origin: 'https://app.exemplo' } })).toMatchObject({ status: 404 });

    const open = harness([], { corsOrigins: ['https://app.exemplo'] });
    expect((await get(open, 'https://app.exemplo')).headers['access-control-allow-origin']).toBe('https://app.exemplo');
    expect((await get(open, 'https://mau.exemplo')).headers['access-control-allow-origin']).toBeUndefined();
    const pre = await open.api.handle({ method: 'OPTIONS', path: `${P}/state`, headers: { origin: 'https://app.exemplo' } });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('https://app.exemplo');
    const erro = await open.api.handle({ method: 'GET', path: '/nada', headers: { origin: 'https://app.exemplo' } });
    expect(erro.headers['access-control-allow-origin']).toBe('https://app.exemplo'); // erros também levam CORS
  });

  it('pedidos de escrita simultâneos no mesmo projeto não intercalam (armazém lento: auditoria contígua, ids distintos)', async () => {
    // Cada chamada ao armazém cede a vez ao laço de eventos: sem a fila por projeto, as capturas leem a mesma versão
    // base e as seguintes falham com conflito.
    const slow = (s: Store): Store => ({
      project: async (id) => {
        const ps = await s.project(id);
        if (!ps) return ps;
        return new Proxy(ps, {
          get(t, k, r) {
            const v = Reflect.get(t, k, r);
            if (typeof v !== 'function') return v;
            return async (...a: unknown[]) => {
              await new Promise((res) => setTimeout(res, 1));
              return (v as (...x: unknown[]) => unknown).apply(t, a);
            };
          },
        });
      },
    });
    const h = harness([], {}, slow);
    const rs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => h.call('POST', `${P}/sources`, { name: `s${i}`, text: `texto ${i}\n\nmais` })),
    );
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(new Set(rs.map((r) => body(r).source.id)).size).toBe(6);
    const log = body(await h.call('GET', `${P}/log`)) as unknown as { seq: number }[];
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(verifyAuditChain(log as never)).toEqual({ ok: true });
  });

  it('17b. trocar uma entrada anterior por outra válida e religar o encadeamento quebra as seguintes', async () => {
    const h = harness([ext([claim, question]), ver('full'), ver('full')]);
    await extract(h, await capture(h));
    const log = body(await h.call('GET', `${P}/log`)) as unknown as { seq: number; action: string; targetId: string; prevHash: string | null; hash: string; at: string }[];
    const { auditHash } = await import('../src');
    const forgedBase = { seq: 1, action: 'capture_source' as const, targetId: 'outra-fonte', at: log[0]!.at };
    const forged0 = { ...forgedBase, prevHash: null, hash: auditHash(null, forgedBase) };
    const relinked = [forged0, { ...log[1]!, prevHash: forged0.hash }, ...log.slice(2)];
    expect(verifyAuditChain(relinked as never)).toMatchObject({ ok: false, seq: 2, reason: 'hash_mismatch' });
  });
});
