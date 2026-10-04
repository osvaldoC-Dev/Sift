import type { JsonValue } from '@sift/core';
import {
  ModelPortError,
  type ModelPort, type ModelRequest, type ModelResponse, type ModelUsage,
} from '../ports';

/** Um passo do roteiro: uma resposta, ou uma falha do provedor. */
export type FakeStep =
  | { output: JsonValue; usage?: ModelUsage; model?: string }
  | { error: string };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Modelo falso, determinístico: devolve os passos do roteiro NA ORDEM, ignorando o conteúdo do
 * pedido (que fica registrado em `calls` para os testes inspecionarem). Roteiro esgotado =
 * ModelPortError('no_response'); isso evita que um teste "passe" por engano chamando o modelo
 * mais vezes do que o previsto.
 */
export class FakeModel implements ModelPort {
  private readonly steps: FakeStep[];
  private readonly defaultModel: string;
  private cursor = 0;
  private readonly seen: ModelRequest[] = [];

  constructor(steps: FakeStep[], opts: { model?: string } = {}) {
    this.steps = clone(steps);
    this.defaultModel = opts.model ?? 'fake-model';
  }

  /** Cópias dos pedidos recebidos, em ordem. */
  get calls(): readonly ModelRequest[] {
    return this.seen;
  }
  get remaining(): number {
    return this.steps.length - this.cursor;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.seen.push(clone(request));
    const step = this.steps[this.cursor];
    if (step === undefined) {
      throw new ModelPortError('no_response', `FakeModel: roteiro esgotado (${this.steps.length} passo(s))`);
    }
    this.cursor++;
    if ('error' in step) throw new ModelPortError('provider_error', step.error);
    return clone({
      output: step.output,
      usage: step.usage ?? { inputTokens: 0, outputTokens: 0 },
      model: step.model ?? this.defaultModel,
    });
  }
}
