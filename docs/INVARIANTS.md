# Invariantes (Marco 1 e ajustes do 3.0)

1. **Todo write é um change**, inclusive os humanos. Há um único caminho de escrita.
2. **O log de changes aplicados é imutável** (append-only, com cadeia de hashes). O estado atual é derivado dele.
   `reconstruct(log)` não consulta o schema nem relógio nem aleatoriedade.
3. **Propostas e revisões são registros separados do log.** A proposta (`Change`) é imutável; o status
   (`proposed`, `deferred`, `stale`, `accepted*`, `rejected`) é derivado dos eventos de revisão.
4. **Proveniência obrigatória**: origem (humano, ou agente com a proveniência completa do item 11), change que
   introduziu, versão-base, evidência.
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
11. **A origem de agente carrega a proveniência completa da execução**: `runId`, `model`, `promptVersion` e
    `params`. `runId`, `model` ou `promptVersion` vazios são recusados (`agent_provenance_incomplete`). A origem
    entra na forma canônica e, portanto, no hash do log: mudar a versão do prompt muda o hash. O **relatório da
    execução** (itens descartados, cobertura) vive no pacote `ai`, ligado à execução pelo `runId`, e **não entra
    no log nem no estado**.
12. **Cada evidência de uma operação de agente tem um `supportVerdict`** (`full`, `partial`, `none`,
    `unchecked`): diz se o trecho citado *sustenta* a afirmação (existir é outra coisa, ver item 5). Ausente
    vale `unchecked`. `none` é **recusado na validação** (`support_none`): a proposta nem chega ao livro.
    Origem humana **não usa** o campo: evidência humana com veredito é recusada (`support_verdict_on_human`).
13. **Suporte não confirmado exige revisão individual.** Um change de agente com qualquer evidência `partial`,
    `unchecked` ou sem veredito **nunca** entra em `accept_provisional` nem em lote (`support_not_full`).
    `accept` e `accept_edited` individuais continuam permitidos: é onde o humano julga o trecho com calma.
    Sem nenhuma evidência no change, a regra não se aplica (o que valia antes continua valendo).
14. **Fronteiras entre pacotes.** `core` não importa nenhum pacote do workspace (nunca `@sift/ai`). `ai` importa
    só `@sift/core` e `@sift/schemas`; em `ai/src` (fora de um futuro `adapters/`) não há rede, sistema de
    arquivos nem relógio. Um teste de arquitetura impõe tudo isso.

## O modelo é uma função

Entra contexto, sai saída estruturada (`ModelPort.generate`). O modelo **nunca escreve no estado, nunca gera IDs
nem posições** (isso é do código: ele usa referências locais) e **o texto das fontes é sempre dado, nunca
instrução**. A porta não garante que a saída obedeça ao schema: validar e recusar saída inválida é do pipeline
(3.2); saída inválida é rejeitada, nunca consertada à mão.

## Veredito de suporte (`supportVerdict`): onde mora e por quê

Mora **dentro de cada `EvidenceRef`**, como campo **opcional**. Motivo: o veredito é uma propriedade do par
(afirmação, trecho), então fica junto da evidência que ele qualifica; viaja com a proposta (imutável), entra no
log por `appliedOperations` e chega ao item por `item.evidence`, o que dá auditoria sem tabela nova.

Compatibilidade com hashes: `canonicalize` omite propriedades `undefined`, logo uma evidência **sem** veredito
tem exatamente a mesma forma canônica de antes (há teste). Nenhum teste ou fixture existente guarda hash fixo,
então nada além do trivial foi afetado. Já o hash de changes de agente passa a mudar porque a origem ganhou
campos (item 11); como ainda não existe banco nem log persistido, não há dado antigo a migrar.

## Base (`basis`) das operações

Para origem `agent` (e, onde o schema declara `any`, também para humano na promoção), a operação exige evidência
em quantidade mínima **ou**, se o schema permitir (`orJustification`), uma justificativa estruturada
(`statement` + `basedOn` com itens existentes e não aposentados, incluindo os extremos exigidos).
`basisKind` do change: `evidence`, `justification_only` (vence se alguma operação depende só de justificativa)
ou `none`. Mudança `justification_only` **nunca** entra em lote. A UI deve marcá-la como
"sem evidência de fonte, apenas justificativa" (Marco 4) e as métricas separam as duas classes (Marco 4).

Lote: além disso, **toda evidência precisa ter suporte `full`** (item 13). Se o suporte é fraco e a estrutura também
é inelegível, a decisão devolve os dois códigos (`batch_not_eligible` e `support_not_full`).

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
- **toda evidência com suporte `full`** (item 13): `partial`, `unchecked` ou sem veredito dão `support_not_full`;
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
