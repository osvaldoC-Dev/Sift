import type { JsonValue } from '@sift/core';

/**
 * O modelo é uma FUNÇÃO: entra contexto, sai saída estruturada. Ele nunca escreve no estado, nunca
 * gera IDs nem posições (isso é do código) e o texto das fontes é sempre dado, nunca instrução.
 * Esta porta não conhece nenhum provedor: adaptadores reais (futuro `src/adapters/`) a implementam,
 * e a chave do provedor fica só no servidor.
 */

export type JsonSchema = { [key: string]: JsonValue };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelParams {
  temperature?: number;
  maxOutputTokens?: number;
  seed?: number;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  /** Schema da saída estruturada esperada. */
  schema: JsonSchema;
  params: ModelParams;
  /**
   * Cancelamento. Se já estiver abortado, a chamada rejeita com `ModelPortError('aborted')` sem
   * consumir nada do modelo. Não faz parte da identidade do pedido (não entra no `requestHash`).
   */
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Parte de `inputTokens` servida do cache do provedor (mais barata). Ausente = não informado. */
  cachedInputTokens?: number;
  /** Verdadeiro quando o provedor não informou o uso e o adaptador ESTIMOU (nunca zero). */
  estimated?: boolean;
}

export interface ModelResponse {
  /**
   * Saída estruturada (JSON). A porta NÃO garante que ela obedeça ao `schema`: validar e rejeitar
   * saída inválida é do pipeline (3.2). Saída inválida é recusada, nunca consertada à mão.
   */
  output: JsonValue;
  usage: ModelUsage;
  /** Modelo que de fato respondeu (pode diferir do pedido se o provedor fizer fallback). */
  model: string;
}

export interface ModelPort {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelPortErrorCode =
  | 'no_response' // nada roteirizado/gravado para esta chamada (só em modelos de teste)
  | 'provider_error' // falha do provedor (adaptadores reais)
  | 'aborted' // o `signal` do pedido foi abortado
  | 'cost_cap_exceeded'; // o teto de custo da execução foi atingido (adaptadores reais)

export class ModelPortError extends Error {
  readonly code: ModelPortErrorCode;
  /** Só `provider_error` pode ser retentável (429/5xx/timeout); 401/403/400 não. Padrão de `provider_error`: retentável. */
  readonly retryable: boolean;
  /** Uso já gasto pela chamada que falhou (ex.: a que estourou o teto), para o relatório mostrar o gasto real. */
  readonly usage?: ModelUsage;
  constructor(code: ModelPortErrorCode, message: string, opts: { retryable?: boolean; usage?: ModelUsage } = {}) {
    super(message);
    this.name = 'ModelPortError';
    this.code = code;
    this.retryable = opts.retryable ?? code === 'provider_error';
    if (opts.usage !== undefined) this.usage = opts.usage;
  }
}

/** Rejeita com `aborted` se o pedido já foi cancelado. Usado por todas as implementações da porta. */
export function throwIfAborted(request: Pick<ModelRequest, 'signal'>): void {
  if (request.signal?.aborted) throw new ModelPortError('aborted', 'chamada cancelada pelo signal');
}
