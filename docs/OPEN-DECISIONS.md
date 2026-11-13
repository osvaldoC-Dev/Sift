# Decisões em aberto

## 1. O que significa "reprocessar" um change stale: **DECIDIDO** (implementação no 3.4)

**Decisão:** reprocessar um change desatualizado = **pedir uma nova proposta sobre o estado atual e descartar a
antiga.** Não se faz rebase mecânico das operações antigas, nem se aceita um stale editado.

**O que existe hoje (Marco 1):** um change stale não pode ser aceito (`code: 'stale'`) e pode ser dispensado
(`reject`). `accept_edited` **não** resolve um stale, porque a verificação usa a mesma `baseVersion` do change
original (há teste). Nada do reprocessamento está implementado: é do **3.4**.

**Detalhes que o 3.4 precisa fechar** (a decisão acima não os define): como o change antigo é descartado (a
máquina de estados já permite `stale` → `rejected`; falta definir o `reasonCode`); se a nova execução herda a
instrução e o escopo do change antigo; se o novo change guarda uma referência ao antigo; como isso aparece nas
métricas (taxa de reprocessamento).

## 2. Outros pontos conhecidos

- **Base do change não inclui itens citados em `basedOn`/contexto:** se um item usado como base mudar, o change não
  fica stale (só os alvos tocados contam). A validação ao aceitar rejeita `basedOn` aposentado/inexistente.
- **Aposentar item não aposenta relações ligadas a ele** (sem cascata no core); relações para extremos aposentados
  são vedadas só na criação.
- **Casamento de citação é exato** (após normalização). Tolerância a espaços/hifenização fica para depois do Marco 2.
- **`set_schema`** está reservada e não implementada; no beta, cada projeto fixa a versão 1.
- **`ambiguous`** (citação que aparece mais de uma vez) é gerado na resolução de citações (`ai`, Marco 3), não em
  `verifyEvidence`.
- **Desfazer com conflito** só informa os alvos em conflito; a experiência de resolução é do Marco 4.
- **Limiares**: tamanho mínimo/máximo de citação (5 a 2000 code points), `statementMin` (20 agente, 10 humano) e
  `maxChangesPerSet` são valores iniciais a calibrar com dados.

## 3. Dúvidas abertas do 3.0

- **Humano com veredito é recusado, não ignorado** (escolha do 3.0): um veredito em evidência humana afirmaria uma
  checagem que nunca ocorreu. Reversível: trocar por "ignorar" é uma linha.
- **Ausente = `unchecked`**, e não um erro de validação, para não invalidar propostas antigas. O pipeline do 3.2
  deve preencher sempre.
- **Evidência `partial` conta para o mínimo de evidência (`evidenceMin`)** e o change fica `basisKind: 'evidence'`;
  só a decisão (revisão leve e lote) a trata como fraca. Se `partial` deveria valer menos que `full` no próprio
  basis, é decisão futura.
- **Cobertura** (`SourceCoverage`): definida como passagens enviadas × passagens citadas por fonte. "Passagem" é
  a unidade de contexto enviada ao modelo; como dividir as fontes é do 3.2, e a definição pode mudar lá.
- **`params` da origem** é um mapa JSON; o `ModelParams` do `ai` precisa ser convertido para ele no pipeline (3.2).
- **O `ModelPort` não valida a saída contra o schema** e tem só dois códigos de erro (`no_response`,
  `provider_error`). Erros de rede, limite de uso e saída ilegível entram junto com os adaptadores reais.
- **Os testes com o `vitest` real** ainda não rodaram neste ambiente (registro npm bloqueado): os números abaixo
  vêm de uma execução com shims descartáveis, e a conferência final é a sua (`npm test`).

## 4. Dúvidas abertas do 3.1

- **Limite de casamento em 50% do trecho do gabarito** é um valor inicial. Mais baixo aceita citações vagas;
  mais alto rejeita citações que pegam o essencial mas não a frase inteira. Calibrar com a primeira execução
  real, olhando os `unjudged`.
- **O gabarito não lista tudo o que é correto.** Previsão válida fora do gabarito vira `unjudged` (precisa de
  uma pessoa), e a precisão é só um piso. Se o volume de `unjudged` for alto, a solução é ampliar o gabarito,
  não afrouxar o casamento.
- **O gabarito foi escrito por quem conhece o sistema.** Pode estar enviesado a favor do pipeline. Deve ser lido
  e contestado pelo dono do projeto antes da primeira execução ao vivo.
- **Relações (contradição, quase-contradição, duplicata) só são validadas**, não pontuadas: a pontuação delas é
  da Fase B. Única exceção, informativa: `duplicatePairsPredicted` conta os pares de `duplicates` cujos dois
  lados a previsão acertou (o Extrair emitiu redundância conhecida). Não é erro nem regressão; quem remove a
  duplicata é outra etapa.
- **Citação ambígua** (trecho que aparece mais de uma vez na fonte) é só contada (`ambiguousCitations`) e
  casa com qualquer ocorrência. Decisão de padrão do 3.1.1, a confirmar: se o núcleo deve recusá-la quando a
  posição importa, isso é do Marco 3.2 (validação de citação do Extrair), não do harness.
- **`compare()`**: "sem julgamento", excesso de previsões e duplicatas conhecidas emitidas são informativos
  (`mudou`, nunca `piorou`). Só recall, citação válida, piso de precisão, armadilhas, injeções, citações
  inválidas e sem citação entram em `regressions`.
- **Limites de aprovação** (precisão, recall etc.) não estão no código e precisam ser definidos antes da
  primeira execução ao vivo.
- **Fontes só em inglês.** Falta uma ou duas em português na segunda rodada, com fontes reais.
- **O `eval/` lê arquivos** (`load.ts`) e por isso fica fora de `ai/src`, onde o teste de arquitetura proíbe
  sistema de arquivos. O `score.ts` e o `report.ts` são puros.

## 5. Contrato de fonte (3.2a)

- **Citação ambígua: PENDENTE DE INTERFACE.** Trecho que aparece mais de uma vez na fonte: o `locate` devolve
  todas as ocorrências; o pipeline (3.2b) usa a primeira e marca `ambiguousCitation` no relatório da rodada.
  Ainda não decidido: se o núcleo deve recusar quando a posição importa. Nada no log muda por isso.
- **Dedupe do Extrair:** mesmo tipo + cobertura de citação >= `DEDUPE_COVERAGE = 0.9` nos dois sentidos. É uma
  constante nomeada, valor inicial; calibrar com a primeira rodada real (3.3).
- **`getBytes` não declarado.** O `ContentReader` só lê texto. Tipos de fonte binários (PDF, imagem) exigirão
  uma segunda porta de leitura; fica para quando houver o primeiro tipo binário.
- **Metadados de código (commit, caminho) NÃO SÃO VERIFICADOS.** Só o hash do arquivo prova a evidência.
- **`unknown_kind` e `locator_invalid`** são razões tipadas de `verifyEvidence`/`validate`. Evidência de texto
  não tem campo `kind` (forma canônica e hashes antigos intactos); `kind: 'text'` explícito é recusado.
  Protegido por `golden-hashes.test.ts`.
- **Hash da evidência é conferido contra o texto guardado como está** (o repositório guarda texto já
  normalizado). Divergência = `hash_mismatch`.
- **Tipo de campo `datetime`** (ISO-8601 estrito, com conferência de calendário, sem relógio). `capturedAt` é
  declarado pelo usuário, não verificado, entra no hash e nunca é usado em lógica. O momento confiável é o
  `at` do evento do log (porta de relógio).
- **research@1 ganhou campos opcionais** (`originType`, `originLabel`, `originRunId`, `capturedAt`) sem
  mudar a versão (aditivo). Se algum dia forem obrigatórios, é research@2. `originType` é opcional no schema
  mas obrigatório na camada que cria a fonte.
- **Limites herdados:** a conferência real com `npm test` e `tsc` é do usuário; as constantes do teste dourado
  foram geradas fora do ambiente real e precisam ser confirmadas lá.

## 6. Pipeline Extrair (3.2b)

- **Item com campo a mais na saída do modelo (id, start, end...)** descarta só o item (`malformed_item`). Só a
  forma errada da saída inteira descarta a execução. A decisão aprovada diz "item inválido descarta só o item";
  a classificação de "campo a mais" como item inválido é minha leitura. A confirmar com o Claude 1.
- **Saída do verificador fora do schema NÃO descarta a execução (v2, decisão do Claude 1):** o item é mantido com
  `supportVerdict: 'unchecked'` (o núcleo bloqueia aceite provisório e lote até revisão humana) e o relatório
  lista o caso em `uncheckedByVerifier` (`ref` + motivo). A execução só é descartada (erro tipado, `retryable`)
  quando o PROVEDOR falha. Item `unchecked` continua dentro de `kept` e fora de `discarded`.
- **O pipeline NÃO tem filtro de injeção.** Nenhum passo procura ou remove instruções dentro da fonte. A defesa é
  em camadas: (1) o delimitador (a fonte entra como dado, num bloco que ela mesma não contém); (2) o verificador
  vê só afirmação + citação, nunca a fonte; (3) `decision` é sempre provisória, impacto alto, fora de lote;
  (4) o eval mede injeções obedecidas/citadas (limite 0); (5) revisão humana de tudo. Nenhuma camada sozinha
  garante nada; a medição real vem da primeira rodada ao vivo (3.3).
- **Citação normalizada em NFC antes de procurar.** Uma citação decomposta (e + U+0301) casa e é gravada
  composta. Letra trocada, espaço diferente ou hifenização refeita continuam sem casar.
- **Ambiguidade só é detectada dentro da passagem.** O mesmo trecho em duas passagens diferentes não é marcado.
- **Sem relação `derived_from` item -> fonte e sem `changeSetId`.** Cada item é um Change separado. Agrupar em
  change sets (limite 12) e ligar à fonte fica para o runner (3.3) ou a camada de revisão.
- **Delimitador:** em vez de alterar o texto da fonte, o pipeline escolhe um sufixo de delimitador que a fonte
  não contém (o texto fica intacto, para a citação continuar existindo nele).
- **Corte duro:** uma frase maior que o limite da passagem é cortada no limite; uma citação que cruze esse corte
  é descartada como inválida. Com o limite padrão (6000) e com 1200 e 700, nenhuma citação do gabarito cruza.
- **Só um modelo para extrair e verificar** nesta etapa (a porta é a mesma). A origem grava
  `verifierModel` em `params`. Usar modelos diferentes é decisão do 3.3.
- **Limite padrão de passagem: 6000 code points.** Valor inicial, não calibrado com modelo real.

## 7. API (`packages/api`, incremento 1)

Pontos para o Claude 1 (contrato 0.2.1) marcados com **[C1]**.

- **[C1] No research@1 só a PERGUNTA vai a lote.** `batchEligibleImpact` é `['low']` e a afirmação tem impacto
  médio; decisão e suposição, alto. O contrato e os exemplos tratam a afirmação como elegível. A API segue o
  núcleo (nada reimplementado), então `canBatchAccept` de uma afirmação é recusado. Decidir: abrir o impacto
  médio no schema (decisão de produto) ou ajustar o que a interface espera do lote.
- **[C1] `BlockCode` não tem um código genérico para "lote recusado pela estrutura".** Traduzi `batch_not_eligible`
  do núcleo para `decision_individual_only` (ou `relation_touches_adopted` quando há relação). Para uma afirmação
  isso é enganoso. Pedir `needs_individual_review` (ou similar) na próxima versão do contrato.
- **[C1] `provisional`:** não está definido. Calculei "o item é criado no status provisório do seu tipo"
  (`provisionalStatus` do schema). No research@1 isso dá `true` para afirmação, suposição e decisão, e `false`
  para pergunta. O exemplo `proposalOk` (afirmação, `provisional: false`) não bate com essa leitura.
- **[C1] Fonte de IA:** `originType: 'ai'` é recusado com `invalid_request`, porque o núcleo exige
  `originRunId` numa fonte de IA e o `CaptureSourceRequest` não o traz. Pedir o campo opcional ao contrato.
- **[C1] `LogEntry.action`:** o histórico da interface é a cadeia de AUDITORIA da API (captura, proposta,
  rejeição, aceite, desfazer), não a cadeia do núcleo (que só tem o aplicado e não tem rejeição). O hash usa só
  campos que o cliente recebe, então se confere a partir da lista: `sha256((prevHash ?? '') + '\n' +
  canonicalize({seq, action, targetId, at}))`. A entrada guarda por dentro a versão do núcleo (`coreVersion`).
- **[C1] Falta schema de resposta** para `getSource` (reuso `captureSource`) e `listProposals` (valido
  `ProposalView.array()`). Pedir as chaves em `ResponseSchemas`.
- **[C1] `StateView.relations.kind`** é `contradiction|near_miss|duplicate`, e o research@1 tem outros nomes de
  relação (`supports`, `challenges`...). A API só devolve relações cujo tipo é exatamente um dos três. Nenhuma
  relação é criada pelo pipeline hoje, então o estado sai sem relações até isso ser definido.
- **[C1] `source_too_large`** nunca é produzido: a captura recusa texto acima do limite (`invalid_request`) e o
  pipeline fatia o que couber.
- **[C1] `devDependencies` do contrato** pedem `vitest ^2.0.0` e o repositório usa `^3.2.0`. Pedir `^3.2.0` (ou
  nenhuma) para o `npm install` não trazer duas cópias.
- **Falha de extração responde HTTP 200** com `ExtractionResponse` `ok:false` (a união do contrato existe para
  carregar a falha no corpo). Erro do pedido (`not_found`, `invalid_request`...) usa 4xx; erro interno, 500.
  `provider_failure` cobre também `no_response` e `aborted` (estes sem `retryable`).
- **`not_allowed`, `stale` e `conflict` respondem 409; `invalid_request`, 400; `not_found`, 404.**
- **Elegibilidade:** `canAccept`/`canBatchAccept` vêm de `staleReasons`, `analyzeChange` e `checkDecision` do
  núcleo, com um revisor humano de sonda; a API só traduz os códigos. Duas regras são do contrato e não do
  núcleo: citação ambígua nunca vai a lote; análise do núcleo com problemas no estado atual vira `stale`.
- **A API não cria projetos.** Os projetos existem na configuração do armazém; id desconhecido é `not_found`.
- **Sem autenticação nesta fase.** A pessoa das mudanças humanas é `actorId` da configuração (`local-user`).
- **Texto da fonte:** `SourceView.text` é o instantâneo NORMALIZADO (NFC) que o núcleo guarda e sobre o qual os
  deslocamentos valem. Se o usuário colar texto decomposto, o texto devolvido difere do enviado.
- **Extrair duas vezes a mesma fonte** cria propostas pendentes duplicadas: o pipeline deduplica contra o estado
  aplicado e contra a própria execução, não contra propostas pendentes de outra execução.
- **`originLabel` de uma proposta** é o modelo que a gerou; o `originLabel` da captura é guardado na fonte e não
  aparece em nenhuma resposta (o contrato não o devolve).
- **`Store` e o Postgres (1b):** a interface importa só TIPOS (`Outcome`, `ReviewInput`) de `@sift/core/testing`;
  promover esses tipos ao núcleo público entra no 1b. A atomicidade entre núcleo e auditoria é da
  implementação durável (uma transação por método de escrita da API). A fila de escrita por projeto
  (`locked`) é morta pelo teste `write-queue.test.ts` (mutação X10), com latência simulada.
- **Rotas `decide`, `batchAccept` e `undo`** respondem 500 `internal` ("incremento 2") até o próximo zip.

### 7.1 Escritas concorrentes e o Postgres (1b)

- **Critério obrigatório antes do Postgres:** `test/write-queue.test.ts` tem de passar contra o armazém durável,
  trocando só `makeStore` em `store-factory.ts` e embrulhando-o com `withLatency`.
- **[1b] A fila `locked` protege UM processo.** É um `Map` em memória: com duas instâncias da API, ou um reinício a
  meio de um pedido, não protege nada. Com Postgres a proteção real tem de estar no armazém: versão otimista
  (`baseVersion` contra a versão atual, na mesma transação da escrita) ou bloqueio por projeto
  (`pg_advisory_xact_lock(hash(projectId))`). `locked` passa a ser otimização, não garantia.
- **[1b] Critério a acrescentar para o Postgres:** duas escritas com a mesma `baseVersion`, feitas por DUAS
  instâncias de `Store` sobre o mesmo banco, em paralelo, sobre o mesmo elemento: uma passa, a outra devolve
  `conflict`, e a perdedora não deixa rastro (nem no núcleo nem na auditoria). Em memória só há uma instância, por
  isso o teste atual (`armazém: duas escritas com a mesma baseVersion...`) cobre a regra, mas não a multi-instância;
  `makeStore` deverá aceitar criar um segundo `Store` sobre o mesmo banco. O conflito é por elemento (regra do
  núcleo: `staleReasons`), não por versão global: duas escritas em elementos diferentes passam as duas.
- **Extração em duas fases (decisão B do Claude 1, IMPLEMENTADA):** `startExtraction` lê (fonte, estado, versão) e
  chama o modelo SEM a fila; só a escrita final (`proposeChange`, metadados, auditoria) entra em `locked`. Uma
  proposta pode nascer com `baseVersion` atrasada; o núcleo trata (`stale` por elemento) e a idempotência
  `runId:sourceId:ref` impede repetição. Provas: `extraction-phases.test.ts` (captura, estado e log terminam enquanto o
  modelo está preso) e o teste de atomicidade em `write-queue.test.ts` (as propostas de uma execução ficam contíguas
  na auditoria). Custo conhecido: nada impede duas extrações da MESMA fonte ao mesmo tempo (propostas duplicadas, como
  já era com extrações em série; ver §7 "re-extrair duplica").
- **Achado e correção (núcleo):** `InMemoryLedger.propose` NÃO honrava `idempotencyKey` (só `submitHuman` honrava), então
  a chave `runId:sourceId:ref` não protegia nada no caminho do agente. Agora a mesma chave devolve a proposta já criada
  (com o estado ATUAL, não o do momento da criação); proposta recusada não consome a chave. Teste:
  `core/test/propose-idempotency.test.ts`. O armazém durável do 1b tem de ter a mesma regra (chave única por projeto).
- **Todas as rotas de escrita passam por `locked`:** `captureSource` e `startExtraction` hoje; `decide`,
  `batchAccept` e `undo` entram no incremento 2 com testes concorrentes (duas decisões na mesma proposta; lote
  concorrente com decisão individual; `undo` concorrente com captura nova).

## 8. Rodada 3: endurecimento do 3.2b e preparação do 3.3

### 8.1 Endurecimento do 3.2b
- **`verifierDegraded`** (`RunReport`): `{unchecked, verified, fraction, threshold} | null`. Aparece quando a fração de
  itens `unchecked` por saída inválida do verificador PASSA (`>`) do limite (`verifierDegradedThreshold`, padrão 0,5;
  fora de 0..1 é `RangeError`). A execução continua `ok:true`. A fração conta os itens que chegaram ao verificador
  (inclui os que ele descartou com `none`). Execução descartada: `null`.
  **[C1] A resposta `ExtractionResponse` do contrato 0.2.1 não tem onde levar este aviso.** A API o grava no log
  (`verifier_degraded`, nível `warn`) e cada proposta afetada já sai com `verifierFailed:true`. Peço um campo
  opcional `verifierDegraded` (ou `warnings: string[]`) em `ExtractionResponse` para a UI do 3.4 mostrar.
- **Status por tipo lido do schema** (`resolveCreationStatuses`): `provisionalStatus` do tipo; sem ele, `open` se a IA
  puder criar em `open`; senão o único status de criação da IA; senão erro tipado `schema_unsupported` (não
  retentável, ANTES de gastar uma chamada). Um schema sem algum dos quatro tipos extraídos (ex.: `decisions@1`) é
  recusado inteiro, não só o tipo em falta (decisão minha; alternativa: recusar só os itens desse tipo).
  A API traduz `schema_unsupported` para `internal`.
- **Ambiguidade entre passagens:** a citação é ambígua se `TEXT_KIND.locate(textoInteiro, citação)` achar mais de uma
  ocorrência (a passagem é recorte da fonte, então repetida na passagem implica repetida na fonte). A posição gravada
  continua a da ocorrência dentro da passagem; só se marca. Continua sem `changeSetId`/`derived_from`.
- **Redundâncias removidas** (mutações equivalentes que sobreviviam): o hash do snapshot é checado uma vez
  (`TEXT_KIND.hashOf`); a ambiguidade usa só a fonte inteira.

### 8.2 Adaptador do Kimi e teto de custo (3.3, SEM chamada real)
- `src/adapters/kimi.ts` (`KimiModel`), `src/cost.ts` (`CostGuard`, `KIMI_K3_PRICES`), `src/secrets.ts`
  (`redactSecrets`), `eval/live.ts` (runner), `eval/live-config.ts`, `eval/live-cli.ts`. Tudo testado só com
  transporte falso; o CLI (`live-cli.ts`) NÃO foi executado.
- **NÃO CONFIRMADO para o K3 (só a primeira chamada real mínima, K9, confirma):** rota `/chat/completions` no estilo
  OpenAI; `reasoning_effort` com `low|high|max`; `max_tokens` como nome do teto de saída; onde vem o uso em cache
  (`usage.cached_tokens` ou `usage.prompt_tokens_details.cached_tokens`; os dois são lidos); se os tokens de raciocínio
  já vêm em `completion_tokens` (assumo que sim). Nunca se envia `temperature` nem `seed`.
- **`usage` em falta nunca vira custo zero:** estima-se por cima (entrada = caracteres/2; saída = o teto de saída) e
  marca-se `estimated:true`; o relatório conta as chamadas estimadas.
- **Teto de custo:** dólares e tokens são AMBOS obrigatórios (por fonte e total); "atingir" é `>=`; o gasto pode
  passar do teto por no máximo UMA chamada (limitada por `max_tokens`). Não há estimativa de pior caso ANTES da chamada
  (decisão minha; custo: uma chamada pode estourar o teto por até `max_tokens × US$ 15/M`). Estourar o teto PARA a
  corrida inteira (as fontes restantes ficam `not_run`) e o veredicto é `incompleto`.
  **[C1] O contrato 0.2.1 não tem código para `cost_cap_exceeded`:** a API mostra `provider_failure` não retentável.
- **Veredicto só com as 7 fontes avaliadas.** Falha de fornecedor deixa a fonte `failed` (uma nova tentativa só se
  retentável) e nunca vira "item errado". Com fonte em falta: `incompleto`, sem limiares e sem números de recall.
  Limiar sem dados (ex.: taxa de citação sem nenhuma previsão) NÃO passa.
- **O runner recusa:** sem tetos; `approval-thresholds.json` não commitado ou modificado (consulta o git); conjunto de
  fontes diferente das 7 sintéticas. Lê os limiares só desse JSON (regista o sha256). Não escreve em lugar nenhum; o
  CLI recusa gravar em cima do gabarito, das fontes ou dos limiares.
- **Respostas gravadas:** `recording.json` (formato do `RecordedModel`, repete a corrida offline e de graça, testado:
  mesmo relatório) e `raw.jsonl` (corpo bruto do fornecedor, com a chave redigida).
- **O que o Osvaldo define** para correr: `MOONSHOT_API_KEY`, `SIFT_LIVE_MAX_USD`, `SIFT_LIVE_MAX_TOKENS`,
  `SIFT_LIVE_SOURCE_MAX_USD`, `SIFT_LIVE_SOURCE_MAX_TOKENS`, `SIFT_LIVE_MAX_OUTPUT_TOKENS` (obrigatórias; o runner
  recusa sem elas); opcionais `SIFT_LIVE_REASONING_EFFORT` (padrão `low`), `SIFT_LIVE_MODEL`, `MOONSHOT_BASE_URL`
  (https obrigatório). Falta o script `npm run eval:live`: precisa de `tsx` como devDependency (hoje o repo não o
  tem), o que muda o lock; fica para a rodada da chamada real, por `npm install` do Osvaldo.
- **Segundo modelo:** o adaptador é configurável por `baseUrl`/`model` (`KimiModel` serve a qualquer API
  compatível); a escolha continua do Osvaldo. Nada foi ligado.

## 9. API, incremento 2 (decidir, lote, desfazer) e contrato 0.3.0

Decisões tomadas por Claude 2. Itens marcados **[C1]** precisam de Claude 1 (contrato).

1. **Elegibilidade nunca lança.** Recusa do núcleo sem tradução → `core_refused`. Lote recusado pela estrutura →
   `decision_individual_only` (cria decisão), `relation_touches_adopted` (relação ligada a item que já existe) ou
   `needs_individual_review` (impacto fora de `batchEligibleImpact`, transição explícita, só justificativa).
   Equivalência com o núcleo testada em 270 combinações (tipo × suporte × citação × estado).
2. **Desfazer = só a decisão aceita mais recente (pilha).** Compensação do núcleo; nunca apaga histórico; `canUndo`
   é verdadeiro só se há tal decisão e `compensate` a aceita agora. Capturas (mudança humana) não se desfazem por
   este botão. Sem corpo no pedido (o contrato 0.3.0 não traz).
3. **Estado da proposta depois de desfazer.** O núcleo não tem "desfeita" (aceita é final). A API mostra a proposta
   desfeita como `rejected`, tudo `already_decided`, `stale=false`; a fonte é a auditoria (`action=undo`).
   O fixture `undo` do contrato mostra a proposta de volta como `pending`. **[C1]** Confirmar: (a) `rejected` serve, ou
   (b) o contrato ganha estado `undone`, ou (c) quer-se `pending` de verdade, o que exige uma transição nova no
   núcleo (aceita → adiada) e a proposta voltaria já `stale`, só rejeitável.
4. **Lote com id inexistente.** `BlockCode` não tem `not_found`; o id sai em `refused` com `core_refused`.
   **[C1]** Pedir `not_found` ao `BlockCode` (ou dizer que `core_refused` serve).
5. **Erros de decisão.** Já decidida / bloqueada → `409 not_allowed` com `block`; obsoleta → `409 stale`; proposta
   desconhecida → `404`; `edit` com texto igual ao original → `400` (aceite sem editar); `edit` de relação → `core_refused`
   (o contrato não traz o texto editável de uma relação).
6. **Edição.** Sempre `accept_edited` com suporte `unchecked` e `edited: true` (o núcleo rebaixa a evidência cujo
   conteúdo mudou; por isso o texto idêntico é recusado).
7. **`originRunId`.** Fonte de IA só é aceita se a execução existe: existe ao menos uma proposta com esse `runId`.
   Uma execução que não produziu nenhuma proposta não conta como existente (**[C1]** se isso incomoda: o contrato
   precisaria de uma lista de execuções).
8. **Fila.** `decide`, `batchAccept` e `undo` correm em `locked` por projeto, como a captura. Continua valendo o
   limite do §7.1: a fila é de um processo só; no 1b o Postgres precisa do mesmo teste com dois armazéns.
9. **Lote e obsolescência.** Cada id é reavaliado na hora (vista fresca) porque aceitar uma proposta pode tornar
   outra obsoleta; `proposals` na resposta é lida DEPOIS do lote.
