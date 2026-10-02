import { describe, expect, it } from 'vitest';
import { assertProjectSchema, parseProjectSchema } from '../src';
import { neutralSchemaJson } from './fixtures';

const clone = () => JSON.parse(JSON.stringify(neutralSchemaJson));
const paths = (input: unknown): string[] => {
  const r = parseProjectSchema(input);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};

describe('Project Schema', () => {
  it('aceita o schema neutro', () => {
    expect(parseProjectSchema(neutralSchemaJson).ok).toBe(true);
  });
  it('rejeita algo que não é objeto', () => {
    expect(parseProjectSchema(42).ok).toBe(false);
    expect(() => assertProjectSchema(null)).toThrow();
  });
  it('exige que provisionalStatus esteja nos statuses', () => {
    const s = clone();
    s.itemTypes.alpha.provisionalStatus = 'nope';
    expect(paths(s).some((m) => m.includes('provisionalStatus'))).toBe(true);
  });
  it('exige transição explícita para toda saída do status provisório', () => {
    const s = clone();
    s.transitions = s.transitions.filter((t: { type: string }) => t.type !== 'alpha');
    expect(paths(s).some((m) => m.includes('transitions'))).toBe(true);
  });
  it('rejeita relação com tipo de item desconhecido e sameType junto com from/to', () => {
    const a = clone();
    a.relationTypes.backs.to = ['alpha', 'zeta'];
    expect(paths(a).some((m) => m.includes('zeta'))).toBe(true);
    const b = clone();
    b.relationTypes.replaces.from = ['alpha'];
    expect(paths(b).some((m) => m.includes('sameType'))).toBe(true);
  });
  it('basedOnMustInclude só vale em relações', () => {
    const s = clone();
    s.itemTypes.beta.basis.agent.basedOnMustInclude = ['from'];
    expect(paths(s).some((m) => m.includes('basedOnMustInclude'))).toBe(true);
  });
  it('campo enum exige values', () => {
    const s = clone();
    s.itemTypes.doc.fields.kind = { type: 'enum' };
    expect(paths(s).some((m) => m.includes('enum'))).toBe(true);
  });
});
