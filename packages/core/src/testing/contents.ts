import { contentHash, normalizeText } from '../evidence';
import type { Clock, ContentReader, IdGenerator } from '../ports';
import type { Hash } from '../types';

/** Armazém de conteúdo em memória (equivalente à tabela `contents`). */
export class InMemoryContents implements ContentReader {
  private readonly map = new Map<Hash, string>();

  add(text: string): Hash {
    const normalized = normalizeText(text);
    const hash = contentHash(normalized);
    this.map.set(hash, normalized);
    return hash;
  }
  async get(hash: Hash): Promise<string | undefined> {
    return this.map.get(hash);
  }
}

export function sequentialIds(prefix = 'id'): IdGenerator {
  let n = 0;
  return { next: () => `${prefix}${++n}` };
}

/** Relógio determinístico: cada chamada avança 1 segundo. */
export function fixedClock(startMs = Date.UTC(2026, 0, 1)): Clock {
  let n = 0;
  return { now: () => new Date(startMs + ++n * 1000).toISOString() };
}
