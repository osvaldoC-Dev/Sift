import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_KINDS, TEXT_KIND, validateChange, verifyEvidence,
  type ContentReader, type EvidenceRef, type FidelityReason, type Locator, type Operation, type SourceKind, type SourceKinds,
} from '../src';
import {
  InMemoryContents, InMemoryLedger, LINES_KIND, agent, createItem, draftOf, evidenceFor, fixedClock,
  linesEvidence, sequentialIds,
} from '../src/testing';
import type { ProjectId } from '../src';
import { neutralSchema } from './fixtures';

/**
 * SUÍTE DE CONTRATO de um tipo de fonte (SourceKind). Roda para o `text` (real) e para o `lines` (só de
 * teste), com o mesmo conjunto de exigências. Se um tipo novo (código, modelo 3D) não passar nela, ele não
 * cumpre o contrato.
 */

const LINES_TEXT = 'primeira linha\nsegunda linha\nterceira linha\nquarta linha';

interface KindCase {
  name: string;
  kinds: SourceKinds;
  contents: InMemoryContents;
  good: EvidenceRef;
  /** Aponta para fora do conteúdo. */
  outOfRange: EvidenceRef;
  /** Citação diferente do trecho. */
  wrongQuote: EvidenceRef;
  /** Localizador malformado e a razão esperada (cada tipo tem a sua forma de malformação). */
  malformed: EvidenceRef;
  malformedReason: FidelityReason;
  /** Citação curta demais. */
  tooShort: EvidenceRef;
  /** Evidência de OUTRO tipo, que este registro não conhece. */
  unregistered: EvidenceRef;
  /** `locate`: conteúdo com uma citação repetida, e os localizadores esperados (todas as ocorrências, em ordem). */
  locating: { content: string; quote: string; expected: Locator[] };
}

function textCase(): KindCase {
  const contents = new InMemoryContents();
  const good = evidenceFor(contents, LINES_TEXT, 'segunda linha');
  return {
    name: 'text', kinds: DEFAULT_SOURCE_KINDS, contents, good,
    outOfRange: { ...good, end: 9999 },
    wrongQuote: { ...good, quote: 'segunda lenha' },
    malformed: { ...good, start: 1.5 },
    malformedReason: 'out_of_range',
    tooShort: { ...good, quote: 'ab' },
    unregistered: { kind: 'lines', contentHash: good.contentHash, locator: { startLine: 1, endLine: 1 }, quote: 'primeira linha' },
    locating: {
      content: 'ab 😀 ab\ncafé ab',
      quote: 'ab',
      expected: [{ start: 0, end: 2 }, { start: 5, end: 7 }, { start: 13, end: 15 }],
    },
  };
}

function linesCase(): KindCase {
  const contents = new InMemoryContents();
  const good = linesEvidence(contents, LINES_TEXT, 2, 3);
  return {
    name: 'lines', kinds: new Map<string, SourceKind>([[TEXT_KIND.kind, TEXT_KIND], [LINES_KIND.kind, LINES_KIND]]),
    contents, good,
    outOfRange: { ...good, locator: { startLine: 3, endLine: 9 } },
    wrongQuote: { ...good, quote: 'segunda linha\nterceira lenha' },
    malformed: { ...good, locator: { startLine: 0, endLine: 2 } },
    malformedReason: 'locator_invalid',
    tooShort: { ...good, quote: 'ab' },
    unregistered: { kind: 'model3d', contentHash: good.contentHash, locator: { partId: 'wheel' } },
    locating: {
      content: 'um\ndois\num\ndois\ntres',
      quote: 'um\ndois',
      expected: [{ startLine: 1, endLine: 2 }, { startLine: 3, endLine: 4 }],
    },
  };
}

const op = (ev: EvidenceRef): Operation => createItem({ id: 'x', type: 't', status: 's', content: 'c', evidence: [ev] });
const reasons = async (c: KindCase, ev: EvidenceRef, reader: ContentReader = c.contents) =>
  (await verifyEvidence([op(ev)], reader, undefined, c.kinds)).map((f) => f.reason);

function newLedgerWith(kinds: SourceKinds): InMemoryLedger {
  return new InMemoryLedger({ schema: neutralSchema, projectId: 'p1' as ProjectId, clock: fixedClock(), ids: sequentialIds('c'), kinds });
}

for (const make of [textCase, linesCase]) {
  const name = make().name;
  describe(`contrato de fonte: kind ${name}`, () => {
    it('um trecho que existe verifica', async () => {
      const c = make();
      expect(await reasons(c, c.good)).toEqual([]);
    });
    it('fora do conteúdo: out_of_range', async () => {
      const c = make();
      expect(await reasons(c, c.outOfRange)).toEqual(['out_of_range']);
    });
    it('citação diferente do trecho: text_mismatch', async () => {
      const c = make();
      expect(await reasons(c, c.wrongQuote)).toEqual(['text_mismatch']);
    });
    it('localizador malformado', async () => {
      const c = make();
      expect(await reasons(c, c.malformed)).toEqual([c.malformedReason]);
    });
    it('citação curta demais: quote_length', async () => {
      const c = make();
      expect(await reasons(c, c.tooShort)).toEqual(['quote_length']);
    });
    it('snapshot ausente: content_missing', async () => {
      const c = make();
      expect(await reasons(c, { ...c.good, contentHash: 'f'.repeat(64) })).toEqual(['content_missing']);
    });
    it('o armazém devolve outro conteúdo: hash_mismatch (antes de qualquer recorte)', async () => {
      const c = make();
      const lying: ContentReader = { get: async () => 'conteudo trocado' };
      expect(await reasons(c, c.good, lying)).toEqual(['hash_mismatch']);
    });
    it('locate: todas as ocorrências, em ordem, e nada quando a citação não existe', () => {
      const c = make();
      const kind = c.kinds.get(name)!;
      expect(kind.locate(c.locating.content, c.locating.quote)).toEqual(c.locating.expected);
      expect(kind.locate(c.locating.content, 'inexistente zzz')).toEqual([]);
      expect(kind.locate(c.locating.content, '')).toEqual([]);
    });
    it('locate e verify concordam: tudo o que o locate acha, o verify aceita', async () => {
      const c = make();
      const kind = c.kinds.get(name)!;
      const contents = new InMemoryContents();
      const hash = contents.add(c.locating.content);
      const stored = (await contents.get(hash))!;
      for (const loc of kind.locate(stored, c.locating.quote)) {
        const ev = (name === 'text'
          ? { contentHash: hash, start: loc['start'], end: loc['end'], quote: c.locating.quote }
          : { kind: 'lines', contentHash: hash, locator: loc, quote: c.locating.quote }) as EvidenceRef;
        expect(await verifyEvidence([op(ev)], contents, { minQuote: 1, maxQuote: 2000 }, c.kinds)).toEqual([]);
      }
    });
    it('tipo que o registro não conhece: unknown_kind', async () => {
      const c = make();
      expect(await reasons(c, c.unregistered)).toEqual(['unknown_kind']);
    });
    it('a validação da proposta aceita a evidência boa e recusa a malformada', () => {
      const c = make();
      const l = newLedgerWith(c.kinds);
      const ok = draftOf(l, { origin: agent('r1'), ops: [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [c.good] })] });
      expect(validateChange(neutralSchema, l.state, { ...ok, impact: 'medium', basisKind: 'evidence' }, c.kinds).map((i) => i.code)).toEqual([]);
      const bad = draftOf(l, { origin: agent('r1'), ops: [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [{ ...c.good, contentHash: 'zz' } as EvidenceRef] })] });
      expect(validateChange(neutralSchema, l.state, { ...bad, impact: 'medium', basisKind: 'evidence' }, c.kinds).map((i) => i.code)).toContain('evidence_malformed');
    });
    it('a validação recusa a forma errada do PRÓPRIO tipo (checkShape), com o hash em ordem', () => {
      const c = make();
      const l = newLedgerWith(c.kinds);
      const change = { ...draftOf(l, { origin: agent('r1'), ops: [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [c.malformed] })] }), impact: 'medium' as const, basisKind: 'evidence' as const };
      expect(validateChange(neutralSchema, l.state, change, c.kinds).map((i) => i.code)).toContain('evidence_malformed');
    });
    it('ponta a ponta: o livro-razão propõe, e a evidência do tipo é verificada', async () => {
      const c = make();
      const l = newLedgerWith(c.kinds);
      const ev = name === 'text' ? evidenceFor(l.contents, LINES_TEXT, 'segunda linha') : linesEvidence(l.contents, LINES_TEXT, 2, 3);
      const o = await l.propose(draftOf(l, { origin: agent('r1'), ops: [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [ev] })] }));
      expect(o.ok).toBe(true);
    });
  });
}

describe('kind de fonte: regras do registro', () => {
  it("kind:'text' escrito explicitamente é recusado (duas formas canônicas da mesma evidência)", async () => {
    const c = textCase();
    const explicit = { ...c.good, kind: 'text' } as unknown as EvidenceRef;
    expect(await reasons(c, explicit)).toEqual(['unknown_kind']);
    const l = newLedgerWith(c.kinds);
    const change = { ...draftOf(l, { origin: agent('r1'), ops: [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [explicit] })] }), impact: 'medium' as const, basisKind: 'evidence' as const };
    const issues = validateChange(neutralSchema, l.state, change, c.kinds);
    expect(issues.map((i) => i.code)).toContain('evidence_malformed');
    expect(issues.some((i) => i.message.includes("kind 'text' explícito"))).toBe(true);
  });

  it('o registro padrão só conhece texto: evidência localizada é recusada na validação', () => {
    const c = linesCase();
    const l = newLedgerWith(DEFAULT_SOURCE_KINDS);
    const change = { ...draftOf(l, { origin: agent('r1'), ops: [createItem({ id: 'a1', type: 'alpha', status: 'draft', content: 'x', evidence: [c.good] })] }), impact: 'medium' as const, basisKind: 'evidence' as const };
    const issues = validateChange(neutralSchema, l.state, change);
    expect(issues.some((i) => i.code === 'evidence_malformed' && i.message.includes('kind de fonte desconhecido'))).toBe(true);
  });

  it('a evidência de texto continua SEM o campo kind na forma canônica', () => {
    const c = textCase();
    expect('kind' in c.good).toBe(false);
  });
});
