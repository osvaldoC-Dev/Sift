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
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
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
  | 'provider_error'; // falha do provedor (adaptadores reais)

export class ModelPortError extends Error {
  readonly code: ModelPortErrorCode;
  constructor(code: ModelPortErrorCode, message: string) {
    super(message);
    this.name = 'ModelPortError';
    this.code = code;
  }
}
