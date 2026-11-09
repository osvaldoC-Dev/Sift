import { canonicalize, sha256Hex, type Hash } from '@sift/core';
import type { LogEntry as LogEntryView } from '@sift/contract';

/**
 * Cadeia de auditoria da API (o `log` do contrato). É DIFERENTE da cadeia do núcleo: o núcleo só tem o que foi
 * APLICADO; o histórico que a interface mostra também tem captura, proposta e rejeição. O hash usa só campos
 * que o cliente recebe, então quem tem a lista consegue conferi-la sozinho:
 *   hash = sha256( (prevHash ?? '') + '\n' + canonicalize({seq, action, targetId, at}) )
 */
export const auditHash = (
  prevHash: Hash | null,
  e: Pick<LogEntryView, 'seq' | 'action' | 'targetId' | 'at'>,
): Hash =>
  sha256Hex(`${prevHash ?? ''}\n${canonicalize({ seq: e.seq, action: e.action, targetId: e.targetId, at: e.at })}`);

export type AuditVerification =
  | { ok: true }
  | { ok: false; seq: number; reason: 'seq_out_of_order' | 'prev_hash_mismatch' | 'hash_mismatch' };

export function verifyAuditChain(entries: readonly LogEntryView[]): AuditVerification {
  let prev: Hash | null = null;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) return { ok: false, seq: e.seq, reason: 'seq_out_of_order' };
    if (e.prevHash !== prev) return { ok: false, seq: e.seq, reason: 'prev_hash_mismatch' };
    if (auditHash(e.prevHash, e) !== e.hash) return { ok: false, seq: e.seq, reason: 'hash_mismatch' };
    prev = e.hash;
    expectedSeq++;
  }
  return { ok: true };
}
