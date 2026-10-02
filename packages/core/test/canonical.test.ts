import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, sha256Hex } from '../src';

describe('canonicalize', () => {
  it('ordena chaves e é estável', () => {
    expect(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
  it('omite undefined em objetos, rejeita fora deles e números não finitos', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalize([undefined])).toThrow();
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(new Map())).toThrow();
  });
  it('-0 vira 0', () => {
    expect(canonicalize(-0)).toBe('0');
  });
  it('independe da ordem de inserção das chaves (propriedade)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { maxLength: 5 }), (keys: string[]) => {
        const uniq = [...new Set(keys)];
        const o1: Record<string, number> = {};
        const o2: Record<string, number> = {};
        uniq.forEach((k, i) => (o1[k] = i));
        [...uniq].reverse().forEach((k) => (o2[k] = uniq.indexOf(k)));
        expect(canonicalize(o1)).toBe(canonicalize(o2));
      }),
    );
  });
});

describe('sha256Hex', () => {
  it('bate com vetores conhecidos', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
