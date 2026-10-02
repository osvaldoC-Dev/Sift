# Decisões em aberto

## 1. O que significa "reprocessar" um change stale (decidir antes do Marco 3)

**O que existe hoje (Marco 1):** um change stale não pode ser aceito (`code: 'stale'`) e pode ser dispensado
(`reject`). Nota: `accept_edited` **não** resolve um stale, porque a verificação usa a mesma `baseVersion` do
change original; editar as operações não muda a base. Hoje, a resolução manual é submeter um novo change humano.

**Opções (nenhuma implementada):**

- **(a) Nova execução de AI** com a mesma instrução sobre o snapshot atual, restrita ao escopo do change stale.
  Gera um novo change set e liga o novo change ao antigo (`reprocessed_from`). Custa uma chamada ao provedor.
- **(b) Rebase mecânico:** reaplicar as mesmas operações sobre o head quando as mudanças posteriores não colidem
  com o que o change assume; revalidar e criar um novo change com `baseVersion = head`. Sem custo de AI, mas
  exige definir o que é "colisão" (basta o `before` bater?).
- **(c) Resolução manual com rebase explícito:** permitir que `accept_edited` declare uma nova base depois de o
  usuário ver o conflito.

Perguntas que a decisão precisa responder: o reprocessamento herda a revisão (por exemplo, adiamentos)? Aparece
nas métricas como taxa própria? O change stale original é dispensado automaticamente?

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
