import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  analyzeChange, canonicalize, isBatchEligible, sha256Hex,
  type ChangeId, type Operation, type Origin, type SupportVerdict, type UserId,
} from '../src';
import {
  agent, createItem, createRelation, draftOf, evidenceFor, human, iid,
  type InMemoryLedger, type Outcome,
} from '../src/testing';
import { TEXT, h, neutralSchema, newLedger } from './fixtures';

const U = { kind: 'human', id: 'u1' as UserId } as const;
const QUOTE = 'ferve a 100 °C';
type V = SupportVerdict | undefined;

const evV = (l: InMemoryLedger, v: V) => evidenceFor(l.contents, TEXT, QUOTE, v);
const codeOf = (o: Outcome) => (o.ok ? 'ok' : o.code);
const decisionCodes = (o: Outcome) => (o.ok ? [] : (o.decisionIssues ?? []).map((d) => d.code));
const issueCodes = (o: Outcome) => (o.ok ? [] : (o.issues ?? []).map((d) => d.code));

function pend(o: Outcome): ChangeId {
  if (!o.ok || o.applied) throw new Error('esperava proposta pendente: ' + JSON.stringify(o));
  return o.change!.id;
}
const propose = (l: InMemoryLedger, ops: Operation[], run = 'run1') =>
  l.propose(draftOf(l, { origin: agent(run), ops }));

/** Change de agente que cria um alpha provisório sustentado pelas evidências dadas. */
const alphaOps = (l: InMemoryLedger, vs: V[], id = 'a2'): Operation[] => [
  createItem({ id, type: 'alpha', status: 'draft', content: 'água ferve', evidence: vs.map((v) => evV(l, v)) }),
];
/** Change de impacto baixo: pergunta + relação `asks` com evidência (elegível a lote se o suporte for full). */
const batchOps = (l: InMemoryLedger, vs: V[], id = 'g1'): Operation[] => [
  createItem({ id, type: 'gamma', status: 'open', content: 'e a altitude?' }),
  createRelation({ id: `rel-${id}`, type: 'asks', from: 'a1', to: id, evidence: vs.map((v) => evV(l, v)) }),
];
async function seeded(): Promise<InMemoryLedger> {
  const l = newLedger();
  await h(l, createItem({ id: 'a1', type: 'alpha', status: 'final', content: 'base do usuário' }));
  return l;
}

describe('origem de agente com proveniência completa', () => {
  it('model, promptVersion e params chegam ao item e à entrada do log', async () => {
    const l = await seeded();
    const origin = agent('run7', { model: 'model-x', promptVersion: 'extract@3', params: { temperature: 0.2, seed: 7 } });
    const id = pend(await l.propose(draftOf(l, { origin, ops: alphaOps(l, ['full']) })));
    expect((await l.review({ changeId: id, decision: 'accept', reviewer: U })).ok).toBe(true);
    const expected = { kind: 'agent', runId: 'run7', model: 'model-x', promptVersion: 'extract@3', params: { temperature: 0.2, seed: 7 } };
    expect(l.log.at(-1)!.origin).toEqual(expected);
    expect(l.state.items.get(iid('a2'))!.origin).toEqual(expected);
  });

  it('proveniência incompleta (runId, model ou promptVersion vazios) é recusada', async () => {
    const l = await seeded();
    const before = l.changes.size;
    for (const bad of [
      { origin: agent('run1', { model: '' }), falta: 'model' },
      { origin: agent('run1', { promptVersion: '  ' }), falta: 'promptVersion' },
      { origin: agent(''), falta: 'runId' },
    ]) {
      const o = await l.propose(draftOf(l, { origin: bad.origin, ops: alphaOps(l, ['full']) }));
      expect(codeOf(o)).toBe('invalid');
      expect(issueCodes(o)).toContain('agent_provenance_incomplete');
      if (!o.ok) expect(o.issues!.find((i) => i.code === 'agent_provenance_incomplete')!.message).toContain(bad.falta);
    }
    expect(l.changes.size).toBe(before);
  });

  it('a proveniência faz parte do hash do log; sem mudar nada, o hash é determinístico', async () => {
    const run = async (promptVersion: string) => {
      const l = await seeded();
      const id = pend(await l.propose(draftOf(l, { origin: agent('run1', { promptVersion }), ops: alphaOps(l, ['full']) })));
      await l.review({ changeId: id, decision: 'accept', reviewer: U });
      return l.log.at(-1)!.entryHash;
    };
    expect(await run('extract@1')).toBe(await run('extract@1'));
    expect(await run('extract@1')).not.toBe(await run('extract@2'));
  });

  it('o builder agent() sem argumentos continua válido (compatibilidade)', () => {
    expect(agent()).toEqual({ kind: 'agent', runId: 'run1', model: 'test-model', promptVersion: 'test-prompt@0', params: {} });
  });
});

describe('supportVerdict: onde mora e o que muda na forma canônica', () => {
  it('é campo opcional DENTRO da evidência: sem veredito, a forma canônica (e o hash) é a de antes', () => {
    const l = newLedger();
    const sem = evV(l, undefined);
    expect('supportVerdict' in sem).toBe(false);
    expect(canonicalize(sem)).toBe(canonicalize({ contentHash: sem.contentHash, start: sem.start, end: sem.end, quote: sem.quote }));
    const full = evV(l, 'full');
    expect(canonicalize(full)).toContain('"supportVerdict":"full"');
    expect(sha256Hex(canonicalize(full))).not.toBe(sha256Hex(canonicalize(sem)));
  });
});

describe('supportVerdict na validação', () => {
  const analyze = (l: InMemoryLedger, ops: Operation[], origin: Origin = agent()) =>
    analyzeChange(neutralSchema, l.state, { ...draftOf(l, { origin, ops }), impact: 'low', basisKind: 'none' });

  it("'none' é recusado para agente, apontando a operação, e a proposta nem chega ao livro", async () => {
    const l = await seeded();
    const ops = [
      ...alphaOps(l, ['full'], 'a2'),
      createItem({ id: 'a3', type: 'alpha', status: 'draft', content: 'x', evidence: [evV(l, 'none')] }),
    ];
    const a = analyze(l, ops);
    const issue = a.issues.find((i) => i.code === 'support_none');
    expect(issue?.opIndex).toBe(1);
    expect(issue?.message).toContain('não sustenta');
    const before = l.changes.size;
    const o = await propose(l, ops);
    expect(codeOf(o)).toBe('invalid');
    expect(issueCodes(o)).toContain('support_none');
    expect(l.changes.size).toBe(before);
  });

  it('full, partial, unchecked e ausente são aceitos na validação (a restrição é na decisão)', () => {
    const l = newLedger();
    for (const v of ['full', 'partial', 'unchecked', undefined] as V[]) {
      expect(analyze(l, alphaOps(l, [v])).issues).toHaveLength(0);
    }
  });

  it('veredito fora do conjunto é evidência malformada', () => {
    const l = newLedger();
    const bad = { ...evV(l, 'full'), supportVerdict: 'maybe' } as unknown as ReturnType<typeof evV>;
    const a = analyze(l, [createItem({ id: 'a2', type: 'alpha', status: 'draft', content: 'x', evidence: [bad] })]);
    expect(a.issues.map((i) => i.code)).toContain('evidence_malformed');
  });

  it('origem humana não usa veredito: sem veredito é válida; com veredito é recusada', async () => {
    const l = await seeded();
    const plain = createItem({ id: 'h1', type: 'alpha', status: 'final', content: 'minha afirmação', evidence: [evV(l, undefined)] });
    expect(analyze(l, [plain], human()).issues).toHaveLength(0);
    expect(codeOf(await h(l, plain))).toBe('ok');
    const withVerdict = createItem({ id: 'h2', type: 'alpha', status: 'final', content: 'outra', evidence: [evV(l, 'full')] });
    expect(analyze(l, [withVerdict], human()).issues.map((i) => i.code)).toContain('support_verdict_on_human');
    expect(codeOf(await h(l, withVerdict))).toBe('invalid');
  });

  it('weakEvidence conta partial, unchecked e ausente; é zero para humano e para full', () => {
    const l = newLedger();
    expect(analyze(l, alphaOps(l, ['full', 'partial', 'unchecked', undefined])).weakEvidence).toBe(3);
    expect(analyze(l, alphaOps(l, ['full', 'full'])).weakEvidence).toBe(0);
    expect(analyze(l, alphaOps(l, [undefined]), human()).weakEvidence).toBe(0);
  });
});

describe('regras de decisão com o suporte da evidência', () => {
  it('accept_provisional: só com tudo full; partial, unchecked e sem veredito dão support_not_full', async () => {
    for (const v of ['partial', 'unchecked', undefined] as V[]) {
      const l = await seeded();
      const id = pend(await propose(l, alphaOps(l, [v])));
      const o = await l.review({ changeId: id, decision: 'accept_provisional', reviewer: U });
      expect(codeOf(o)).toBe('decision_not_allowed');
      expect(decisionCodes(o)).toEqual(['support_not_full']);
      if (!o.ok) expect(o.decisionIssues![0]!.message).toContain('revisão individual');
      expect(l.log).toHaveLength(1);
    }
    const l = await seeded();
    const id = pend(await propose(l, alphaOps(l, ['full'])));
    expect(codeOf(await l.review({ changeId: id, decision: 'accept_provisional', reviewer: U }))).toBe('ok');
  });

  it('uma evidência fraca no meio de várias fortes basta para recusar', async () => {
    const l = await seeded();
    const id = pend(await propose(l, alphaOps(l, ['full', 'full', 'partial', 'full'])));
    expect(decisionCodes(await l.review({ changeId: id, decision: 'accept_provisional', reviewer: U }))).toEqual(['support_not_full']);
  });

  it('lote: só com tudo full; suporte fraco dá support_not_full (e só ele, se o resto está certo)', async () => {
    for (const v of ['partial', 'unchecked', undefined] as V[]) {
      const l = await seeded();
      const id = pend(await propose(l, batchOps(l, [v])));
      const o = await l.review({ changeId: id, decision: 'accept', reviewer: U, batch: true });
      expect(codeOf(o)).toBe('decision_not_allowed');
      expect(decisionCodes(o)).toEqual(['support_not_full']);
    }
    const l = await seeded();
    const id = pend(await propose(l, batchOps(l, ['full'])));
    expect(codeOf(await l.review({ changeId: id, decision: 'accept', reviewer: U, batch: true }))).toBe('ok');
  });

  it('suporte fraco E estrutura inelegível ao lote dão os dois códigos', async () => {
    const l = await seeded();
    await h(l, createItem({ id: 'b1', type: 'beta', status: 'final', content: 'premissa' }));
    const ops: Operation[] = [
      createItem({ id: 'a9', type: 'alpha', status: 'final', content: 'achado', evidence: [evV(l, 'partial')] }),
      createRelation({ id: 'x9', type: 'opposes', from: 'a9', to: 'b1', attributes: { why: 'z' }, evidence: [evV(l, 'partial')] }),
    ];
    const id = pend(await propose(l, ops));
    const o = await l.review({ changeId: id, decision: 'accept', reviewer: U, batch: true });
    expect(decisionCodes(o).sort()).toEqual(['batch_not_eligible', 'support_not_full']);
  });

  it('revisão individual continua permitida com suporte fraco (accept e accept_edited)', async () => {
    const l = await seeded();
    const id = pend(await propose(l, alphaOps(l, ['partial'])));
    expect(codeOf(await l.review({ changeId: id, decision: 'accept', reviewer: U }))).toBe('ok');

    const l2 = await seeded();
    const id2 = pend(await propose(l2, alphaOps(l2, ['unchecked'])));
    const edited = alphaOps(l2, ['unchecked']);
    const o = await l2.review({ changeId: id2, decision: 'accept_edited', reviewer: U, editedOperations: edited });
    expect(codeOf(o)).toBe('ok');
  });

  it('sem nenhuma evidência (ex.: pergunta sem basis) o suporte não é exigido: comportamento anterior preservado', async () => {
    const l = await seeded();
    const id = pend(await propose(l, [createItem({ id: 'g2', type: 'gamma', status: 'open', content: 'pergunta' })]));
    expect(codeOf(await l.review({ changeId: id, decision: 'accept_provisional', reviewer: U }))).toBe('ok');
  });

  it('isBatchEligible devolve falso quando há evidência fraca', async () => {
    const l = await seeded();
    const mk = (vs: V[]) => {
      const draft = draftOf(l, { origin: agent(), ops: batchOps(l, vs) });
      const analysis = analyzeChange(neutralSchema, l.state, { ...draft, impact: 'low', basisKind: 'none' });
      return isBatchEligible(neutralSchema, draft, analysis);
    };
    expect(mk(['full'])).toBe(true);
    expect(mk(['full', 'partial'])).toBe(false);
    expect(mk([undefined])).toBe(false);
  });
});

describe('propriedade: suporte que não é full nunca passa por revisão leve nem por lote', () => {
  const verdictArb = fc.constantFrom<V>('full', 'partial', 'none', 'unchecked', undefined);

  it('para qualquer combinação de vereditos, accept_provisional e lote só aceitam tudo full; none nem é proposto', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(verdictArb, { minLength: 1, maxLength: 4 }),
        fc.constantFrom('provisional', 'batch'),
        async (vs: V[], mode: string) => {
          const l = await seeded();
          const hasNone = vs.includes('none');
          const allFull = vs.every((v) => v === 'full');
          const proposed = await propose(l, mode === 'provisional' ? alphaOps(l, vs) : batchOps(l, vs));

          if (hasNone) {
            expect(codeOf(proposed)).toBe('invalid');
            expect(issueCodes(proposed)).toContain('support_none');
            expect(l.changes.size).toBe(1); // só o change humano da semente; a proposta não entrou
            return;
          }
          const id = pend(proposed);
          const before = l.log.length;
          const o = await l.review(
            mode === 'provisional'
              ? { changeId: id, decision: 'accept_provisional', reviewer: U }
              : { changeId: id, decision: 'accept', reviewer: U, batch: true },
          );
          if (allFull) {
            expect(codeOf(o)).toBe('ok');
            const applied = l.log.at(-1)!.appliedOperations;
            expect(applied.flatMap((op) => op.evidence).every((e) => e.supportVerdict === 'full')).toBe(true);
          } else {
            expect(codeOf(o)).toBe('decision_not_allowed');
            expect(decisionCodes(o)).toContain('support_not_full');
            expect(l.log.length).toBe(before);
            expect(l.statusOf(id)).toBe('proposed');
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
