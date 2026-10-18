import type { Hash, Operation, ItemId, Attrs } from '@sift/core';

/**
 * A camada que CRIA a fonte exige a origem: quem trouxe o texto (pessoa ou IA). No Project Schema o campo é
 * opcional (para aceitar fontes antigas), aqui é obrigatório. Uma fonte de IA diz qual execução a trouxe.
 * `capturedAt` é declarado por quem traz, não é verificado e nunca entra em lógica.
 */
export interface SourceCreation {
  id: string;
  label: string;
  contentHash: Hash;
  originType: 'human' | 'ai';
  originLabel?: string;
  originRunId?: string;
  capturedAt?: string;
}

export function sourceCreationOp(p: SourceCreation): Operation {
  if (p.originType !== 'human' && p.originType !== 'ai') throw new Error('originType é obrigatório: human ou ai');
  if (p.originType === 'ai' && (p.originRunId === undefined || p.originRunId === '')) {
    throw new Error('fonte de IA exige originRunId');
  }
  const attributes: Attrs = { label: p.label, originType: p.originType };
  if (p.originLabel !== undefined) attributes.originLabel = p.originLabel;
  if (p.originRunId !== undefined) attributes.originRunId = p.originRunId;
  if (p.capturedAt !== undefined) attributes.capturedAt = p.capturedAt;
  return {
    op: 'create_item', itemId: p.id as ItemId, type: 'source', status: 'active',
    contentHash: p.contentHash, attributes, evidence: [],
  };
}
