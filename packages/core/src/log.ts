import { canonicalize, sha256Hex } from './canonical';
import type { Hash, LogEntry, LogEntryBody } from './types';

export const GENESIS_HASH: Hash = '0'.repeat(64);

export function sealEntry(prevHash: Hash, body: LogEntryBody): LogEntry {
  return { ...body, prevHash, entryHash: sha256Hex(prevHash + '\n' + canonicalize(body)) };
}

export type ChainResult = { ok: true } | { ok: false; version: number; reason: string };

/** Verifica a cadeia de hashes (detecção de adulteração). */
export function verifyChain(entries: readonly LogEntry[]): ChainResult {
  let prev = GENESIS_HASH;
  for (const e of entries) {
    const { prevHash, entryHash, ...body } = e;
    if (prevHash !== prev) return { ok: false, version: e.version, reason: 'prev_hash_mismatch' };
    if (sha256Hex(prevHash + '\n' + canonicalize(body)) !== entryHash) {
      return { ok: false, version: e.version, reason: 'entry_hash_mismatch' };
    }
    prev = entryHash;
  }
  return { ok: true };
}
