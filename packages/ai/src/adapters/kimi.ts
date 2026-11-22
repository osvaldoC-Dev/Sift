import type { JsonValue } from '@sift/core';
import { redactSecrets } from '../secrets';
import {
  ModelPortError,
  type ModelPort, type ModelRequest, type ModelResponse, type ModelUsage,
} from '../ports';

/**
 * Adaptador do Kimi K3 (Moonshot) atrás da `ModelPort`. É um dos poucos ficheiros que podem tocar em rede e em
 * variáveis de ambiente (testes de arquitetura). A chave só entra por `kimiConfigFromEnv` e nunca sai daqui:
 * nem em erro, nem em gravação, nem em log. NUNCA enviamos `temperature` (K3: NÃO CONFIRMADO; nos K2.5/K2.6 outros
 * valores dão erro) nem `seed`. A rota `/v1/chat/completions` no estilo OpenAI é NÃO CONFIRMADA para o K3: a primeira
 * chamada real mínima (K9, feita pelo Osvaldo) é que a confirma. Este ficheiro foi testado SÓ com transporte falso.
 */

export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
export const KIMI_DEFAULT_MODEL = 'kimi-k3';
export type ReasoningEffort = 'low' | 'high' | 'max';

export interface HttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}
export interface HttpResponse {
  status: number;
  text: string;
}
/** Transporte injetável: em produção `fetchTransport`; nos testes, um servidor falso. */
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export interface RawRecord {
  attempt: number;
  status: number;
  /** Corpo bruto da resposta do fornecedor, com segredos redigidos. */
  text: string;
}

export interface KimiConfig {
  apiKey: string;
  transport: HttpTransport;
  /** Explícito e registado no relatório. Começar com `low`. */
  reasoningEffort: ReasoningEffort;
  /** Teto de tokens de saída por chamada (inclui o raciocínio). Obrigatório. */
  maxOutputTokens: number;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Recebe cada resposta bruta (para gravar e repetir offline). */
  onRaw?: (r: RawRecord) => void;
}

export interface KimiDescription {
  provider: 'moonshot';
  model: string;
  baseUrl: string;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  /** Sempre falso: o adaptador nunca envia `temperature`. */
  temperatureSent: false;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Lê chave e URL base do ambiente. Recusa arrancar sem chave e com URL base que não seja https. */
export function kimiConfigFromEnv(env: Record<string, string | undefined>): { apiKey: string; baseUrl: string } {
  const apiKey = env.MOONSHOT_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') throw new Error('MOONSHOT_API_KEY ausente: defina a chave no ambiente do servidor');
  const baseUrl = (env.MOONSHOT_BASE_URL ?? KIMI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!baseUrl.startsWith('https://')) throw new Error('MOONSHOT_BASE_URL tem de ser https');
  return { apiKey: apiKey.trim(), baseUrl };
}

/** Transporte real (único uso de rede deste ficheiro). Os testes nunca o usam. */
export const fetchTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal });
  return { status: res.status, text: await res.text() };
};

/** Extrai o JSON do texto, aceitando uma cerca de código. Qualquer outra coisa é inválida. */
export function extractJson(text: string): { ok: true; value: JsonValue } | { ok: false } {
  const tryParse = (t: string): { ok: true; value: JsonValue } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(t) as JsonValue };
    } catch {
      return { ok: false };
    }
  };
  const direct = tryParse(text.trim());
  if (direct.ok) return direct;
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
  return fenced ? tryParse(fenced[1]!) : { ok: false };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

export class KimiModel implements ModelPort {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cfg: KimiConfig) {
    if (cfg.apiKey.trim() === '') throw new Error('chave vazia');
    if (!(Number.isFinite(cfg.maxOutputTokens) && cfg.maxOutputTokens > 0)) throw new RangeError('maxOutputTokens obrigatório e positivo');
    this.model = cfg.model ?? KIMI_DEFAULT_MODEL;
    this.baseUrl = (cfg.baseUrl ?? KIMI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!this.baseUrl.startsWith('https://')) throw new Error('baseUrl tem de ser https');
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.maxAttempts = Math.max(1, cfg.maxAttempts ?? 3);
    this.backoffMs = cfg.backoffMs ?? 1000;
    this.sleep = cfg.sleep ?? wait;
  }

  describe(): KimiDescription {
    return {
      provider: 'moonshot', model: this.model, baseUrl: this.baseUrl, reasoningEffort: this.cfg.reasoningEffort,
      maxOutputTokens: this.cfg.maxOutputTokens, temperatureSent: false,
    };
  }

  private scrub(text: string): string {
    return redactSecrets(text, [this.cfg.apiKey]);
  }

  private fail(message: string, retryable: boolean): ModelPortError {
    return new ModelPortError('provider_error', this.scrub(message), { retryable });
  }

  private body(request: ModelRequest): string {
    const system = `${request.system}\n\nResponda SOMENTE com um objeto JSON que obedeça a este schema, sem texto antes ou depois:\n${JSON.stringify(request.schema)}`;
    return JSON.stringify({
      model: this.model,
      messages: [{ role: 'system', content: system }, ...request.messages.map((m) => ({ role: m.role, content: m.content }))],
      reasoning_effort: this.cfg.reasoningEffort,
      max_tokens: Math.min(this.cfg.maxOutputTokens, request.params.maxOutputTokens ?? this.cfg.maxOutputTokens),
    });
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const aborted = (): ModelPortError => new ModelPortError('aborted', 'chamada abortada');
    if (request.signal?.aborted) throw aborted();
    const body = this.body(request);
    const url = `${this.baseUrl}/chat/completions`;
    let lastError: ModelPortError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1) {
        await this.sleep(this.backoffMs * 2 ** (attempt - 2));
        if (request.signal?.aborted) throw aborted();
      }
      const ctl = new AbortController();
      const onAbort = (): void => ctl.abort();
      request.signal?.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, this.timeoutMs);
      let res: { status: number; text: string };
      try {
        res = await this.cfg.transport({
          url, method: 'POST', body, signal: ctl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        });
      } catch (e) {
        if (request.signal?.aborted) throw aborted();
        lastError = this.fail(timedOut ? `tempo esgotado (${this.timeoutMs} ms)` : `falha de rede: ${e instanceof Error ? e.name : 'erro'}`, true);
        continue;
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
      }
      if (request.signal?.aborted) throw aborted();
      const text = this.scrub(res.text);
      this.cfg.onRaw?.({ attempt, status: res.status, text });

      if (res.status === 429 || res.status >= 500) {
        lastError = this.fail(`o fornecedor respondeu HTTP ${res.status}`, true);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw this.fail(`autenticação recusada pelo fornecedor (HTTP ${res.status}); confira a chave no ambiente`, false);
      }
      if (res.status >= 400) {
        let why = '';
        try {
          const j: unknown = JSON.parse(res.text);
          const err = isObj(j) && isObj(j.error) ? j.error.message : undefined;
          if (typeof err === 'string') why = `: ${err.slice(0, 300)}`;
        } catch { /* corpo sem JSON */ }
        throw this.fail(`pedido recusado pelo fornecedor (HTTP ${res.status})${why}`, false);
      }
      return this.parse(res.text, request, body);
    }
    throw lastError ?? this.fail('falha desconhecida', true);
  }

  private parse(rawText: string, request: ModelRequest, sentBody: string): ModelResponse {
    let j: unknown;
    try {
      j = JSON.parse(rawText);
    } catch {
      throw this.fail('resposta do fornecedor ilegível (não é JSON)', true);
    }
    const choice = isObj(j) && Array.isArray(j.choices) ? j.choices[0] : undefined;
    const message = isObj(choice) ? choice.message : undefined;
    const content = isObj(message) ? message.content : undefined;
    if (typeof content !== 'string') throw this.fail('resposta do fornecedor sem texto em choices[0].message.content', true);

    const out = extractJson(content);
    // Texto sem JSON NÃO é consertado aqui: vai como string e o pipeline o recusa (schema_invalid / unchecked).
    const output: JsonValue = out.ok ? out.value : this.scrub(content).slice(0, 500);

    return {
      output,
      usage: this.usage(isObj(j) ? j.usage : undefined, sentBody),
      model: isObj(j) && typeof j.model === 'string' && j.model !== '' ? j.model : this.model,
    };
  }

  /**
   * Uso real do fornecedor. Se faltar, o custo NUNCA vira zero: estima-se por cima (entrada = caracteres/2, saída =
   * o teto de saída configurado) e marca-se `estimated`.
   */
  private usage(u: unknown, sentBody: string): ModelUsage {
    if (isObj(u)) {
      const input = num(u.prompt_tokens);
      const output = num(u.completion_tokens);
      if (input !== undefined && output !== undefined) {
        const details = isObj(u.prompt_tokens_details) ? num(u.prompt_tokens_details.cached_tokens) : undefined;
        const cached = num(u.cached_tokens) ?? details; // dois formatos possíveis: NÃO CONFIRMADO para o K3
        return { inputTokens: input, outputTokens: output, ...(cached !== undefined ? { cachedInputTokens: Math.min(cached, input) } : {}) };
      }
    }
    return { inputTokens: Math.ceil(sentBody.length / 2), outputTokens: this.cfg.maxOutputTokens, estimated: true };
  }
}
