# Sift

Ambiente em que uma pessoa mantém o estado de um projeto e a AI **propõe mudanças** sobre ele; o humano revisa e decide.
Centro do produto: **State + Change + Review**.

## Estado atual: Marco 3.0 (`core`, `schemas` e esqueleto do `ai`, sem banco)

```
packages/core     núcleo puro: tipos, validação, aplicação, reconstrução, stale, compensação, evidência, regras de revisão
packages/schemas  Project Schemas como dados (JSON): research@1 e decisions@1
packages/ai       esqueleto: porta do modelo (ModelPort), tipos do relatório de execução, FakeModel e RecordedModel (sem pipeline, sem SDK, sem rede)
docs/             invariantes e decisões em aberto
```

## Rodar

Requer Node >= 22 e acesso ao registro npm.

```
npm install
npm test          # vitest (unitários, propriedade com fast-check, arquitetura, contrato)
npm run typecheck # tsc --noEmit
```

Dependências de runtime do `core`: `zod` e `@noble/hashes` (nada mais). O `core` não importa `node:*`,
banco, SDK de AI nem UI; um teste de arquitetura garante isso, e também que nenhum literal de domínio
(claim, decision, ...) aparece no `core`.
