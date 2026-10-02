import { sha256 } from '@noble/hashes/sha2.js';
import type { Hash } from './types';

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

export function sha256Hex(text: string): Hash {
  return toHex(sha256(new TextEncoder().encode(text)));
}

/**
 * JSON canônico: chaves ordenadas, sem espaços. Propriedades `undefined` em objetos são omitidas
 * (como em JSON.stringify). Rejeita undefined fora de objeto, números não finitos, Map/Set/Date etc.
 * Congelada: qualquer mudança aqui invalida hashes já gravados.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalize: número não finito');
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('canonicalize: apenas objetos simples');
      }
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined) continue;
        parts.push(JSON.stringify(key) + ':' + canonicalize(v));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new TypeError(`canonicalize: tipo não suportado (${typeof value})`);
  }
}
