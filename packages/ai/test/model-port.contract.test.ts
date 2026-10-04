import { describe, expect, it } from 'vitest';
import { ModelPortError } from '../src';
import {
  FakeModel, RecordedModel, requestHash, type Recording,
} from '../src/testing';
import { req, res, runModelPortContract, type ContractStep } from './contract';

runModelPortContract('FakeModel', (steps: ContractStep[]) =>
  new FakeModel(steps.map((s) => ({ output: s.response.output, usage: s.response.usage, model: s.response.model }))),
);

const recordingOf = (steps: ContractStep[]): Recording => ({
  version: 1,
  entries: steps.map((s) => ({ requestHash: requestHash(s.request), response: s.response })),
});
runModelPortContract('RecordedModel', (steps: ContractStep[]) => new RecordedModel(recordingOf(steps)));

describe('FakeModel (comportamento próprio)', () => {
  it('ignora o conteúdo do pedido, devolve o roteiro em ordem e registra as chamadas', async () => {
    const m = new FakeModel([{ output: { n: 1 } }, { output: { n: 2 } }]);
    expect((await m.generate(req('first'))).output).toEqual({ n: 1 });
    expect((await m.generate(req('something else entirely'))).output).toEqual({ n: 2 });
    expect(m.calls.map((c) => c.messages[0]!.content)).toEqual(['first', 'something else entirely']);
    expect(m.remaining).toBe(0);
  });
  it('usa usage zerado e o modelo padrão quando o passo não os define', async () => {
    const m = new FakeModel([{ output: null }], { model: 'fake-x' });
    const r = await m.generate(req('x'));
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(r.model).toBe('fake-x');
  });
  it('passo de erro vira ModelPortError provider_error e consome o passo', async () => {
    const m = new FakeModel([{ error: 'rate limited' }, { output: 'ok' }]);
    const err = (await m.generate(req('x')).catch((e: unknown) => e)) as ModelPortError;
    expect(err).toBeInstanceOf(ModelPortError);
    expect(err.code).toBe('provider_error');
    expect((await m.generate(req('x'))).output).toBe('ok');
  });
  it('o roteiro é copiado: mutar o original depois não muda as respostas', async () => {
    const out = { v: 1 };
    const m = new FakeModel([{ output: out }]);
    out.v = 99;
    expect((await m.generate(req('x'))).output).toEqual({ v: 1 });
  });
});

describe('RecordedModel (comportamento próprio)', () => {
  const r1 = { request: req('alpha'), response: res({ a: 1 }) };
  const r2 = { request: req('beta'), response: res({ b: 2 }) };

  it('repete a mesma resposta para o mesmo pedido, quantas vezes e em qualquer ordem', async () => {
    const m = new RecordedModel(recordingOf([r1, r2]));
    expect((await m.generate(r2.request)).output).toEqual({ b: 2 });
    expect((await m.generate(r1.request)).output).toEqual({ a: 1 });
    expect((await m.generate(r1.request)).output).toEqual({ a: 1 });
  });
  it('mutar uma resposta devolvida não afeta o replay seguinte', async () => {
    const m = new RecordedModel(recordingOf([r1]));
    const first = await m.generate(r1.request);
    (first.output as { a: number }).a = 42;
    expect((await m.generate(r1.request)).output).toEqual({ a: 1 });
  });
  it('qualquer diferença no pedido (system, mensagens, schema, params) muda o hash', () => {
    const base = req('alpha');
    const hashes = new Set([
      requestHash(base),
      requestHash({ ...base, system: base.system + '!' }),
      requestHash({ ...base, messages: [{ role: 'user', content: 'alpha!' }] }),
      requestHash({ ...base, schema: { type: 'array' } }),
      requestHash({ ...base, params: { temperature: 1 } }),
    ]);
    expect(hashes.size).toBe(5);
  });
  it('o hash não depende da ordem das chaves', () => {
    const a = req('alpha', { params: { temperature: 0, maxOutputTokens: 5 } });
    const b = req('alpha', { params: { maxOutputTokens: 5, temperature: 0 } });
    expect(requestHash(a)).toBe(requestHash(b));
  });
  it('pedido fora da gravação não é adivinhado', async () => {
    const m = new RecordedModel(recordingOf([r1]));
    const err = (await m.generate(req('gamma')).catch((e: unknown) => e)) as ModelPortError;
    expect(err.code).toBe('no_response');
  });
  it('gravação ambígua (mesmo pedido, respostas diferentes) e versão desconhecida são recusadas', () => {
    const h = requestHash(r1.request);
    const ambiguous: Recording = {
      version: 1,
      entries: [{ requestHash: h, response: res({ a: 1 }) }, { requestHash: h, response: res({ a: 2 }) }],
    };
    expect(() => new RecordedModel(ambiguous)).toThrow();
    expect(() => new RecordedModel({ version: 2, entries: [] } as unknown as Recording)).toThrow();
  });
  it('entradas repetidas com a MESMA resposta são aceitas', () => {
    const h = requestHash(r1.request);
    const dup: Recording = { version: 1, entries: [{ requestHash: h, response: r1.response }, { requestHash: h, response: r1.response }] };
    expect(() => new RecordedModel(dup)).not.toThrow();
  });
});
