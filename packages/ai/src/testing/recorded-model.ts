import { canonicalize, sha256Hex } from '@sift/core';
import {
  ModelPortError,
  type ModelPort, type ModelRequest, type ModelResponse,
} from '../ports';

/** Identidade do pedido: hash do JSON canônico de system, messages, schema e params. */
export function requestHash(request: ModelRequest): string {
  return sha256Hex(
    canonicalize({
      system: request.system,
      messages: request.messages,
      schema: request.schema,
      params: request.params,
    }),
  );
}

export interface RecordedEntry {
  requestHash: string;
  response: ModelResponse;
}
export interface Recording {
  version: 1;
  entries: RecordedEntry[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Repete respostas gravadas, indexadas pelo hash do pedido: o mesmo pedido recebe sempre a mesma
 * resposta, em qualquer ordem e quantas vezes for repetido (modo replay do Marco 3: determinístico,
 * sem rede). Pedido que não está na gravação = ModelPortError('no_response'): se o prompt mudou,
 * a gravação precisa ser refeita de propósito, nunca "adivinhada".
 */
export class RecordedModel implements ModelPort {
  private readonly byHash = new Map<string, ModelResponse>();

  constructor(recording: Recording) {
    if (recording.version !== 1) throw new Error(`Recording: versão não suportada (${String(recording.version)})`);
    for (const e of recording.entries) {
      const prev = this.byHash.get(e.requestHash);
      if (prev !== undefined && canonicalize(prev) !== canonicalize(e.response)) {
        throw new Error(`Recording ambígua: o mesmo pedido (${e.requestHash.slice(0, 12)}…) tem respostas diferentes`);
      }
      this.byHash.set(e.requestHash, clone(e.response));
    }
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const hit = this.byHash.get(requestHash(request));
    if (hit === undefined) {
      throw new ModelPortError('no_response', 'RecordedModel: pedido não está na gravação');
    }
    return clone(hit);
  }
}
