import type { ProjectStore, Store } from '../src';

/** Gerador pseudo-aleatório determinístico (mulberry32). */
export const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Cede a vez ao laço de eventos `n` vezes (cada cessão deixa os outros pedidos avançarem um passo). */
export const ticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

/**
 * Embrulha um `Store` e põe uma pausa ANTES e DEPOIS de cada chamada ao projeto. As pausas abrem janelas entre o
 * "ler o estado" e o "escrever" de um tratador da API, que é onde dois pedidos concorrentes se atropelam num armazém
 * real (Postgres). Em memória, sem pausas, o atropelo é invisível (a mutação X10 sobrevivia por isso).
 *
 * A pausa é medida em CESSÕES do laço de eventos (`setImmediate`), não em milissegundos: o custo é microssegundos por
 * pausa (os testes de concorrência deixam de custar segundos no CI) e o escalonamento passa a ser determinístico: a
 * mesma semente com o mesmo código dá o mesmo entrelaçamento. Mudar o código dos tratadores muda o entrelaçamento, e é
 * por isso que os testes usam várias sementes e afirmam só invariantes, nunca uma ordem exata.
 * `maxTicks` é o máximo de cessões por pausa (0 a `maxTicks`).
 * Quem testa um armazém durável usa o mesmo embrulho por cima dele.
 */
export function withLatency(inner: Store, seed: number, maxTicks = 3): Store {
  const rnd = prng(seed);
  const wait = () => ticks(Math.floor(rnd() * (maxTicks + 1)));
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
