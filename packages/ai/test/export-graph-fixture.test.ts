import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEval, type EvalData } from '../eval';
import {
  FIXTURE_WARNING, STATUS_CYCLE, SUPPORT_CYCLE, buildGraphFixture, exportGraphFixture, renderFixture,
} from '../eval/export-graph-fixture';

const data = loadEval();
const fixture = buildGraphFixture(data);
const allKeys = data.golds.flatMap((g) => g.items.map((i) => i.key));

describe('exportador do fixture do grafo', () => {
  it('um item por chave do gabarito, na ordem fonte/gabarito, com id = chave e quote = 1ª citação', () => {
    expect(fixture.items.map((i) => i.id)).toEqual(allKeys);
    expect(new Set(fixture.items.map((i) => i.id)).size).toBe(allKeys.length);
    for (const g of data.golds) {
      for (const gi of g.items) {
        const it = fixture.items.find((x) => x.id === gi.key)!;
        expect(it).toMatchObject({ type: gi.type, source: g.source, text: gi.statement, quote: gi.quotes[0] });
      }
    }
  });

  it('toda ponta de relação existe em items', () => {
    const ids = new Set(fixture.items.map((i) => i.id));
    expect(fixture.relations.length).toBeGreaterThan(0);
    for (const r of fixture.relations) {
      expect(ids.has(r.from), `from ${r.from}`).toBe(true);
      expect(ids.has(r.to), `to ${r.to}`).toBe(true);
    }
  });

  it('as relações do gabarito aparecem todas, com o tipo certo; duplicatas em cadeia (a-b, b-c)', () => {
    const rel = data.relations;
    const count = (k: string) => fixture.relations.filter((r) => r.kind === k).length;
    expect(count('contradiction')).toBe(rel.contradictions.length);
    expect(count('near_miss')).toBe(rel.near_misses.length);
    expect(count('duplicate')).toBe(rel.duplicates.reduce((n, g) => n + g.length - 1, 0));
    for (const p of rel.contradictions) {
      expect(fixture.relations).toContainEqual({ from: p.a, to: p.b, kind: 'contradiction', note: p.note });
    }
    for (const p of rel.near_misses) {
      expect(fixture.relations).toContainEqual({ from: p.a, to: p.b, kind: 'near_miss', note: p.note });
    }
    for (const g of rel.duplicates) {
      for (let k = 0; k + 1 < g.length; k++) {
        expect(fixture.relations.filter((r) => r.kind === 'duplicate' && r.from === g[k] && r.to === g[k + 1])).toHaveLength(1);
      }
    }
  });

  it('cadeia de três: um grupo [a,b,c] vira a-b e b-c (e não a-c)', () => {
    const synthetic: EvalData = {
      ...data,
      relations: { contradictions: [], near_misses: [], duplicates: [[allKeys[0]!, allKeys[1]!, allKeys[2]!]] },
    };
    const f = buildGraphFixture(synthetic);
    expect(f.relations.map((r) => [r.from, r.to])).toEqual([[allKeys[0], allKeys[1]], [allKeys[1], allKeys[2]]]);
  });

  it('status e support seguem a regra documentada (ciclo pelo índice) e o aviso de demonstração está presente', () => {
    expect(fixture._aviso).toBe(FIXTURE_WARNING);
    expect(fixture._aviso).toContain('DEMONSTRAÇÃO');
    fixture.items.forEach((it, i) => {
      expect(it.status).toBe(STATUS_CYCLE[it.type][i % 3]);
      expect(it.support).toBe(SUPPORT_CYCLE[i % SUPPORT_CYCLE.length]);
    });
    expect(new Set(fixture.items.map((i) => i.support)).size).toBeGreaterThan(1);
  });

  it('ponta inexistente numa relação faz o exportador falhar (nada de grafo com aresta solta)', () => {
    const bad: EvalData = {
      ...data,
      relations: { ...data.relations, contradictions: [{ a: allKeys[0]!, b: 'nao.existe', note: 'x' }] },
    };
    expect(() => buildGraphFixture(bad)).toThrow('nao.existe');
  });

  it('determinístico byte a byte: duas construções e dois arquivos escritos são idênticos', () => {
    expect(renderFixture(buildGraphFixture(loadEval()))).toBe(renderFixture(fixture));
    const dir = mkdtempSync(join(tmpdir(), 'sift-fixture-'));
    const a = exportGraphFixture(join(dir, 'a.json'));
    const b = exportGraphFixture(join(dir, 'b.json'));
    expect(a).toBe(b);
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe(readFileSync(join(dir, 'b.json'), 'utf8'));
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe(renderFixture(fixture));
    expect(a.endsWith('}\n')).toBe(true);
  });

  it('o gabarito não é alterado pela exportação (o arquivo lido depois é igual ao lido antes)', () => {
    const before = JSON.stringify(loadEval());
    exportGraphFixture(join(mkdtempSync(join(tmpdir(), 'sift-fixture-')), 'x.json'));
    expect(JSON.stringify(loadEval())).toBe(before);
  });

  it('o fixture versionado (eval/fixture-estado.json) é exatamente o que o exportador gera agora', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'fixture-estado.json');
    expect(readFileSync(file, 'utf8')).toBe(renderFixture(fixture));
  });
});
