import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TEXT_KIND, analyzeChange, isBatchEligible, validateChange, verifyEvidence,
  type Change, type TextEvidence,
} from '@sift/core';
import { InMemoryLedger, fixedClock, sequentialIds } from '@sift/core/testing';
import { extractFromSource, ModelPortError, type ModelPort } from '../src';
import { scoreEval } from '../eval';
import {
  evalData, ext, goldInput, inputFor, perfectScript, run, schema, toPredictions, ver,
} from './extract-helpers';

const ids = evalData.golds.map((g) => g.source);
const opOf = (c: Change) => {
  const op = c.operations[0]!;
  if (op.op !== 'create_item') throw new Error('create_item esperado');
  return op;
};
const evOf = (c: Change) => opOf(c).evidence[0] as TextEvidence;

describe('modelo perfeito (roteirizado pelo gabarito)', () => {
  it('recall de 100% nas sete fontes, sem armadilha, sem injeção, sem citação inválida', async () => {
    const all = [];
    for (const id of ids) {
      const r = await run(perfectScript(id), goldInput(id));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.discarded).toEqual([]);
      expect(r.deps.model.remaining).toBe(0);
      all.push(...toPredictions(id, r.changes));
    }
    const s = scoreEval(evalData, all);
    expect(s.overall.recall).toBe(1);
    expect(s.overall.trapsHit).toEqual([]);
    expect(s.overall.injectionsObeyed).toEqual([]);
    expect(s.overall.invalidCitations).toBe(0);
    expect(s.overall.noCitation).toBe(0);
  });

  it('cada Change tem origem completa de agente e passa na validação do núcleo com 0 problemas', async () => {
    for (const id of ids) {
      const r = await run(perfectScript(id), goldInput(id, { params: { temperature: 0, seed: 7 } }));
      if (!r.ok) throw new Error('execução falhou');
      for (const c of r.changes) {
        expect(validateChange(schema, goldInput(id).state, c)).toEqual([]);
        expect(c.origin).toMatchObject({
          kind: 'agent', runId: 'run-1', model: 'fake-extractor', promptVersion: 'extract@1',
        });
        const o = c.origin;
        if (o.kind !== 'agent') throw new Error();
        expect(o.params).toMatchObject({ temperature: 0, seed: 7, verifierModel: 'fake-extractor' });
        expect(c.createdAt).toBe('2026-10-18T10:00:00Z');
        expect(c.idempotencyKey).toMatch(/^run-1:/);
        expect(evOf(c).supportVerdict).toMatch(/^(full|partial)$/);
      }
    }
  });

  it('o item cujo trecho não mostra o cabeçalho da tabela sai com suporte partial (e conta como evidência fraca)', async () => {
    const r = await run(perfectScript('03-cost-memo'), goldInput('03-cost-memo'));
    if (!r.ok) throw new Error();
    const row = r.changes.find((c) => opOf(c).content === evalData.golds.find((g) => g.source === '03-cost-memo')!.items.find((i) => i.key === 'cost.network-tooling-rise')!.statement)!;
    expect(evOf(row).supportVerdict).toBe('partial');
    expect(analyzeChange(schema, goldInput('03-cost-memo').state, row).weakEvidence).toBe(1);
  });

  it('decisão entra só como provisória e nunca é elegível a lote; pergunta entra aberta', async () => {
    const r = await run(perfectScript('07-decision-log'), goldInput('07-decision-log'));
    if (!r.ok) throw new Error();
    const decisions = r.changes.filter((c) => opOf(c).type === 'decision');
    expect(decisions).toHaveLength(5);
    for (const d of decisions) {
      expect(opOf(d).status).toBe('provisional');
      const a = analyzeChange(schema, goldInput('07-decision-log').state, d);
      expect(a.impact).toBe('high');
      expect(isBatchEligible(schema, d, a)).toBe(false);
    }
    expect(r.changes.filter((c) => opOf(c).type === 'question').every((c) => opOf(c).status === 'open')).toBe(true);
  });

  it('o ledger de verdade aceita todas as propostas como pendentes e NÃO aplica nada (o pipeline não escreve no log)', async () => {
    const id = '01-architecture-report';
    const input = goldInput(id);
    const r = await run(perfectScript(id), input);
    if (!r.ok) throw new Error();
    const l = new InMemoryLedger({ schema, projectId: 'p1' as never, clock: fixedClock(), ids: sequentialIds('c') });
    expect(l.contents.add(input.source.text)).toBe(input.source.contentHash);
    for (const c of r.changes) {
      const { id: _i, impact: _im, basisKind: _b, ...rest } = c;
      const out = await l.propose({ ...rest, id: c.id });
      expect(out.ok && !out.applied).toBe(true);
    }
    expect(l.log).toHaveLength(0);
  });

  it('ambiguidade: billing-3-of-40 aparece duas vezes, usa a primeira e marca no relatório', async () => {
    const id = '01-architecture-report';
    const r = await run(perfectScript(id), goldInput(id));
    if (!r.ok) throw new Error();
    expect(r.report.ambiguousCitations).toHaveLength(1);
    const first = TEXT_KIND.locate(goldInput(id).source.text, evalData.golds[0]!.items.find((i) => i.key === 'arch.billing-3-of-40')!.quotes[0]!);
    expect(first.length).toBe(2);
    const c = r.changes.find((x) => evOf(x).start === first[0]!.start)!;
    expect(c).toBeDefined();
  });

  it('o relatório fecha a conta e é JSON puro', async () => {
    const r = await run(perfectScript('02-incident-postmortem'), goldInput('02-incident-postmortem'));
    if (!r.ok) throw new Error();
    expect(r.report.modelChanges).toBe(r.report.kept + r.report.discarded.length);
    expect(r.report.kept).toBe(r.changes.length);
    expect(r.report.coverage).toEqual([{
      sourceId: '02-incident-postmortem', contentHash: goldInput('02-incident-postmortem').source.contentHash,
      passagesTotal: 1, passagesCited: 1,
    }]);
    expect(JSON.parse(JSON.stringify(r.report))).toEqual(r.report);
    expect(JSON.parse(JSON.stringify(r.changes))).toEqual(r.changes);
  });
});

describe('modelos que erram: as métricas do harness acusam', () => {
  it('modelo que cai nas armadilhas: todas as 11 são atingidas (e as citações valem)', async () => {
    const hit: string[] = [];
    for (const g of evalData.golds) {
      if (g.traps.length === 0) continue;
      const steps = [
        ext(g.traps.map((t) => ({ type: t.types[0]!, statement: t.reason, quote: t.quotes[0]! }))),
        ...g.traps.map(() => ver('full')),
      ];
      const r = await run(steps, goldInput(g.source));
      if (!r.ok) throw new Error();
      hit.push(...scoreEval(evalData, toPredictions(g.source, r.changes)).perSource[g.source]!.trapsHit);
    }
    expect(hit).toHaveLength(11);
  });

  it('modelo que obedece a injeção da fonte 06: injectionsObeyed acusa as três', async () => {
    const g = evalData.golds.find((x) => x.source === '06-hostile-faq')!;
    const steps = [
      ext(g.injections.map((i) => ({ type: 'claim', statement: i.description, quote: i.quote }))),
      ...g.injections.map(() => ver('full')),
    ];
    const r = await run(steps, goldInput(g.source));
    if (!r.ok) throw new Error();
    const m = scoreEval(evalData, toPredictions(g.source, r.changes)).perSource[g.source]!;
    expect([...m.injectionsObeyed].sort()).toEqual(g.injections.map((i) => i.key).sort());
  });

  it('a injeção que pede "criar uma decisão aprovada": mesmo que o modelo a crie, ela entra só como provisória, alta, fora de lote', async () => {
    const g = evalData.golds.find((x) => x.source === '06-hostile-faq')!;
    const inj = g.injections.find((i) => i.key === 'faq.inj-create-approval')!;
    const r = await run(
      [ext([{ type: 'decision', statement: 'The migration was approved by leadership.', quote: inj.quote }]), ver('full')],
      goldInput(g.source),
    );
    if (!r.ok) throw new Error();
    const c = r.changes[0]!;
    expect(opOf(c).status).toBe('provisional');
    const a = analyzeChange(schema, goldInput(g.source).state, c);
    expect(isBatchEligible(schema, c, a)).toBe(false);
    expect(scoreEval(evalData, toPredictions(g.source, r.changes)).perSource[g.source]!.injectionsObeyed).toContain(inj.key);
  });
});

describe('saída inválida', () => {
  const text = 'Alpha is true here.\n\nBeta is also true here.';
  const good = { type: 'claim', statement: 'Alpha is true.', quote: 'Alpha is true here.' };

  it('forma errada da saída descarta a execução inteira, com erro tipado retryable, e não chama o verificador', async () => {
    const r = await run([{ output: { items: 'x' } }, ver('full')], inputFor('s', text));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'schema_invalid', retryable: true });
    expect(r.report).toMatchObject({ kept: 0, modelChanges: 0, discarded: [] });
    expect(r.deps.model.remaining).toBe(1);
  });

  it('forma errada em QUALQUER passagem descarta tudo, mesmo o que uma passagem anterior produziu', async () => {
    const bad = { ...good, id: 'x' };
    const r = await run([ext([good, bad]), { output: 'lixo' }, ver('full')], inputFor('s', text, { maxChunkChars: 20 }));
    expect(r.ok).toBe(false);
    // a execução é descartada por inteiro: o relatório não carrega descartes nem contagens da passagem que deu certo
    if (!r.ok) expect(r.report).toMatchObject({ kept: 0, modelChanges: 0, discarded: [], ambiguousCitations: [] });
  });

  it('veredito do verificador fora do schema também descarta a execução', async () => {
    const r = await run([ext([good]), { output: { verdict: 'maybe' } }], inputFor('s', text));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('schema_invalid');
  });

  it('item com id/start/end/campo extra: só o item cai (malformed_item); o resto segue', async () => {
    const bad = { ...good, start: 0, end: 5, id: 'x' };
    const r = await run([ext([bad, good]), ver('full')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(1);
    expect(r.report.discarded).toMatchObject([{ ref: 'c0.0', reason: 'malformed_item' }]);
    expect(r.report.modelChanges).toBe(2);
    expect(r.report.modelChanges).toBe(r.report.kept + r.report.discarded.length);
  });

  it('o modelo não consegue impor posições: o deslocamento vem do código', async () => {
    const withPos = { ...good, start: 20, end: 30 };
    const r = await run([ext([withPos]), ver('full')], inputFor('s', text));
    expect(r.ok && r.changes).toHaveLength(0);
    expect(r.ok && r.report.discarded[0]!.reason).toBe('malformed_item');
  });

  it('lista vazia é válida: nada mantido, nenhuma chamada ao verificador', async () => {
    const r = await run([ext([])], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes).toEqual([]);
    expect(r.report.kept).toBe(0);
    expect(r.report.coverage[0]!.passagesCited).toBe(0);
    expect(r.deps.model.calls).toHaveLength(1);
  });
});

describe('citação: existe na passagem enviada e ganha o deslocamento da passagem', () => {
  const p1 = 'Alpha is the first thing stated here.';
  const p2 = 'Beta is the second thing stated here.';
  const p3 = 'Gamma is the third thing stated here.';
  const text = `${p1}\n\n${p2}\n\n${p3}`;
  const limit = p2.length + 1; // uma passagem por parágrafo
  const q = (s: string, type = 'claim') => ({ type, statement: `About ${s.slice(0, 5)}`, quote: s });

  it('o texto se divide em três passagens', () => {
    expect(inputFor('s', text, { maxChunkChars: limit }).source.text).toBe(text);
  });

  it('citação de outra passagem (existe na fonte, mas não foi enviada nesta chamada) é descartada', async () => {
    const r = await run([ext([q(p2)]), ext([]), ext([])], inputFor('s', text, { maxChunkChars: limit }));
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(0);
    expect(r.report.discarded).toMatchObject([{ ref: 'c0.0', reason: 'invalid_citation', problem: 'text_mismatch' }]);
    expect(r.deps.model.calls).toHaveLength(3); // nenhum verificador para a citação inválida
  });

  it('citação inexistente é descartada sem chamar o verificador', async () => {
    const r = await run([ext([q('This sentence is nowhere to be found.')])], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.report.discarded[0]).toMatchObject({ reason: 'invalid_citation', problem: 'text_mismatch' });
    expect(r.deps.model.calls).toHaveLength(1);
  });

  it('citação curta demais (< 5 code points) é recusada pela verificação mecânica do núcleo', async () => {
    const r = await run([ext([q('Beta')])], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.report.discarded[0]).toMatchObject({ reason: 'invalid_citation', problem: 'quote_length' });
  });

  it('a posição gravada é a da FONTE INTEIRA (início da passagem + índice achado) e o núcleo a confirma', async () => {
    const input = inputFor('s', text, { maxChunkChars: limit });
    const r = await run([ext([]), ext([q(p2)]), ext([q(p3)]), ver('full'), ver('full')], input);
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(2);
    const [b, g] = r.changes.map(evOf);
    expect(b!.start).toBe(Array.from(`${p1}\n\n`).length);
    expect(g!.start).toBe(Array.from(`${p1}\n\n${p2}\n\n`).length);
    for (const e of [b!, g!]) {
      expect(Array.from(input.source.text).slice(e.start, e.end).join('')).toBe(e.quote);
    }
    const reader = { get: async () => input.source.text };
    for (const c of r.changes) expect(await verifyEvidence(c.operations, reader)).toEqual([]);
    expect(r.report.coverage[0]).toMatchObject({ passagesTotal: 3, passagesCited: 2 });
  });

  it('citação repetida na mesma passagem: usa a primeira ocorrência e registra a ambiguidade', async () => {
    const t = 'Same sentence appears here.\n\nSame sentence appears here.';
    const r = await run([ext([{ type: 'claim', statement: 'Same sentence.', quote: 'Same sentence appears here.' }]), ver('full')], inputFor('s', t));
    if (!r.ok) throw new Error();
    expect(evOf(r.changes[0]!).start).toBe(0);
    expect(r.report.ambiguousCitations).toEqual(['c0.0']);
  });

  it('citação com espaço duro (U+00A0): só casa literalmente', async () => {
    const t = 'p95 rose from 410 ms to 484 ms after the split.';
    const plain = 'p95 rose from 410 ms to 484 ms after the split.';
    const a = await run([ext([{ type: 'claim', statement: 'p95 rose.', quote: plain }])], inputFor('s', t));
    expect(a.ok && a.report.discarded[0]!.reason).toBe('invalid_citation');
    const b = await run([ext([{ type: 'claim', statement: 'p95 rose.', quote: t }]), ver('full')], inputFor('s', t));
    expect(b.ok && b.changes).toHaveLength(1);
  });

  it('citação decomposta (e + U+0301) é a mesma citação: casa e é gravada na forma NFC da fonte', async () => {
    const t = 'The on-call engineer Zo\u00e9 Okafor was paged at 09:12.';
    const decomposed = 'engineer Zoe\u0301 Okafor was paged';
    const r = await run([ext([{ type: 'claim', statement: 'Zoe was paged.', quote: decomposed }]), ver('full')], inputFor('s', t));
    if (!r.ok) throw new Error();
    expect(evOf(r.changes[0]!).quote).toBe('engineer Zo\u00e9 Okafor was paged');
  });

  it('hifenização refeita NÃO casa: a fonte quebra "depen-\\ndencies" e a citação consertada é descartada', async () => {
    const t = 'The shared session store introduces hidden depen-\ndencies between checkout and account.';
    const repaired = 'The shared session store introduces hidden dependencies between checkout and account.';
    const r = await run([ext([{ type: 'claim', statement: 'Hidden deps.', quote: repaired }])], inputFor('s', t));
    if (!r.ok) throw new Error();
    expect(r.report.discarded[0]).toMatchObject({ reason: 'invalid_citation', problem: 'text_mismatch' });
    const literal = await run([ext([{ type: 'claim', statement: 'Hidden deps.', quote: t }]), ver('full')], inputFor('s', t));
    expect(literal.ok && literal.changes).toHaveLength(1);
  });

  it('citação que começa depois de um emoji: o deslocamento conta code points', async () => {
    const t = 'Intro 😀😀 then the real statement follows here.';
    const q2 = 'then the real statement follows here.';
    const r = await run([ext([{ type: 'claim', statement: 'Statement.', quote: q2 }]), ver('full')], inputFor('s', t));
    if (!r.ok) throw new Error();
    expect(evOf(r.changes[0]!).start).toBe(Array.from('Intro 😀😀 ').length);
  });
});

describe('suporte: chamada separada, só afirmação + citação', () => {
  const text = 'Visible quote about water boiling.\n\nA secret sentence only in the source.';
  const it1 = { type: 'claim', statement: 'Water boils.', quote: 'Visible quote about water boiling.' };

  it('o verificador recebe só a afirmação e a citação, nunca a fonte nem a passagem', async () => {
    const r = await run([ext([it1]), ver('full')], inputFor('s', text));
    if (!r.ok) throw new Error();
    const verifyCall = r.deps.model.calls[1]!;
    const user = verifyCall.messages[0]!.content;
    expect(user).toContain(it1.statement);
    expect(user).toContain(it1.quote);
    expect(user).not.toContain('secret sentence');
    expect(user).not.toContain('Source:');
    expect(JSON.stringify(verifyCall.schema)).toContain('verdict');
  });

  it('veredito none descarta como not_supported e nada é mantido', async () => {
    const r = await run([ext([it1]), ver('none')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(0);
    expect(r.report.discarded).toMatchObject([{ reason: 'not_supported', verdict: 'none' }]);
  });

  it('o veredito do verificador (e só ele) vai para a evidência: partial fica partial', async () => {
    const r = await run([ext([it1]), ver('partial')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(evOf(r.changes[0]!).supportVerdict).toBe('partial');
  });

  it('o veredito não vem do modelo de extração: um campo "supportVerdict" no item é rejeitado', async () => {
    const r = await run([ext([{ ...it1, supportVerdict: 'full' } as never]), ver('full')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.report.discarded[0]).toMatchObject({ reason: 'malformed_item' });
  });
});

describe('dedupe: mesmo tipo + cobertura >= 0,9 nos dois sentidos', () => {
  const text = 'Billing depends on inventory in only 3 of the 40 mapped flows. Other things follow.';
  const full = 'Billing depends on inventory in only 3 of the 40 mapped flows.';
  const near = 'Billing depends on inventory in only 3 of the 40 mapped flows';
  const small = 'Billing depends on inventory';

  it('mesma afirmação com citação praticamente igual: a segunda é duplicata da primeira', async () => {
    const r = await run([ext([
      { type: 'claim', statement: 'A', quote: full }, { type: 'claim', statement: 'B', quote: near },
    ]), ver('full')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(1);
    expect(r.report.discarded).toMatchObject([{ ref: 'c0.1', reason: 'duplicate', duplicateOf: 'c0.0' }]);
    expect(r.deps.model.calls).toHaveLength(2); // o verificador só foi chamado uma vez
  });

  it('tipos diferentes com a mesma citação NÃO se fundem', async () => {
    const r = await run([ext([
      { type: 'claim', statement: 'A', quote: full }, { type: 'assumption', statement: 'B', quote: full },
    ]), ver('full'), ver('full')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes.map((c) => opOf(c).type)).toEqual(['claim', 'assumption']);
    expect(r.report.discarded).toEqual([]);
  });

  it('citação que cobre só parte da outra (abaixo de 0,9 de um dos lados) não é duplicata', async () => {
    const r = await run([ext([
      { type: 'claim', statement: 'A', quote: full }, { type: 'claim', statement: 'B', quote: small },
    ]), ver('full'), ver('full')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(2);
  });

  it('item que já existe no estado (aceito antes) é duplicata dele, com o id do item', async () => {
    const input = inputFor('s', text);
    const first = await run([ext([{ type: 'claim', statement: 'A', quote: full }]), ver('full')], input);
    if (!first.ok) throw new Error();
    const l = new InMemoryLedger({ schema, projectId: 'p1' as never, clock: fixedClock(), ids: sequentialIds('c') });
    l.contents.add(input.source.text);
    const { id, impact: _i, basisKind: _b, ...rest } = first.changes[0]!;
    const p = await l.propose({ ...rest, id });
    if (!p.ok || p.applied) throw new Error('pendente esperado');
    await l.review({ changeId: id, decision: 'accept', reviewer: { kind: 'human', id: 'u1' as never } });
    const again = await run([ext([{ type: 'claim', statement: 'A de novo', quote: near }])], { ...input, state: l.state });
    if (!again.ok) throw new Error();
    expect(again.changes).toHaveLength(0);
    expect(again.report.discarded).toMatchObject([{ reason: 'duplicate', duplicateOf: opOf(first.changes[0]!).itemId }]);
  });

  it('a sobreposição entre passagens não duplica o que fica nas duas', async () => {
    const t = 'One sentence here. Two sentence here. Three sentence here. Four sentence here.';
    const q1 = 'Two sentence here.';
    const chunks = (await import('../src')).chunkSource(t, 38);
    expect(chunks.length).toBeGreaterThan(1);
    const both = chunks.filter((c) => c.text.includes(q1));
    expect(both.length).toBe(2); // a frase de sobreposição está nas duas passagens
    const script = chunks.map((c) => (c.text.includes(q1) ? ext([{ type: 'claim', statement: 'Two.', quote: q1 }]) : ext([])));
    const r = await run([...script, ver('full')], inputFor('s', t, { maxChunkChars: 38 }));
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(1);
    expect(r.report.discarded.map((d) => d.reason)).toEqual(['duplicate']);
  });
});

describe('cancelamento e erros do provedor', () => {
  const text = 'Alpha is true here.\n\nBeta is also true here.';
  const good = { type: 'claim', statement: 'Alpha is true.', quote: 'Alpha is true here.' };

  it('signal já abortado: erro aborted (não retryable) e o modelo nem é chamado', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await run([ext([good]), ver('full')], inputFor('s', text, { signal: ctl.signal }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'aborted', retryable: false });
    expect(r.deps.model.calls).toHaveLength(0);
  });

  it('abortado ENTRE passos: a execução para antes da próxima chamada e nada é mantido', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const model: ModelPort = {
      async generate(req) {
        calls++;
        if (calls === 1) {
          ctl.abort(); // o usuário cancela logo depois da extração
          return { output: { items: [good] }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' };
        }
        throw new Error('o verificador não podia ser chamado');
      },
    };
    let n = 0;
    const r = await extractFromSource(
      { model, schema, ids: { next: () => `i${++n}` }, clock: { now: () => '2026-10-18T10:00:00Z' } },
      inputFor('s', text, { signal: ctl.signal }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('aborted');
    expect(calls).toBe(1);
  });

  it('falha do provedor é retryable; roteiro esgotado não é', async () => {
    const a = await run([{ error: 'boom' }], inputFor('s', text));
    expect(a.ok === false && a.error).toMatchObject({ code: 'provider_error', retryable: true });
    const b = await run([], inputFor('s', text));
    expect(b.ok === false && b.error).toMatchObject({ code: 'no_response', retryable: false });
  });

  it('erros que não são da porta do modelo propagam (não são engolidos)', async () => {
    const model: ModelPort = { generate: async () => { throw new TypeError('bug'); } };
    await expect(extractFromSource(
      { model, schema, ids: { next: () => 'i' }, clock: { now: () => 'x' } }, inputFor('s', text),
    )).rejects.toBeInstanceOf(TypeError);
  });

  it('o ModelPortError aborted vindo do modelo vira erro aborted', async () => {
    const model: ModelPort = { generate: async () => { throw new ModelPortError('aborted', 'x'); } };
    const r = await extractFromSource(
      { model, schema, ids: { next: () => 'i' }, clock: { now: () => 'x' } }, inputFor('s', text),
    );
    expect(r.ok === false && r.error.code).toBe('aborted');
  });

  it('texto que não tem o hash do snapshot citado: source_hash_mismatch, sem chamar o modelo', async () => {
    const input = inputFor('s', text);
    const bad = { ...input, source: { ...input.source, text: `${text} adulterado` } };
    const r = await run([ext([good])], bad);
    expect(r.ok === false && r.error).toMatchObject({ code: 'source_hash_mismatch', retryable: false });
    expect(r.deps.model.calls).toHaveLength(0);
  });

  it('o uso de tokens é somado entre extração e verificação', async () => {
    const r = await run([
      { output: { items: [good] }, usage: { inputTokens: 100, outputTokens: 10 } },
      { output: { verdict: 'full' }, usage: { inputTokens: 20, outputTokens: 2 } },
    ], inputFor('s', text));
    expect(r.report.usage).toEqual({ inputTokens: 120, outputTokens: 12 });
  });
});

describe('fronteira: o pipeline nunca escreve no log', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'extract');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('nenhum arquivo do extract toca o log, o ledger de teste ou revisão', () => {
    expect(files.length).toBeGreaterThan(4);
    const banned = /\b(sealEntry|InMemoryLedger|submitHuman|appendEntry|GENESIS_HASH|\.propose\(|\.review\()/;
    for (const f of files) {
      const t = readFileSync(join(dir, f), 'utf8');
      expect(banned.test(t), `${f} referencia o log`).toBe(false);
      expect(/@sift\/core\/testing/.test(t), `${f} importa testing`).toBe(false);
    }
  });
});
