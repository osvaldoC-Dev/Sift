import type { ProjectStore, Store } from '../src';

/** Gerador pseudo-aleatório determinístico (mulberry32). A semente fixa a SEQUÊNCIA de esperas sorteadas, não o escalonamento: os `setTimeout` reais deixam a ordem de chegada variar entre execuções. Por isso o teste usa várias sementes e afirma só invariantes, nunca uma ordem exata. */
export const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Embrulha um `Store` e põe uma espera ANTES e DEPOIS de cada chamada ao projeto. As esperas abrem janelas entre o
 * "ler o estado" e o "escrever" de um tratador da API, que é onde dois pedidos concorrentes se atropelam num armazém
 * real (Postgres). Em memória, sem latência, o atropelo é invisível (a mutação X10 sobrevivia por isso).
 * Quem testa um armazém durável usa o mesmo embrulho por cima dele.
 */
export function withLatency(inner: Store, seed: number, maxMs = 3): Store {
  const rnd = prng(seed);
  const wait = () => new Promise<void>((r) => setTimeout(r, Math.floor(rnd() * (maxMs + 1))));
  return {
    async project(id) {
      const ps = await inner.project(id);
      if (ps === undefined) return undefined;
      return new Proxy(ps, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv);
          if (typeof v !== 'function') return v;
          return async (...args: unknown[]) => {
            await wait();
            const out = await (v as (...a: unknown[]) => unknown).apply(target, args);
            await wait();
            return out;
          };
        },
      }) as ProjectStore;
    },
  };
}
