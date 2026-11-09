import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, canonicalize, contentHash, normalizeText, verifyChain, verifyEvidence } from '../src';
import { agent, createItem, draftOf, evidenceFor, type InMemoryLedger } from '../src/testing';
import { TEXT, newLedger } from './fixtures';

/**
 * TESTE DOURADO (Marco 3.2, antes de qualquer mudança no contrato de evidência).
 *
 * As constantes abaixo foram capturadas do código do Marco 3.1.1, SEM nenhuma alteração do núcleo. Elas provam
 * que a forma canônica de uma evidência de TEXTO (e, portanto, os hashes de eventos já gravados) não muda
 * quando o contrato de fonte for generalizado. Se este teste falhar depois de um refactor, o refactor mudou
 * a forma canônica: corrija o código, NÃO as constantes.
 *
 * O cenário cobre: evidência sem veredito, com veredito (full, partial), edição humana que rebaixa o veredito
 * para 'unchecked', trecho depois de um caractere fora do BMP (😀, 2 unidades UTF-16, 1 code point) e acento
 * combinante (e + U+0301, que a normalização NFC compõe em "é").
 */

const QUOTE_BMP_PLUS_ACCENT = '😀 Café com é combinante.';
const QUOTE_PLAIN = 'ferve a 100 °C ao nível do mar';
const QUOTE_PARTIAL = 'A água ferve';

async function buildGoldenLedger(): Promise<InMemoryLedger> {
  const l = newLedger();
  // 1) humano cria a fonte (corpo content, hash do texto normalizado)
  await l.submitHuman(draftOf(l, {
    origin: { kind: 'human', actorId: 'u1' as never },
    ops: [createItem({ id: 'd1', type: 'doc', status: 'live', contentHash: l.contents.add(TEXT), attributes: { label: 'fonte' } })],
  }));
  const U = { kind: 'human', id: 'u1' as never } as const;
  const alpha = (id: string, content: string, evidence: ReturnType<typeof evidenceFor>[]) =>
    createItem({ id, type: 'alpha', status: 'draft', content, evidence });
  // 2) agente propõe; o humano aceita (evidência sem veredito e com 'partial')
  const p1 = await l.propose(draftOf(l, {
    origin: agent('run1'),
    ops: [
      alpha('a1', 'agua ferve', [evidenceFor(l.contents, TEXT, QUOTE_PLAIN, undefined)]),
      alpha('a3', 'agua ferve parcial', [evidenceFor(l.contents, TEXT, QUOTE_PARTIAL, 'partial')]),
    ],
  }));
  if (!p1.ok || p1.applied) throw new Error('pendente esperado');
  await l.review({ changeId: p1.change!.id, decision: 'accept', reviewer: U });
  // 3) agente propõe com 'full' (emoji + acento combinante); o humano edita o conteúdo: o veredito vira 'unchecked'
  const full = evidenceFor(l.contents, TEXT, QUOTE_BMP_PLUS_ACCENT, 'full');
  const p2 = await l.propose(draftOf(l, { origin: agent('run2'), ops: [alpha('a2', 'cafe', [full])] }));
  if (!p2.ok || p2.applied) throw new Error('pendente esperado');
  await l.review({
    changeId: p2.change!.id, decision: 'accept_edited', reviewer: U,
    editedOperations: [alpha('a2', 'cafe com acento', [full])],
  });
  return l;
}

const GOLDEN = {
  textHash: '33547dbc10de52b8d5900bfc41ffe5fe3e3c5f9bc5d0112671d729984de50649',
  evidenceCanonical:
    '{"contentHash":"33547dbc10de52b8d5900bfc41ffe5fe3e3c5f9bc5d0112671d729984de50649","end":63,"quote":"😀 Café com é combinante.","start":39,"supportVerdict":"full"}',
  entryHashes: [
    '784f80706b24998f5c42b85816e6d03e1ec3b054838a81604f07ebfce4545f4a',
    '23e12f3f20dc9bdbee0357b10c27bca0590955a4771027e0f81bb5df5eb9e701',
    '919edc555c6f41e1101a1b1a6e19618594c7870c8e705e05754ac56a3699e3df',
  ],
};

describe('teste dourado: hashes de eventos com evidência de texto', () => {
  it('o hash do texto normalizado (NFC) é o de sempre', () => {
    expect(contentHash(normalizeText(TEXT))).toBe(GOLDEN.textHash);
  });

  it('a forma canônica de uma evidência de texto não mudou (offsets em code points, depois do emoji e do acento)', async () => {
    const l = await buildGoldenLedger();
    const ref = evidenceFor(l.contents, TEXT, QUOTE_BMP_PLUS_ACCENT, 'full');
    expect(canonicalize(ref)).toBe(GOLDEN.evidenceCanonical);
    // code points, não unidades UTF-16: o trecho citado, recortado por code points, é a própria citação
    expect(Array.from(normalizeText(TEXT)).slice(ref.start, ref.end).join('')).toBe(ref.quote);
    expect(ref.end).toBe(63); // em UTF-16 seria 64
    expect(ref.quote).toContain('é'); // composto (NFC), não e + U+0301
    expect(ref.quote).not.toContain('\u0301');
  });

  it('a evidência sem veredito não tem a chave supportVerdict (nem null)', async () => {
    const l = await buildGoldenLedger();
    const ref = evidenceFor(l.contents, TEXT, QUOTE_PLAIN, undefined);
    expect(Object.keys(ref).sort()).toEqual(['contentHash', 'end', 'quote', 'start']);
    expect(canonicalize(ref)).not.toContain('supportVerdict');
  });

  it('a cadeia de hashes do cenário é exatamente a gravada', async () => {
    const l = await buildGoldenLedger();
    expect(l.log.map((e) => e.entryHash)).toEqual(GOLDEN.entryHashes);
    expect(l.log[0]!.prevHash).toBe(GENESIS_HASH);
    expect(verifyChain(l.log)).toEqual({ ok: true });
  });

  it('o veredito aparece onde deve: ausente, partial, e unchecked depois da edição humana', async () => {
    const l = await buildGoldenLedger();
    const verdicts = l.log.map((e) => e.appliedOperations.map((o) => o.evidence.map((x) => x.supportVerdict ?? null)));
    expect(verdicts).toEqual([[[]], [[null], ['partial']], [['unchecked']]]);
  });

  it('os fixtures antigos continuam verificando contra o armazém (nada de evidência que deixou de valer)', async () => {
    const l = await buildGoldenLedger();
    for (const entry of l.log) {
      expect(await verifyEvidence([...entry.appliedOperations], l)).toEqual([]);
    }
  });
});

/**
 * SEGUNDO CENÁRIO DOURADO (3.2b): texto escrito só com escapes \u (nenhum caractere especial no arquivo, para
 * que editor ou codificação não alterem o teste), com um trecho que COMEÇA DEPOIS de dois emojis (cada um =
 * 2 unidades UTF-16 e 1 code point) e um "e + U+0301" que a normalização compõe em "é". As constantes foram
 * calculadas por fora (Python: NFC + sha256 + JSON canônico), não pelo código sob teste.
 */
describe('teste dourado 2: escapes \\u e citação depois do emoji', () => {
  const RAW =
    'Linha um com água.\n\u{1F600}\u{1F600} Depois do emoji vem a citação.\nFim com é.';
  const QUOTE = 'Depois do emoji vem a citação.';
  const G2 = {
    textHash: '24a6cc879363752222288f578c7c708455d40c564fd68d4f65380a1fb9269dae',
    start: 22, // code points; em unidades UTF-16 seria 24
    end: 52,
    codePoints: 63,
    evidenceCanonical:
      '{"contentHash":"24a6cc879363752222288f578c7c708455d40c564fd68d4f65380a1fb9269dae","end":52,"quote":"Depois do emoji vem a citação.","start":22}',
  };

  it('a normalização compõe o acento e o hash bate com o calculado por fora', () => {
    const text = normalizeText(RAW);
    expect(text).not.toBe(RAW);
    expect(text.endsWith('Fim com é.')).toBe(true);
    expect(Array.from(text)).toHaveLength(G2.codePoints);
    expect(contentHash(text)).toBe(G2.textHash);
  });

  it('o trecho depois do emoji começa em 22 code points (e não em 24 unidades UTF-16)', () => {
    const text = normalizeText(RAW);
    expect(Array.from(text).slice(0, G2.start).join('').length).toBe(24);
    expect(Array.from(text).slice(G2.start, G2.end).join('')).toBe(QUOTE);
    expect(text.indexOf(QUOTE)).toBe(24);
  });

  it('a forma canônica da evidência é a gravada nas constantes', () => {
    const ev = { contentHash: G2.textHash, start: G2.start, end: G2.end, quote: QUOTE };
    expect(canonicalize(ev)).toBe(G2.evidenceCanonical);
    expect(canonicalize({ ...ev, supportVerdict: 'full' })).toBe(G2.evidenceCanonical.replace('"quote"', '"quote"').replace('"start":22}', '"start":22,"supportVerdict":"full"}'));
  });

  it('o núcleo verifica essa evidência contra o texto normalizado e recusa o deslocamento em UTF-16', async () => {
    const text = normalizeText(RAW);
    const reader = { get: async (h: string) => (h === G2.textHash ? text : undefined) };
    const mk = (start: number, end: number) => [createItem({
      id: 'x', type: 'alpha', status: 'draft', content: 'c',
      evidence: [{ contentHash: G2.textHash, start, end, quote: QUOTE }],
    })];
    expect(await verifyEvidence(mk(G2.start, G2.end), reader)).toEqual([]);
    const utf16 = await verifyEvidence(mk(24, 54), reader);
    expect(utf16.map((f) => f.reason)).toEqual(['text_mismatch']);
  });
});
