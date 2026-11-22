import { ModelPortError, type ModelPort, type ModelRequest, type ModelResponse, type ModelUsage } from './ports';

/** Preços em dólares por milhão de tokens. */
export interface Prices {
  inputUsdPerM: number;
  cachedInputUsdPerM: number;
  outputUsdPerM: number;
}

/** Preços oficiais do Kimi K3 (anúncio de 22/07/2026): entrada US$ 3, entrada em cache US$ 0,30, saída US$ 15. */
export const KIMI_K3_PRICES: Prices = { inputUsdPerM: 3, cachedInputUsdPerM: 0.3, outputUsdPerM: 15 };

/**
 * Teto de custo de UMA execução. Os dois valores são obrigatórios: sem teto configurado nada corre.
 * Os tokens de raciocínio contam como saída (já vêm em `outputTokens`).
 */
export interface CostCaps {
  maxUsd: number;
  maxTotalTokens: number;
}

export function assertCaps(caps: Partial<CostCaps> | undefined): asserts caps is CostCaps {
  const ok = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (caps === undefined || !ok(caps.maxUsd) || !ok(caps.maxTotalTokens)) {
    throw new RangeError('teto de custo ausente ou inválido: maxUsd e maxTotalTokens são obrigatórios e positivos');
  }
}

/** Custo em dólares de um uso. A parte em cache de `inputTokens` custa o preço de cache; nunca devolve negativo. */
export function costUsd(u: ModelUsage, p: Prices): number {
  const cached = Math.min(Math.max(u.cachedInputTokens ?? 0, 0), u.inputTokens);
  const fresh = u.inputTokens - cached;
  return (fresh * p.inputUsdPerM + cached * p.cachedInputUsdPerM + u.outputTokens * p.outputUsdPerM) / 1_000_000;
}

export interface CostSnapshot {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: number;
  /** Chamadas cujo uso o fornecedor não informou e foi ESTIMADO (por cima, nunca zero). */
  estimatedCalls: number;
}

/**
 * Medidor de custo + corte. `wrap(port)` devolve uma `ModelPort` que:
 *  - recusa chamar o modelo se o teto já foi atingido (`cost_cap_exceeded`, sem gastar nada);
 *  - soma o uso real de cada resposta e, se o gasto ATINGIR o teto (>=), lança `cost_cap_exceeded` levando o uso da
 *    chamada que estourou (o gasto real aparece no relatório) e a resposta é descartada.
 * Um guarda pode embrulhar outro (teto por fonte dentro do teto total da corrida). O custo de uma execução nunca
 * passa do teto por mais do que UMA chamada, e essa é limitada pelo teto de tokens de saída do adaptador.
 */
export class CostGuard {
  private usd = 0;
  private input = 0;
  private output = 0;
  private calls = 0;
  private estimated = 0;

  constructor(
    readonly caps: CostCaps,
    readonly prices: Prices,
    readonly label = 'execução',
  ) {
    assertCaps(caps);
  }

  snapshot(): CostSnapshot {
    return {
      usd: this.usd, inputTokens: this.input, outputTokens: this.output,
      totalTokens: this.input + this.output, calls: this.calls, estimatedCalls: this.estimated,
    };
  }

  private reached(): boolean {
    return this.usd >= this.caps.maxUsd || this.input + this.output >= this.caps.maxTotalTokens;
  }

  private add(u: ModelUsage): void {
    this.usd += costUsd(u, this.prices);
    this.input += u.inputTokens;
    this.output += u.outputTokens;
    this.calls++;
    if (u.estimated === true) this.estimated++;
  }

  private capError(usage?: ModelUsage): ModelPortError {
    const s = this.snapshot();
    return new ModelPortError(
      'cost_cap_exceeded',
      `teto de custo atingido (${this.label}): US$ ${s.usd.toFixed(4)} de US$ ${this.caps.maxUsd}, ${s.totalTokens} de ${this.caps.maxTotalTokens} tokens`,
      usage === undefined ? {} : { usage },
    );
  }

  wrap(port: ModelPort): ModelPort {
    return {
      generate: async (request: ModelRequest): Promise<ModelResponse> => {
        if (this.reached()) throw this.capError();
        let res: ModelResponse;
        try {
          res = await port.generate(request);
        } catch (e) {
          if (e instanceof ModelPortError && e.usage !== undefined) this.add(e.usage); // gasto de quem estourou mais abaixo
          throw e;
        }
        this.add(res.usage);
        if (this.reached()) throw this.capError(res.usage);
        return res;
      },
    };
  }
}
