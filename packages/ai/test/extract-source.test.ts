import { describe, expect, it } from 'vitest';
import { validateChange, emptyState, type ChangeDraft, type ChangeId, type ProjectId } from '@sift/core';
import { sourceCreationOp } from '../src';
import { schema } from './extract-helpers';

const H = 'a'.repeat(64);
const draft = (op: ReturnType<typeof sourceCreationOp>): ChangeDraft => ({
  id: 'c1' as ChangeId, projectId: 'p1' as ProjectId, baseVersion: 0, schemaRef: { key: 'research', version: 1 },
  origin: { kind: 'human', actorId: 'u1' as never }, rationale: 'nova fonte', operations: [op], createdAt: '2026-10-18T10:00:00Z',
});
const problems = (op: ReturnType<typeof sourceCreationOp>) =>
  validateChange(schema, emptyState(), { ...draft(op), impact: 'low', basisKind: 'none' });

describe('criação de fonte: a origem é obrigatória nesta camada', () => {
  it('fonte humana com origem e capturedAt é válida no núcleo', () => {
    const op = sourceCreationOp({ id: 's1', label: 'nota', contentHash: H, originType: 'human', capturedAt: '2026-10-01T09:00:00+01:00' });
    expect(problems(op)).toEqual([]);
  });
  it('fonte de IA exige a execução que a trouxe', () => {
    expect(() => sourceCreationOp({ id: 's1', label: 'x', contentHash: H, originType: 'ai' })).toThrow();
    const op = sourceCreationOp({ id: 's1', label: 'x', contentHash: H, originType: 'ai', originLabel: 'modelo', originRunId: 'run-9' });
    expect(problems(op)).toEqual([]);
  });
  it('sem originType (ou com valor fora do enum) a camada recusa', () => {
    expect(() => sourceCreationOp({ id: 's1', label: 'x', contentHash: H } as never)).toThrow();
    expect(() => sourceCreationOp({ id: 's1', label: 'x', contentHash: H, originType: 'robo' } as never)).toThrow();
  });
  it('capturedAt inválido é recusado pelo núcleo (tipo datetime)', () => {
    const op = sourceCreationOp({ id: 's1', label: 'x', contentHash: H, originType: 'human', capturedAt: '2026-02-30T10:00:00Z' });
    expect(problems(op).map((i) => i.code)).toContain('invalid_attribute');
  });
});
