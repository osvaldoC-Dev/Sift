import { describe, expect, it } from 'vitest';
import {
  KimiModel, kimiConfigFromEnv, extractJson, KIMI_DEFAULT_BASE_URL,
  type HttpRequest, type HttpResponse, type HttpTransport, type KimiConfig, type RawRecord,
} from '../src/adapters/kimi';
import { ModelPortError, type ModelRequest } from '../src';

const KEY = 'sk-FAKE-do-not-leak-1234567890';
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: 'sistema', messages: [{ role: 'user', content: 'olá' }],
  schema: { type: 'object', required: ['items'] }, params: {}, ...over,
});
const ok = (content: string, extra: Record<string, unknown> = {}): HttpResponse => ({
  status: 200,
  text: JSON.stringify({
    model: 'kimi-k3-20260722', choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 }, ...extra,
  }),
});

/** Servidor falso: responde na ordem do roteiro e guarda o que recebeu. */
function fake(script: (HttpResponse | Error)[]): { transport: HttpTransport; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  let i = 0;
  return {
    seen,
    transport: async (r) => {
      seen.push(r);
      const step = script[Math.min(i++, script.length - 1)]!;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}
const model = (script: (HttpResponse | Error)[], over: Partial<KimiConfig> = {}) => {
  const f = fake(script);
  const sleeps: number[] = [];
  const m = new KimiModel({
    apiKey: KEY, transport: f.transport, reasoningEffort: 'low', maxOutputTokens: 4000,
    sleep: async (ms) => { sleeps.push(ms); }, backoffMs: 10, ...over,
  });
  return { m, ...f, sleeps };
};
const catchErr = async (p: Promise<unknown>): Promise<ModelPortError> => {
  try { await p; } catch (e) { return e as ModelPortError; }
  throw new Error('devia ter falhado');
};

describe('K7. servidor falso: respostas', () => {
  it('resposta válida: saída JSON, uso real, modelo devolvido pelo fornecedor', async () => {
    const { m } = model([ok('{"items":[]}')]);
    expect(await m.generate(req())).toEqual({ output: { items: [] }, usage: { inputTokens: 100, outputTokens: 50 }, model: 'kimi-k3-20260722' });
  });

  it('JSON em cerca de código (com e sem "json") é aceito', async () => {
    expect((await model([ok('```json\n{"verdict":"full"}\n```')]).m.generate(req())).output).toEqual({ verdict: 'full' });
    expect((await model([ok('```\n{"verdict":"none"}\n```')]).m.generate(req())).output).toEqual({ verdict: 'none' });
  });

  it('texto sem JSON NÃO é consertado: vai como string para o pipeline recusar', async () => {
    const r = await model([ok('Claro! Aqui estão os itens: ...')]).m.generate(req());
    expect(typeof r.output).toBe('string');
  });

  it('extractJson: só JSON puro ou cerca; texto em volta é inválido', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('antes {"a":1} depois')).toEqual({ ok: false });
    expect(extractJson('```json\n{"a":1}\n``` e mais texto')).toEqual({ ok: false });
  });

  it('uso com entrada em cache (dois formatos possíveis) é lido', async () => {
    const a = await model([ok('{}', { usage: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 60 } })]).m.generate(req());
    expect(a.usage).toEqual({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 60 });
    const b = await model([ok('{}', { usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } } })]).m.generate(req());
    expect(b.usage.cachedInputTokens).toBe(30);
  });

  it('usage em falta: o custo NUNCA vira zero (estimado por cima e marcado)', async () => {
    const r = await model([{ status: 200, text: JSON.stringify({ choices: [{ message: { content: '{}' } }] }) }]).m.generate(req());
    expect(r.usage.estimated).toBe(true);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBe(4000);
    const half = await model([{ status: 200, text: JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 5 } }) }]).m.generate(req());
    expect(half.usage.estimated).toBe(true);
  });

  it('o modelo pedido é o devolvido quando o fornecedor não diz', async () => {
    const r = await model([{ status: 200, text: JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }]).m.generate(req());
    expect(r.model).toBe('kimi-k3');
  });
});

describe('K3. o que vai no pedido', () => {
  it('modelo kimi-k3, reasoning_effort explícito, URL base internacional, rota /chat/completions, chave no cabeçalho', async () => {
    const { m, seen } = model([ok('{}')]);
    await m.generate(req());
    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(seen[0]!.url).toBe(`${KIMI_DEFAULT_BASE_URL}/chat/completions`);
    expect(KIMI_DEFAULT_BASE_URL).toBe('https://api.moonshot.ai/v1');
    expect(body.model).toBe('kimi-k3');
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_tokens).toBe(4000);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('NUNCA envia temperature nem seed, mesmo que o pedido traga', async () => {
    const { m, seen } = model([ok('{}')]);
    await m.generate(req({ params: { temperature: 0.7, seed: 42, maxOutputTokens: 100 } }));
    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'reasoning_effort']);
    expect(seen[0]!.body).not.toMatch(/temperature|seed/);
    expect(body.max_tokens).toBe(100);
    expect(m.describe().temperatureSent).toBe(false);
  });

  it('o teto de saída do pedido nunca passa do teto configurado', async () => {
    const { m, seen } = model([ok('{}')]);
    await m.generate(req({ params: { maxOutputTokens: 999999 } }));
    expect((JSON.parse(seen[0]!.body) as { max_tokens: number }).max_tokens).toBe(4000);
  });

  it('baseUrl e model são configuráveis sem mudar código (segundo modelo)', async () => {
    const { m, seen } = model([ok('{}')], { baseUrl: 'https://outro.exemplo/v1/', model: 'outro-modelo' });
    await m.generate(req());
    expect(seen[0]!.url).toBe('https://outro.exemplo/v1/chat/completions');
    expect((JSON.parse(seen[0]!.body) as { model: string }).model).toBe('outro-modelo');
    expect(m.describe()).toMatchObject({ model: 'outro-modelo', baseUrl: 'https://outro.exemplo/v1' });
  });

  it('baseUrl que não é https é recusada; sem teto de saída é recusado', () => {
    const t: HttpTransport = async () => ok('{}');
    expect(() => new KimiModel({ apiKey: KEY, transport: t, reasoningEffort: 'low', maxOutputTokens: 10, baseUrl: 'http://x' })).toThrow();
    expect(() => new KimiModel({ apiKey: KEY, transport: t, reasoningEffort: 'low', maxOutputTokens: 0 })).toThrow(RangeError);
  });

  it('o texto da fonte vai só nas mensagens; o system leva o schema', async () => {
    const { m, seen } = model([ok('{}')]);
    await m.generate(req());
    const msgs = (JSON.parse(seen[0]!.body) as { messages: { role: string; content: string }[] }).messages;
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('"required":["items"]');
    expect(msgs[1]).toEqual({ role: 'user', content: 'olá' });
  });
});

describe('K6. erros HTTP', () => {
  it('429 seguido de sucesso: tenta de novo com espera crescente', async () => {
    const { m, seen, sleeps } = model([{ status: 429, text: '{}' }, { status: 503, text: 'x' }, ok('{"a":1}')], { maxAttempts: 4 });
    expect((await m.generate(req())).output).toEqual({ a: 1 });
    expect(seen).toHaveLength(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it('429 até esgotar as tentativas: provider_error retentável, sem passar de N tentativas', async () => {
    const { m, seen } = model([{ status: 429, text: '{}' }], { maxAttempts: 3 });
    const e = await catchErr(m.generate(req()));
    expect(e).toMatchObject({ code: 'provider_error', retryable: true });
    expect(seen).toHaveLength(3);
  });

  it('401 e 403: NÃO retentáveis, uma só tentativa, mensagem sem a chave', async () => {
    for (const status of [401, 403]) {
      const { m, seen } = model([{ status, text: JSON.stringify({ error: { message: `chave ${KEY} inválida` } }) }]);
      const e = await catchErr(m.generate(req()));
      expect(e).toMatchObject({ code: 'provider_error', retryable: false });
      expect(seen).toHaveLength(1);
      expect(e.message).toContain(String(status));
      expect(e.message).not.toContain(KEY);
    }
  });

  it('400 por parâmetro: não retentável e a mensagem diz qual', async () => {
    const { m, seen } = model([{ status: 400, text: JSON.stringify({ error: { message: 'invalid temperature: only 1 is allowed' } }) }]);
    const e = await catchErr(m.generate(req()));
    expect(e).toMatchObject({ code: 'provider_error', retryable: false });
    expect(e.message).toContain('invalid temperature');
    expect(seen).toHaveLength(1);
  });

  it('falha de rede e tempo esgotado são retentáveis', async () => {
    const net = await catchErr(model([new TypeError('fetch failed')], { maxAttempts: 2 }).m.generate(req()));
    expect(net).toMatchObject({ code: 'provider_error', retryable: true });
    const slow: HttpTransport = (r) => new Promise((_, rej) => r.signal.addEventListener('abort', () => rej(new Error('abort'))));
    const m = new KimiModel({ apiKey: KEY, transport: slow, reasoningEffort: 'low', maxOutputTokens: 10, timeoutMs: 5, maxAttempts: 1 });
    const t = await catchErr(m.generate(req()));
    expect(t).toMatchObject({ code: 'provider_error', retryable: true });
    expect(t.message).toContain('tempo esgotado');
  });

  it('resposta 200 ilegível ou sem texto: provider_error', async () => {
    expect(await catchErr(model([{ status: 200, text: 'não é json' }], { maxAttempts: 1 }).m.generate(req()))).toMatchObject({ code: 'provider_error' });
    expect(await catchErr(model([{ status: 200, text: '{"choices":[]}' }], { maxAttempts: 1 }).m.generate(req()))).toMatchObject({ code: 'provider_error' });
  });

  it('abort respeitado: antes de chamar não toca a rede; durante a espera, para', async () => {
    const pre = new AbortController();
    pre.abort();
    const a = model([ok('{}')]);
    expect(await catchErr(a.m.generate(req({ signal: pre.signal })))).toMatchObject({ code: 'aborted' });
    expect(a.seen).toHaveLength(0);
    const ctl = new AbortController();
    const b = model([{ status: 429, text: '{}' }, ok('{}')], { sleep: async () => { ctl.abort(); } });
    expect(await catchErr(b.m.generate(req({ signal: ctl.signal })))).toMatchObject({ code: 'aborted' });
    expect(b.seen).toHaveLength(1);
  });
});

describe('K1/K8. a chave nunca aparece', () => {
  const leak = (x: unknown): boolean => JSON.stringify(x, Object.getOwnPropertyNames(x as object)).includes(KEY);

  it('erros serializados (todas as famílias) não contêm a chave', async () => {
    const cases: (HttpResponse | Error)[][] = [
      [{ status: 401, text: `{"error":{"message":"bad ${KEY}"}}` }],
      [{ status: 400, text: `{"error":{"message":"echo ${KEY}"}}` }],
      [{ status: 429, text: `${KEY}` }],
      [{ status: 200, text: `isto ${KEY} não é json` }],
      [new Error(`falha com ${KEY}`)],
    ];
    for (const script of cases) {
      const e = await catchErr(model(script, { maxAttempts: 1 }).m.generate(req()));
      expect(leak(e)).toBe(false);
      expect(e.message).not.toContain(KEY);
      expect(String(e.stack)).not.toContain(KEY);
    }
  });

  it('respostas brutas gravadas e saída de texto sem JSON não contêm a chave', async () => {
    const raws: RawRecord[] = [];
    const { m } = model([ok(`o servidor ecoou ${KEY} no texto`)], { onRaw: (r) => raws.push(r) });
    const r = await m.generate(req());
    expect(raws).toHaveLength(1);
    expect(JSON.stringify(raws)).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('describe() e o objeto do adaptador não expõem a chave', () => {
    const { m } = model([ok('{}')]);
    expect(JSON.stringify(m.describe())).not.toContain(KEY);
  });
});

describe('K1/K2. configuração por ambiente', () => {
  it('sem chave: recusa; com chave: URL base internacional por omissão; URL base configurável', () => {
    expect(() => kimiConfigFromEnv({})).toThrow('MOONSHOT_API_KEY');
    expect(() => kimiConfigFromEnv({ MOONSHOT_API_KEY: '   ' })).toThrow('MOONSHOT_API_KEY');
    expect(kimiConfigFromEnv({ MOONSHOT_API_KEY: KEY })).toEqual({ apiKey: KEY, baseUrl: 'https://api.moonshot.ai/v1' });
    expect(kimiConfigFromEnv({ MOONSHOT_API_KEY: KEY, MOONSHOT_BASE_URL: 'https://x.example/v1/' }).baseUrl).toBe('https://x.example/v1');
    expect(() => kimiConfigFromEnv({ MOONSHOT_API_KEY: KEY, MOONSHOT_BASE_URL: 'http://x' })).toThrow('https');
  });

  it('a mensagem de erro de chave ausente não imprime nenhum valor de ambiente', () => {
    try { kimiConfigFromEnv({ OUTRA: KEY }); } catch (e) { expect(String((e as Error).message)).not.toContain(KEY); }
  });
});
