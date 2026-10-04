import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const AI_SRC = join(HERE, '..', 'src');
const PACKAGES = join(HERE, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const read = (f: string) => readFileSync(f, 'utf8');

/** Especificadores de módulo (import estático, side-effect, dinâmico) de um texto TypeScript. */
export function importSpecs(text: string): string[] {
  const res = [
    /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return res.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]!));
}

/** Regras de ai/src (fora de adapters/): só relativo, @sift/core, @sift/schemas; sem rede, FS ou relógio. */
export function violations(text: string): string[] {
  const out: string[] = [];
  for (const spec of importSpecs(text)) {
    const ok = spec.startsWith('.') || spec === '@sift/core' || spec === '@sift/schemas';
    if (!ok) out.push(`import proibido: ${spec}`);
  }
  const globals = /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|process\.|Date\.now|Math\.random|new Date\()/;
  const m = globals.exec(text);
  if (m) out.push(`uso proibido: ${m[1]}`);
  return out;
}

const ADAPTERS = `${sep}adapters${sep}`;
const aiSrc = walk(AI_SRC).filter((f) => !f.includes(ADAPTERS));

describe('fronteiras do pacote ai', () => {
  it('existe código a inspecionar', () => {
    expect(aiSrc.length).toBeGreaterThan(3);
  });

  it('ai/src (fora de adapters/) importa só core e schemas, sem rede, sistema de arquivos ou relógio', () => {
    const bad = aiSrc.flatMap((f) => violations(read(f)).map((v) => `${f}: ${v}`));
    expect(bad).toEqual([]);
  });

  it('o verificador pega o que deve pegar (e deixa passar o que deve)', () => {
    const must = [
      "import fs from 'node:fs';",
      "import { readFileSync } from 'fs';",
      "import http from 'node:http';",
      "import('node:net')",
      "const x = require('node:child_process');",
      "import OpenAI from 'openai';",
      "import { db } from '@sift/db';",
      "import { api } from '@sift/api';",
      'const r = await fetch(url);',
      'const s = new WebSocket(u);',
      'const t = Date.now();',
    ];
    for (const code of must) expect(violations(code).length).toBeGreaterThan(0);
    const fine = [
      "import { canonicalize } from '@sift/core';",
      "import type { ProjectSchema } from '@sift/schemas';",
      "import { ModelPortError } from '../ports';",
      "export * from './report';",
    ];
    for (const code of fine) expect(violations(code)).toEqual([]);
  });

  it('o package.json de ai só depende de pacotes do workspace permitidos (core e schemas)', () => {
    const pkg = JSON.parse(read(join(HERE, '..', 'package.json'))) as Record<string, Record<string, string> | undefined>;
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    const notAllowed = deps.filter((d) => d !== '@sift/core' && d !== '@sift/schemas');
    expect(notAllowed).toEqual([]);
  });

  it('nenhum código de core ou schemas importa @sift/ai', () => {
    const files = ['core', 'schemas'].flatMap((p) => walk(join(PACKAGES, p)).filter((f) => !f.includes(`${sep}node_modules${sep}`)));
    expect(files.length).toBeGreaterThan(10);
    const bad = files.filter((f) => importSpecs(read(f)).some((s) => s === '@sift/ai' || s.startsWith('@sift/ai/')));
    expect(bad).toEqual([]);
  });
});
