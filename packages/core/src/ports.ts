import type { Hash } from './types';

export interface Clock {
  now(): string; // ISO-8601
}
export interface IdGenerator {
  next(): string;
}
export interface ContentReader {
  get(hash: Hash): Promise<string | undefined>;
}
