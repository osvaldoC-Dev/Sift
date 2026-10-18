import type { ContentReader } from './ports';
import { DEFAULT_EVIDENCE_LIMITS, DEFAULT_SOURCE_KINDS, resolveKind, type EvidenceLimits, type FidelityReason, type SourceKinds } from './source';
import type { EvidenceRef, Operation } from './types';

export interface FidelityFailure {
  opIndex: number;
  evidenceIndex: number;
  reason: FidelityReason;
  ref: EvidenceRef;
}
/**
 * Verificação MECÂNICA: o trecho citado existe, exatamente, na versão imutável da fonte.
 * Prova existência, não que o trecho sustenta a afirmação.
 */
export async function verifyEvidence(
  ops: Operation[],
  reader: ContentReader,
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
  kinds: SourceKinds = DEFAULT_SOURCE_KINDS,
): Promise<FidelityFailure[]> {
  const failures: FidelityFailure[] = [];
  // O hash do conteúdo devolvido é conferido uma vez por (kind, hash) dentro de uma chamada.
  const hashOk = new Map<string, boolean>();
  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const evidence = ops[opIndex]!.evidence;
    for (let evidenceIndex = 0; evidenceIndex < evidence.length; evidenceIndex++) {
      const ref = evidence[evidenceIndex]!;
      const fail = (reason: FidelityReason) => failures.push({ opIndex, evidenceIndex, reason, ref });
      const kind = resolveKind(ref, kinds);
      if (kind === undefined) {
        fail('unknown_kind');
        continue;
      }
      const cannotCheck = kind.check(ref, limits);
      if (cannotCheck !== undefined) {
        fail(cannotCheck);
        continue;
      }
      const body = await reader.get(ref.contentHash);
      if (body === undefined) {
        fail('content_missing');
        continue;
      }
      const memo = `${kind.kind}:${ref.contentHash}`;
      let matches = hashOk.get(memo);
      if (matches === undefined) {
        matches = kind.hashOf(body) === ref.contentHash;
        hashOk.set(memo, matches);
      }
      if (!matches) {
        fail('hash_mismatch');
        continue;
      }
      const reason = kind.verify(ref, body);
      if (reason !== undefined) fail(reason);
    }
  }
  return failures;
}
