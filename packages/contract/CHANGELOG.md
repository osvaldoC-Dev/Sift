# Changelog do @sift/contract
## 0.3.0 (alterações de forma; pré-1.0)
- BlockCode: `needs_individual_review`, `core_refused` (lote recusado pela estrutura do núcleo; a API nunca lança por isto).
- CaptureSourceRequest: `originRunId` (obrigatório se originType=ai, proibido se human).
- StateItem: `evidence[]` (sourceId, quote, start, end). StateRelation.kind passa a string livre (vem do schema do projeto). StateView: `canUndo`.
- BatchAcceptResponse: `proposals` (propostas atualizadas).
- ResponseSchemas: `getSource`, `proposals`.
- Quote.start/end: pontos de código Unicode sobre o texto NORMALIZADO (NFC) devolvido em SourceView.text.
- Fixtures: `provisional` coerente; propostas de lote são perguntas (research@1: só impacto baixo vai a lote).
- devDependency vitest `^3.2.0`.

## 0.2.1 (7/11/2026)
- `zod` alinhado com o repo: `^3.25.0` (o repo resolve 3.25.76). Sem alterações de código.
## 0.2.0 (7/11/2026)
- Novo: `checkProposalInvariants`, `fixtures.ts` (exemplos de referência), `ResponseSchemas`, `CONTRACT_VERSION`. 43 testes, mutações das invariantes apanhadas.
## 0.1.1
- `ProposalView.verifierFailed` (obrigatório).
## 0.1.0
- Primeira versão.
Política: 0.x pode mudar com CHANGELOG. 1.0.0 quando API e interface o tiverem integrado uma vez. Depois: campo opcional novo = minor; quebra = major com OK do Osvaldo.
