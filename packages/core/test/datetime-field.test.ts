import { describe, expect, it } from 'vitest';
import { isIsoDateTime } from '../src';
import { createItem, draftOf, human } from '../src/testing';
import { newLedger } from './fixtures';

describe('tipo de campo datetime (ISO-8601 estrito, sem relógio)', () => {
  it('aceita Z, deslocamento, frações e dia bissexto', () => {
    for (const ok of [
      '2026-10-13T22:40:00Z', '2026-10-13T22:40:00.123Z', '2026-10-13T22:40:00+01:00',
      '2026-10-13T22:40:00-03:30', '2028-02-29T00:00:00Z', '2000-02-29T23:59:59Z', '2026-12-31T23:59:59.999999999Z',
    ]) expect(isIsoDateTime(ok), ok).toBe(true);
  });
  it('recusa formato frouxo, calendário impossível e horas fora de faixa', () => {
    for (const bad of [
      '', 'ontem', '2026-10-13', '2026-10-13 22:40:00Z', '2026-10-13T22:40:00', '2026-10-13T22:40Z',
      '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-02-29T00:00:00Z', '2100-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z', '2026-10-00T00:00:00Z', '2026-10-13T24:00:00Z', '2026-10-13T22:60:00Z',
      '2026-10-13T22:40:60Z', '2026-10-13T22:40:00+24:00', '2026-10-13T22:40:00+01:60', ' 2026-10-13T22:40:00Z',
    ]) expect(isIsoDateTime(bad), bad).toBe(false);
  });
  it('um campo datetime inválido é recusado na validação do change, com invalid_attribute', async () => {
    const l = newLedger();
    const mk = (capturedAt: string) => l.submitHuman(draftOf(l, {
      origin: human(),
      ops: [createItem({ id: 'd1', type: 'doc', status: 'live', contentHash: l.contents.add('corpo ' + capturedAt), attributes: { label: 'x', capturedAt } })],
    }));
    const bad = await mk('ontem');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues?.map((i) => i.code)).toContain('invalid_attribute');
    expect((await mk('2026-10-13T22:40:00Z')).ok).toBe(true);
  });
  it('o campo é opcional: a fonte sem capturedAt continua válida', async () => {
    const l = newLedger();
    const o = await l.submitHuman(draftOf(l, { origin: human(), ops: [createItem({ id: 'd1', type: 'doc', status: 'live', contentHash: l.contents.add('x y z'), attributes: { label: 'x' } })] }));
    expect(o.ok).toBe(true);
  });
});
