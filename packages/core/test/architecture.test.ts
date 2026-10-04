import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
// `testing/` é código de apoio a testes (livro-razão em memória), fora da superfície pura do core.
const prod = walk(SRC).filter((f) => !f.includes(`${sep}testing${sep}`));
const read = (f: string) => readFileSync(f, 'utf8');

describe('fronteiras do core', () => {
  it('existe código de produção para inspecionar', () => {
    expect(prod.length).toBeGreaterThan(5);
  });

  it('só importa módulos relativos, zod e @noble/hashes (sem node:*, banco, AI, UI)', () => {
    const bad: string[] = [];
    for (const f of prod) {
      const text = read(f);
      const staticImports = /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm;
      const sideEffect = /^\s*import\s+['"]([^'"]+)['"]/gm;
      const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (const re of [staticImports, sideEffect, dynamic]) {
        for (const m of text.matchAll(re)) {
          const spec = m[1]!;
          const ok = spec.startsWith('.') || spec === 'zod' || spec.startsWith('@noble/hashes/');
          if (!ok) bad.push(`${f}: ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('o core não depende de nenhum pacote do workspace: nunca importa @sift/ai (nem @sift/*)', () => {
    const bad: string[] = [];
    for (const f of prod) {
      const text = read(f);
      const specs = [
        ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm),
        ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((m) => m[1]!);
      for (const spec of specs) if (spec.startsWith('@sift/')) bad.push(`${f}: ${spec}`);
    }
    expect(bad).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(declared.filter((d) => d.startsWith('@sift/'))).toEqual([]);
  });

  it('não conhece nenhum domínio: nenhum literal de tipo de item/relação do research no core', () => {
    const re = /['"`](claim|assumption|question|decision|source|note|research|decisions|supports|challenges|supersedes|affects|raises)['"`]/;
    const bad = prod.filter((f) => re.test(read(f)));
    expect(bad).toEqual([]);
  });

  it('é determinístico: sem relógio, aleatoriedade, rede nem DOM direto', () => {
    const re = /\b(Date\.now|Math\.random|new Date\(|fetch\(|process\.|document\.|window\.|localStorage)/;
    const bad = prod.filter((f) => re.test(read(f)));
    expect(bad).toEqual([]);
  });
});
