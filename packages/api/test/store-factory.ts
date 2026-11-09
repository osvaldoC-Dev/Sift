import type { Clock, IdGenerator } from '@sift/core';
import { createMemoryStore, type Store } from '../src';

/**
 * ÚNICO ponto em que os testes escolhem a implementação de `Store`. O marco 1b troca esta função pelo Postgres
 * (por exemplo, quando `SIFT_TEST_DATABASE_URL` existir) e a suíte inteira corre sem outra alteração.
 */
export type MakeStore = (o: { projects: string[]; clock: Clock; ids: IdGenerator; schema?: unknown }) => Store;
export const makeStore: MakeStore = (o) => createMemoryStore(o);
