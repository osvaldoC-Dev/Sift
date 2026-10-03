# Invariantes (Marco 1)

1. **Todo write é um change**, inclusive os humanos. Há um único caminho de escrita.
2. **O log de changes aplicados é imutável** (append-only, com cadeia de hashes). O estado atual é derivado dele.
   `reconstruct(log)` não consulta o schema nem relógio nem aleatoriedade.
3. **Propostas e revisões são registros separados do log.** A proposta (`Change`) é imutável; o status
   (`proposed`, `deferred`, `stale`, `accepted*`, `rejected`) é derivado dos eventos de revisão.
4. **Proveniência obrigatória**: origem (humano ou agente com `runId`), change que introduziu, versão-base,
   evidência.
5. **Evidência verificada mecanicamente** (`verifyEvidence`): o trecho existe exatamente na versão imutável da
   fonte. Isso prova existência, não que o trecho sustenta a afirmação.
6. **Impacto alto, transição explícita e toda decisão exigem revisor humano.** Nada é autoaplicado.
7. **O `core` não conhece domínio.** Tipos, relações, status e regras vêm do Project Schema (dado).
8. **A edição de texto do usuário vira change em momentos de commit** (pausa na digitação ou ação de salvar),
   **nunca por tecla**. É responsabilidade da camada de entrada (`web`/`api`) agrupar a digitação; o `core`
   recebe um change já consolidado, com `before` e `patch` do texto.
9. **Desfazer é um novo change compensatório.** O histórico nunca é reescrito. Se uma versão posterior tocou os
   mesmos alvos, o desfazer devolve `undo_conflict`.
10. **Derivados não são definidos por quem propõe**: `impact` e `basisKind` são calculados pelo `core` e
    conferidos (`derived_mismatch`).

## Base (`basis`) das operações

Para origem `agent` (e, onde o schema declara `any`, também para humano na promoção), a operação exige evidência
em quantidade mínima **ou**, se o schema permitir (`orJustification`), uma justificativa estruturada
(`statement` + `basedOn` com itens existentes e não aposentados, incluindo os extremos exigidos).
`basisKind` do change: `evidence`, `justification_only` (vence se alguma operação depende só de justificativa)
ou `none`. Mudança `justification_only` **nunca** entra em lote. A UI deve marcá-la como
"sem evidência de fonte, apenas justificativa" (Marco 4) e as métricas separam as duas classes (Marco 4).

## Promoção

Sair do `provisionalStatus` de um tipo é uma promoção e exige transição `explicit` declarada no schema.
A regra `promotion.basis` vale para qualquer origem, inclusive humana. Criação humana direta no status final
não tem basis (afirmação do próprio usuário).

## `accept_provisional` (inicialização do projeto)

Decisão leve sobre uma visão geral. Só vale se **nada no change cria compromisso**:

- só `create_item` e `create_relation`, origem agente, sem promoções nem transições explícitas;
- **não pode ser `justification_only`**: um change sustentado só por justificativa exige `accept` individual,
  coerente com a regra de que ele nunca entra em lote;
- `create_item` de tipo **com** `provisionalStatus`: o status criado tem de ser o provisório;
- `create_item` de tipo **sem** `provisionalStatus` (ex.: `question` no research): **permitido**, pois o schema
  declara que o tipo não distingue provisório de compromisso; regras de criação e de basis continuam valendo;
- tipos que o agente não pode criar (`source`, `note`) falham na validação de criação, antes da decisão;
- `create_relation` de tipo com impacto alto (`challenges`, `affects`, `supersedes`) **não entra**: relação não
  tem status provisório, então exige `accept` individual;
- `create_relation` só vale se os **dois extremos** forem (a) criados no mesmo change, (b) itens existentes ainda
  no `provisionalStatus` do tipo, ou (c) itens existentes de tipo sem `provisionalStatus`. Ligar algo provisório
  a um item já adotado (compromisso) exige `accept` individual.

A recusa devolve o código `accept_provisional_invalid`, com o motivo específico na mensagem. O log registra
`decision: 'accept_provisional'`, o que permite à UI marcar esses itens como "aceitos em revisão leve".

## Stale

Um change é stale se algum **alvo tocado** (item atualizado/aposentado ou extremo de relação já existente) tem
`lastVersion > baseVersion`. Base diferente do head não basta. Verificação em três pontos: ao aceitar
(autoritativo), na escrita (pendentes que tocam os alvos recebem evento `stale` de sistema) e na leitura
(derivado). Não há processo em segundo plano. `stale` é monotônico.
