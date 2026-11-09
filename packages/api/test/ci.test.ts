import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.github', 'workflows', 'ci.yml');
const yml = readFileSync(file, 'utf8');
const live = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

describe('CI (critério 22)', () => {
  it('corre em todo push e pull request', () => {
    expect(live).toMatch(/^on:\n {2}push:\n {2}pull_request:/m);
  });
  it('corre npm ci, npm test e npm run typecheck, nesta ordem', () => {
    const steps = [...live.matchAll(/^\s+- run: (.+)$/gm)].map((m) => m[1]);
    expect(steps).toEqual(['npm ci', 'npm test', 'npm run typecheck']);
  });
  it('nenhum passo "continue-on-error": falha bloqueia', () => {
    expect(live).not.toMatch(/continue-on-error|\|\| true/);
  });
  it('sem chaves nem segredos: nenhuma referência a secrets, tokens ou variáveis de modelo', () => {
    expect(live).not.toMatch(/secrets\.|_API_KEY|_TOKEN|MOONSHOT|OPENAI|ANTHROPIC|KIMI/i);
    expect(live).toMatch(/permissions:\n {2}contents: read/);
  });
  it('usa a versão de Node do repositório (.nvmrc), não uma fixa no workflow', () => {
    expect(live).toContain('node-version-file: .nvmrc');
  });
});
