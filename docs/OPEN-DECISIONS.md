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
- **A saída do verificador fora do schema descarta a execução inteira** (mesma regra da saída do modelo).
  Alternativa mais branda: marcar o item como `unchecked`. Não adotada, porque `unchecked` nunca poderia ir a lote.
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
