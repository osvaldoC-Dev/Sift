import { assertProjectSchema, contentHash, normalizeText, type Change, type ProjectSchema, type TextEvidence } from '@sift/core';
import { decisionsV1, researchV1 } from '@sift/schemas';
import { describe, expect, it } from 'vitest';
import { extractFromSource, ModelPortError, resolveCreationStatuses, type ExtractDeps, type ModelResponse } from '../src';
import { FakeModel } from '../src/testing';
import { ext, inputFor, makeDeps, run, schema, ver } from './extract-helpers';

/** Endurecimento do 3.2b (rodada 3, bloco B): cada ponto com testes INDEPENDENTES entre si. */

const text = 'Alpha is true here.\n\nBeta is also true here.\n\nIs Gamma ready?';
const claim = (statement: string, quote: string) => ({ type: 'claim', statement, quote });
const a = claim('Alpha is true.', 'Alpha is true here.');
const b = claim('Beta is also true.', 'Beta is also true here.');
const evOf = (c: Change) => {
  const op = c.operations[0]!;
  if (op.op !== 'create_item') throw new Error('create_item esperado');
  return op.evidence[0] as TextEvidence;
};
const statusOf = (c: Change) => {
  const op = c.operations[0]!;
  if (op.op !== 'create_item') throw new Error('create_item esperado');
  return op.status;
};

describe('B1a. hash do snapshot (cada teste, sozinho, pega a remoção da checagem)', () => {
  it('um caractere trocado, mesmo tamanho: recusa e o modelo nem é chamado', async () => {
    const input = inputFor('s', text);
    const tampered = { ...input, source: { ...input.source, text: text.replace('Alpha', 'Alpho') } };
    const r = await run([ext([a])], tampered);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('source_hash_mismatch');
    expect(r.deps.model.calls).toHaveLength(0);
    expect(r.report).toMatchObject({ kept: 0, modelChanges: 0 });
  });

  it('texto NÃO normalizado (NFD) com o hash do NFC: recusa, porque o snapshot é o texto normalizado', async () => {
    const nfc = normalizeText('Café is true here.');
    const nfd = 'Café is true here.';
    expect(nfd).not.toBe(nfc);
    const base = inputFor('s', nfc);
    const r = await run([ext([])], { ...base, source: { ...base.source, text: nfd } });
    expect(r.ok === false && r.error.code).toBe('source_hash_mismatch');
    expect(r.deps.model.calls).toHaveLength(0);
  });

  it('hash de OUTRA fonte com o texto certo: recusa; o hash certo é aceito e chama o modelo', async () => {
    const base = inputFor('s', text);
    const wrong = { ...base, source: { ...base.source, contentHash: contentHash('outro texto qualquer') } };
    const bad = await run([ext([a])], wrong);
    expect(bad.ok === false && bad.error).toMatchObject({ code: 'source_hash_mismatch', retryable: false });
    expect(bad.deps.model.calls).toHaveLength(0);
    const good = await run([ext([])], base);
    expect(good.ok).toBe(true);
    expect(good.deps.model.calls).toHaveLength(1);
  });
});

describe('B1b. veredicto none (cada teste, sozinho, pega a mutação)', () => {
  it('um none e um full: só o none sai, com o motivo not_supported e a citação', async () => {
    const r = await run([ext([a, b]), ver('none'), ver('full')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(1);
    expect(evOf(r.changes[0]!).quote).toBe('Beta is also true here.');
    expect(r.report.discarded).toEqual([
      expect.objectContaining({ ref: 'c0.0', reason: 'not_supported', verdict: 'none', quote: 'Alpha is true here.' }),
    ]);
    expect(r.report.modelChanges).toBe(r.report.kept + r.report.discarded.length);
  });

  it('none não é falha do verificador: não entra em uncheckedByVerifier e não gera aviso', async () => {
    const r = await run([ext([a, b]), ver('none'), ver('none')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(0);
    expect(r.report.uncheckedByVerifier).toEqual([]);
    expect(r.report.verifierDegraded).toBeNull();
    expect(r.report.kept).toBe(0);
    expect(r.report.discarded.map((d) => d.reason)).toEqual(['not_supported', 'not_supported']);
  });

  it('nenhuma evidência mantida carrega none: o que fica é só full/partial', async () => {
    const r = await run([ext([a, b]), ver('partial'), ver('none')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes.map((c) => evOf(c).supportVerdict)).toEqual(['partial']);
  });
});

describe('B1c. verificação mecânica do núcleo (cada teste, sozinho, pega a mutação)', () => {
  const long = `${'palavra '.repeat(300)}fim.`; // > 2000 code points
  const big = `${long}\n\nCurta o bastante aqui.`;

  it('citação longa demais (> 2000 code points) é recusada e o verificador nem é chamado para ela', async () => {
    const r = await run([ext([claim('Texto enorme.', long)])], inputFor('s', big));
    if (!r.ok) throw new Error();
    expect(Array.from(long).length).toBeGreaterThan(2000);
    expect(r.report.discarded).toEqual([expect.objectContaining({ reason: 'invalid_citation', problem: 'quote_length' })]);
    expect(r.deps.model.calls).toHaveLength(1); // só a extração
    expect(r.changes).toHaveLength(0);
  });

  it('curta demais + válida na mesma passagem: a curta sai, a válida segue e só ela chega ao verificador', async () => {
    const r = await run([ext([claim('Beta.', 'Beta'), a]), ver('full')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(1);
    expect(r.report.discarded).toEqual([expect.objectContaining({ ref: 'c0.0', problem: 'quote_length' })]);
    expect(r.deps.model.calls).toHaveLength(2); // extração + UM verificador
  });

  it('o item recusado pela mecânica não aparece como mantido nem como unchecked', async () => {
    const r = await run([ext([claim('Beta.', 'Beta')])], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.report.kept).toBe(0);
    expect(r.report.uncheckedByVerifier).toEqual([]);
    expect(r.report.modelChanges).toBe(1);
  });
});

describe('B2. verificador a falhar em tudo -> verifierDegraded (nunca em silêncio)', () => {
  const garbage = { output: { lixo: true } };
  const three = [a, b, { type: 'question', statement: 'Gamma is ready?', quote: 'Is Gamma ready?' }];

  it('lixo em todos os itens: ok:true, nada descartado, todos unchecked, e o relatório leva o aviso', async () => {
    const r = await run([ext(three), garbage, garbage, garbage], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.changes).toHaveLength(3);
    expect(r.changes.map((c) => evOf(c).supportVerdict)).toEqual(['unchecked', 'unchecked', 'unchecked']);
    expect(r.report.discarded).toEqual([]);
    expect(r.report.uncheckedByVerifier).toHaveLength(3);
    expect(r.report.verifierDegraded).toEqual({ unchecked: 3, verified: 3, fraction: 1, threshold: 0.5 });
  });

  it('o limite é "passar de": exatamente 50% não avisa; 2 de 3 avisa', async () => {
    const half = await run([ext([a, b]), garbage, ver('full')], inputFor('s', text));
    if (!half.ok) throw new Error();
    expect(half.report.verifierDegraded).toBeNull();
    const two = await run([ext(three), garbage, garbage, ver('full')], inputFor('s', text));
    if (!two.ok) throw new Error();
    expect(two.report.verifierDegraded).toMatchObject({ unchecked: 2, verified: 3, threshold: 0.5 });
    expect(two.report.verifierDegraded!.fraction).toBeCloseTo(2 / 3);
  });

  it('o limite é parâmetro: 0,9 cala 2 de 3; 0 avisa com 1 de 3', async () => {
    const lenient = await run([ext(three), garbage, garbage, ver('full')], inputFor('s', text, { verifierDegradedThreshold: 0.9 }));
    if (!lenient.ok) throw new Error();
    expect(lenient.report.verifierDegraded).toBeNull();
    const strict = await run([ext(three), garbage, ver('full'), ver('full')], inputFor('s', text, { verifierDegradedThreshold: 0 }));
    if (!strict.ok) throw new Error();
    expect(strict.report.verifierDegraded).toMatchObject({ unchecked: 1, verified: 3, threshold: 0 });
  });

  it('a fração conta os itens que CHEGARAM ao verificador, inclusive os que ele descartou com none', async () => {
    const four = [a, b, claim('Gamma.', 'Is Gamma ready?'), claim('Alpha again.', 'Alpha is true')];
    // 4 itens: lixo, lixo, none, full => 2 de 4 = 50% => sem aviso (denominador 4, não 3)
    const r = await run([ext(four), garbage, garbage, ver('none'), ver('full')], inputFor('s', text));
    if (!r.ok) throw new Error();
    expect(r.report.verifierDegraded).toBeNull();
    const r2 = await run([ext(four), garbage, garbage, garbage, ver('none')], inputFor('s', text));
    if (!r2.ok) throw new Error();
    expect(r2.report.verifierDegraded).toMatchObject({ unchecked: 3, verified: 4 });
  });

  it('cancelar depois da verificação descarta a execução e o relatório não carrega o aviso', async () => {
    const ctl = new AbortController();
    const deps = makeDeps([]);
    let n = 0;
    const model = {
      async generate(): Promise<ModelResponse> {
        n++;
        if (n === 1) return { output: { items: [a, b] }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' };
        if (n === 3) queueMicrotask(() => ctl.abort());
        return { output: { lixo: n }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' };
      },
    };
    const r = await extractFromSource({ ...deps, model }, inputFor('s', text, { signal: ctl.signal }));
    expect(r.ok === false && r.error.code).toBe('aborted');
    expect(r.report.verifierDegraded).toBeNull();
    expect(r.report.uncheckedByVerifier).toEqual([]);
  });

  it('limite fora de 0..1 é erro de programação (RangeError), antes de gastar uma chamada', async () => {
    const deps = makeDeps([ext([])]);
    for (const bad of [-0.1, 1.5, Number.NaN]) {
      await expect(extractFromSource(deps, inputFor('s', text, { verifierDegradedThreshold: bad }))).rejects.toThrow(RangeError);
    }
    expect(deps.model.calls).toHaveLength(0);
  });

  it('sem itens, ou verificador sempre bom: sem aviso; execução descartada: sem aviso', async () => {
    const none = await run([ext([])], inputFor('s', text));
    expect(none.ok && none.report.verifierDegraded).toBeNull();
    const fine = await run([ext([a]), ver('full')], inputFor('s', text));
    expect(fine.ok && fine.report.verifierDegraded).toBeNull();
    const dead = await run([ext(three), garbage, { error: 'boom' }], inputFor('s', text));
    expect(dead.ok).toBe(false);
    expect(dead.report.verifierDegraded).toBeNull();
    expect(dead.report.uncheckedByVerifier).toEqual([]);
  });
});

describe('B3. status de criação lido do schema do projeto', () => {
  const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(researchV1)) as Record<string, unknown>;
  const withDeps = (s: ProjectSchema, steps: Parameters<typeof makeDeps>[0]): ExtractDeps & { model: FakeModel } => ({ ...makeDeps(steps), schema: s });

  it('research@1: claim/assumption/decision provisional, question open (comportamento anterior preservado)', () => {
    const r = resolveCreationStatuses(schema);
    expect(r).toEqual({ ok: true, byType: { claim: 'provisional', assumption: 'provisional', decision: 'provisional', question: 'open' } });
  });

  it('schema alternativo: o status provisório do tipo vem do schema ("draft"), não do código', async () => {
    const alt = assertProjectSchema(JSON.parse(JSON.stringify(researchV1).replaceAll('"provisional"', '"draft"')));
    const deps = withDeps(alt, [ext([a]), ver('full')]);
    const r = await extractFromSource(deps, inputFor('s', text));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(statusOf(r.changes[0]!)).toBe('draft');
    expect(r.report.discarded).toEqual([]);
  });

  it('pergunta sem provisionalStatus e sem "open": usa o único status de criação da IA', () => {
    const o = clone() as { itemTypes: Record<string, { statuses: string[]; creation: { agent: string[]; human: string[] } }> };
    o.itemTypes.question = { ...o.itemTypes.question!, statuses: ['todo', 'done'], creation: { agent: ['todo'], human: ['todo'] } };
    const alt = assertProjectSchema(o);
    expect(resolveCreationStatuses(alt)).toMatchObject({ ok: true, byType: { question: 'todo' } });
  });

  it('schema sem um dos tipos extraídos: erro TIPADO schema_unsupported, não retentável, sem gastar chamada', async () => {
    const deps = withDeps(assertProjectSchema(decisionsV1), [ext([a])]);
    const r = await extractFromSource(deps, inputFor('s', text));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'schema_unsupported', retryable: false });
    expect(r.error.detail).toContain('claim');
    expect(deps.model.calls).toHaveLength(0);
    expect(r.report).toMatchObject({ kept: 0, modelChanges: 0 });
  });

  it('status de criação ambíguo (vários, nenhum provisório nem "open"): schema_unsupported, não validation_refused mudo', async () => {
    const o = clone() as { itemTypes: Record<string, { statuses: string[]; creation: { agent: string[]; human: string[] } }> };
    o.itemTypes.question = { ...o.itemTypes.question!, statuses: ['todo', 'doing', 'done'], creation: { agent: ['todo', 'doing'], human: ['todo'] } };
    const alt = assertProjectSchema(o);
    const deps = withDeps(alt, [ext([a])]);
    const r = await extractFromSource(deps, inputFor('s', text));
    expect(r.ok === false && r.error).toMatchObject({ code: 'schema_unsupported', retryable: false });
    expect(deps.model.calls).toHaveLength(0);
  });
});

describe('B4. ambiguidade ENTRE passagens (contra a fonte inteira)', () => {
  const p = 'Same sentence appears here.';
  const filler = 'Other words in between.';
  const src = `${p}\n\n${filler}\n\n${p}`;
  const limit = Array.from(p).length; // uma passagem por parágrafo

  it('a citação aparece só uma vez por passagem, mas duas na fonte: fica registrada como ambígua', async () => {
    const input = inputFor('s', src, { maxChunkChars: limit });
    const r = await run([ext([claim('Same sentence.', p)]), ext([]), ext([]), ver('full')], input);
    if (!r.ok) throw new Error();
    expect(r.report.coverage[0]!.passagesTotal).toBe(3);
    expect(r.report.ambiguousCitations).toEqual(['c0.0']);
    expect(evOf(r.changes[0]!).start).toBe(0); // continua usando a ocorrência da passagem; só marca
    expect(r.changes).toHaveLength(1);
  });

  it('o mesmo texto com a citação ÚNICA na fonte inteira não é ambíguo', async () => {
    const input = inputFor('s', src, { maxChunkChars: limit });
    const r = await run([ext([]), ext([claim('Other.', filler)]), ext([]), ver('full')], input);
    if (!r.ok) throw new Error();
    expect(r.report.ambiguousCitations).toEqual([]);
  });

  it('ambiguidade na mesma passagem continua registrada (uma vez), sem duplicar o ref', async () => {
    const r = await run([ext([claim('Same.', p)]), ver('full')], inputFor('s', `${p}\n\n${p}`));
    if (!r.ok) throw new Error();
    expect(r.report.ambiguousCitations).toEqual(['c0.0']);
  });
});

describe('teto de custo no erro do modelo', () => {
  it('cost_cap_exceeded: a execução PARA, nada é mantido, o gasto da chamada que estourou entra no relatório', async () => {
    const deps = makeDeps([]);
    const model = {
      calls: 0,
      async generate(): Promise<ModelResponse> {
        this.calls++;
        if (this.calls === 1) return { output: { items: [a] }, usage: { inputTokens: 10, outputTokens: 5 }, model: 'm' };
        throw new ModelPortError('cost_cap_exceeded', 'teto', { usage: { inputTokens: 1000, outputTokens: 9000 } });
      },
    };
    const r = await extractFromSource({ ...deps, model }, inputFor('s', text));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'cost_cap_exceeded', retryable: false });
    expect(r.report.usage).toEqual({ inputTokens: 1010, outputTokens: 9005 });
    expect(r.report).toMatchObject({ kept: 0, modelChanges: 0, discarded: [] });
  });
});
