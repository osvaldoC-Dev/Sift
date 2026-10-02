import { assertProjectSchema, type ProjectId } from '../src';
import {
  InMemoryLedger, draftOf, evidenceFor, fixedClock, human, sequentialIds,
} from '../src/testing';
import type { Operation } from '../src';

/** Schema neutro (sem vocabulário de domínio) que reproduz a estrutura de regras do research. */
export const neutralSchemaJson = {
  key: 'neutral',
  version: 1,
  itemTypes: {
    alpha: {
      statuses: ['draft', 'final'], provisionalStatus: 'draft', body: 'inline', impact: 'medium',
      creation: { agent: ['draft', 'final'], human: ['final'] },
      basis: { agent: { evidenceMin: 1 } },
      promotion: { basis: { any: { evidenceMin: 1, orJustification: true, countsExisting: true } } },
    },
    beta: {
      statuses: ['draft', 'final'], provisionalStatus: 'draft', body: 'inline', impact: 'high',
      creation: { agent: ['draft'], human: ['final'] },
      basis: { agent: { evidenceMin: 1, orJustification: true } },
      promotion: { basis: { any: { evidenceMin: 1, orJustification: true, countsExisting: true } } },
    },
    gamma: {
      statuses: ['open', 'closed'], body: 'inline', impact: 'low',
      creation: { agent: ['open'], human: ['open'] },
    },
    doc: {
      statuses: ['live'], body: 'content', impact: 'low',
      creation: { agent: [], human: ['live'] },
      fields: { label: { type: 'string', required: true } },
    },
  },
  transitions: [
    { type: 'alpha', from: 'draft', to: 'final', requires: 'explicit' },
    { type: 'beta', from: 'draft', to: 'final', requires: 'explicit' },
  ],
  relationTypes: {
    backs: {
      from: ['alpha'], to: ['alpha', 'beta'], impact: 'medium',
      basis: { agent: { evidenceMin: 1 } },
    },
    opposes: {
      from: ['alpha'], to: ['alpha', 'beta'], impact: 'high',
      basis: { agent: { evidenceMin: 1 } },
      fields: { why: { type: 'text', required: true } },
    },
    asks: {
      from: ['alpha', 'beta'], to: ['gamma'], impact: 'low',
      basis: { agent: { evidenceMin: 1, orJustification: true } },
    },
    replaces: {
      sameType: true, impact: 'high',
      basis: { agent: { evidenceMin: 1, orJustification: true, basedOnMustInclude: ['from', 'to'] } },
    },
  },
  review: { batchEligibleImpact: ['low'], maxChangesPerSet: 10 },
  migrations: [],
};

export const neutralSchema = assertProjectSchema(neutralSchemaJson);

export const TEXT = 'A água ferve a 100 °C ao nível do mar. 😀 Café com e\u0301 combinante.';

export function newLedger(): InMemoryLedger {
  return new InMemoryLedger({
    schema: neutralSchema,
    projectId: 'p1' as ProjectId,
    clock: fixedClock(),
    ids: sequentialIds('c'),
  });
}

export const ev = (l: InMemoryLedger, quote: string) => evidenceFor(l.contents, TEXT, quote);

/** Mudança humana com as operações dadas. */
export function h(l: InMemoryLedger, ...ops: Operation[]) {
  return l.submitHuman(draftOf(l, { origin: human(), ops }));
}
