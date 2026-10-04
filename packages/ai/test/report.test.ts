import { describe, expect, it } from 'vitest';
import { DISCARD_REASONS, type DiscardedItem, type RunReport } from '../src';

describe('tipos do relatório de execução', () => {
  it('lista exatamente os quatro motivos de descarte', () => {
    expect([...DISCARD_REASONS].sort()).toEqual(
      ['duplicate', 'invalid_citation', 'not_supported', 'validation_refused'],
    );
  });

  it('um relatório com todos os motivos é JSON puro e mantém a invariante de contagem', () => {
    const discarded: DiscardedItem[] = [
      { ref: '$1', reason: 'invalid_citation', quote: 'water boils at 90 C', problem: 'text_mismatch', detail: 'trecho não encontrado' },
      { ref: '$2', reason: 'invalid_citation', quote: 'the same phrase', problem: 'ambiguous', detail: 'aparece duas vezes' },
      { ref: '$3', reason: 'not_supported', quote: 'water is wet', verdict: 'none', detail: 'não sustenta' },
      { ref: '$4', reason: 'duplicate', duplicateOf: 'item-17', detail: 'já existe no estado' },
      { ref: '$5', reason: 'validation_refused', issueCodes: ['basis_missing', 'support_none'], detail: 'recusado' },
    ];
    const report: RunReport = {
      runId: 'run-1', baseVersion: 7, model: 'fake-model', promptVersion: 'extract@1',
      usage: { inputTokens: 1200, outputTokens: 340 },
      modelChanges: 7, kept: 2, discarded,
      coverage: [{ sourceId: 's1', contentHash: 'a'.repeat(64), passagesTotal: 12, passagesCited: 3 }],
    };
    expect(report.modelChanges).toBe(report.kept + report.discarded.length);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect([...new Set(discarded.map((d) => d.reason))].sort()).toEqual([...DISCARD_REASONS].sort());
  });

  it('o relatório não faz parte do núcleo: o core não exporta nenhum tipo de relatório', async () => {
    const core = await import('@sift/core');
    expect(Object.keys(core).some((k) => /report/i.test(k))).toBe(false);
  });
});
