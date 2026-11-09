import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
// caminhos sempre com '/', também no Windows (relative() devolve '\\' lá)
const src = (pkg: string) =>
  files(join(ROOT, pkg, 'src')).map((p) => ({ path: relative(ROOT, p).split('\\').join('/'), code: strip(readFileSync(p, 'utf8')) }));
const importsOf = (code: string) => [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);

describe('fronteiras da API', () => {
  const api = src('api');

  it('api/src importa só core, schemas, ai, contract, node:http e arquivos próprios', () => {
    const ok = /^(\.{1,2}\/|@sift\/(core|core\/testing|schemas|ai|contract)$|node:http$)/;
    for (const f of api) for (const i of importsOf(f.code)) expect(ok.test(i), `${f.path} importa ${i}`).toBe(true);
  });

  it('só o armazém em memória toca @sift/core/testing; o resto só fala com a interface Store', () => {
    for (const f of api) {
      const touches = importsOf(f.code).includes('@sift/core/testing') && !f.path.endsWith('memory-store.ts') && !f.path.endsWith('store.ts');
      expect(touches, f.path).toBe(false);
    }
    const store = api.find((f) => f.path.endsWith('/store.ts'))!;
    expect(store.code).not.toMatch(/\bInMemoryLedger\b/); // a interface só importa TIPOS (Outcome, ReviewInput)
    expect(store.code).toMatch(/import type \{ Outcome, ReviewInput \} from '@sift\/core\/testing'/);
  });

  it('a API não escreve no livro por conta própria: nada de sealEntry/appendEntry/InMemoryLedger fora do armazém', () => {
    for (const f of api.filter((x) => !x.path.endsWith('memory-store.ts'))) {
      expect(f.code, f.path).not.toMatch(/\b(sealEntry|appendEntry|InMemoryLedger|GENESIS_HASH)\b/);
    }
  });

  it('sem relógio, aleatoriedade nem console em src: tudo entra por injeção', () => {
    for (const f of api) {
      expect(f.code, f.path).not.toMatch(/Date\.now|new Date\(|Math\.random|randomUUID|console\./);
    }
  });

  it('a API não recalcula verificação nem elegibilidade com lógica própria de busca', () => {
    for (const f of api) {
      expect(f.code, f.path).not.toMatch(/\b(text|content|quote|source|ev\.quote)\.(indexOf|includes|search|match|matchAll|lastIndexOf)\(/);
    }
  });

  it('nenhum outro pacote depende de @sift/api, e o contrato só importa zod', () => {
    for (const pkg of ['core', 'schemas', 'ai', 'contract']) {
      for (const f of src(pkg)) expect(importsOf(f.code).some((i) => i.startsWith('@sift/api')), f.path).toBe(false);
    }
    for (const f of src('contract')) {
      for (const i of importsOf(f.code)) expect(/^(\.{1,2}\/|zod$)/.test(i), `${f.path} importa ${i}`).toBe(true);
    }
  });
});
