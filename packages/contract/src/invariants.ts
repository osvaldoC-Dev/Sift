/**
 * Invariantes entre campos de uma ProposalView. O schema (zod) só valida a FORMA; estas regras validam o SENTIDO.
 * A API corre `checkProposalInvariants` sobre cada proposta que emite; o servidor falso da interface também.
 * Devolve a lista de violações (vazia = conforme). Não importa nada fora do contrato.
 */
import type { ProposalView } from "./index";

export function checkProposalInvariants(p: ProposalView): string[] {
  const v: string[] = [];
  const blocked = (a: ProposalView["canAccept"]) => !a.ok;
  const code = (a: ProposalView["canAccept"]) => (a.ok ? null : a.code);

  if (p.status !== "pending") {
    for (const [name, a] of [["canAccept", p.canAccept], ["canReject", p.canReject], ["canBatchAccept", p.canBatchAccept]] as const)
      if (code(a) !== "already_decided") v.push(`${name} de proposta já decidida tem de ser already_decided`);
    return v;
  }
  if (p.quote.found === 0) {
    if (code(p.canAccept) !== "citation_not_found") v.push("citação não encontrada: canAccept tem de ser citation_not_found");
    if (!blocked(p.canBatchAccept)) v.push("citação não encontrada: não pode ser elegível a lote");
    if (!p.canReject.ok) v.push("citação não encontrada: rejeitar tem de continuar possível");
  }
  if (p.stale && p.canAccept.ok) v.push("proposta desatualizada não pode ser aceite");
  if (p.type === "decision" && p.canBatchAccept.ok) v.push("decisão nunca é elegível a lote");
  if (p.support !== "full" && p.canBatchAccept.ok) v.push("suporte diferente de full nunca é elegível a lote");
  if (p.quote.found > 1 && p.canBatchAccept.ok) v.push("citação ambígua nunca é elegível a lote");
  if (p.edited && p.support !== "unchecked") v.push("proposta editada tem de ter suporte unchecked");
  if (p.verifierFailed && p.support !== "unchecked") v.push("verificador falhou: suporte tem de ser unchecked");
  if (p.support === "none" && p.canAccept.ok) v.push("suporte none não pode ser aceite");
  if (p.originType === "ai" && p.canAccept.ok === false && p.canReject.ok === false && p.status === "pending")
    v.push("proposta pendente tem de poder, pelo menos, ser rejeitada");
  return v;
}
