import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  contentHash, normalizeText, sliceCodePoints, verifyEvidence,
  type EvidenceRef, type Operation,
} from '../src';
import { InMemoryContents, createItem, evidenceFor } from '../src/testing';
import { TEXT } from './fixtures';

const opWith = (ev: EvidenceRef): Operation =>
  createItem({ id: 'x', type: 't', status: 's', content: 'c', evidence: [ev] });

describe('normalização e recorte', () => {
  it('remove BOM, unifica quebras de linha e aplica NFC', () => {
    expect(normalizeText('\uFEFFa\r\nb\rc')).toBe('a\nb\nc');
    expect(normalizeText('e\u0301')).toBe('é');
  });
  it('recorta por code points (emoji conta 1)', () => {
    expect(sliceCodePoints('a😀b', 1, 2)).toBe('😀');
    expect(sliceCodePoints('a😀b', 0, 3)).toBe('a😀b');
    expect(sliceCodePoints('abc', 2, 2)).toBeUndefined();
    expect(sliceCodePoints('abc', 0, 9)).toBeUndefined();
    expect(sliceCodePoints('abc', -1, 2)).toBeUndefined();
  });
  it('o hash é do texto normalizado', () => {
    expect(contentHash(normalizeText('e\u0301'))).toBe(contentHash('é'));
  });
});

describe('verifyEvidence', () => {
  it('aceita trechos exatos, inclusive com emoji e acento combinante', async () => {
    const c = new InMemoryContents();
    for (const q of ['ferve a 100 °C', '😀 Café com é', 'ao nível do mar']) {
      expect(await verifyEvidence([opWith(evidenceFor(c, TEXT, q))], c)).toHaveLength(0);
    }
  });
  it('reporta cada motivo de falha', async () => {
    const c = new InMemoryContents();
    const good = evidenceFor(c, TEXT, 'ferve a 100 °C');
    const reason = async (e: EvidenceRef) => (await verifyEvidence([opWith(e)], c))[0]?.reason;
    expect(await reason({ ...good, quote: 'ferve a 99 °C!!' })).toBe('text_mismatch');
    expect(await reason({ ...good, end: 9999 })).toBe('out_of_range');
    expect(await reason({ ...good, contentHash: 'f'.repeat(64) })).toBe('content_missing');
    expect(await reason({ ...good, quote: 'ab' })).toBe('quote_length');
  });
  it('qualquer recorte do texto verifica; alterar uma letra falha (propriedade)', async () => {
    const c = new InMemoryContents();
    const tokens = ['a', 'b', 'é', '😀', 'e\u0301', '\r\n', '\n', ' ', 'x'];
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...tokens), { minLength: 12, maxLength: 40 }),
        fc.nat(30),
        async (parts: string[], offset: number) => {
          const text = parts.join('');
          const normalized = normalizeText(text);
          const cps = Array.from(normalized);
          if (cps.length < 7) return;
          const start = offset % (cps.length - 6);
          const end = start + 6;
          const quote = cps.slice(start, end).join('');
          const hash = c.add(text);
          const ref: EvidenceRef = { contentHash: hash, start, end, quote };
          expect(await verifyEvidence([opWith(ref)], c)).toHaveLength(0);
          const mutated = { ...ref, quote: quote.slice(0, -1) + (quote.endsWith('Z') ? 'Y' : 'Z') };
          expect((await verifyEvidence([opWith(mutated)], c)).length).toBeGreaterThan(0);
        },
      ),
    );
  });
});
