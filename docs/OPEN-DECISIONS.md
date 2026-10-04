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

- **Editar um item muda o texto, mas o veredito continua `full`.** Em `accept_edited`, o humano pode alterar o
  conteúdo de um item mantendo a evidência com `supportVerdict: 'full'`, que foi dado para o texto original.
  Opção a avaliar: rebaixar o veredito para `unchecked` quando o conteúdo é editado. Não implementado.
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
