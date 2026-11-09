# @sift/contract
Formato JSON entre a API e a interface (zod, `.strict()`). Sem lógica de domínio. 20 testes + 5 mutações apanhadas.
Mudanças aqui só pelo Claude 1 ou com o OK dele: API e interface dependem disto. Se algo não chega, pede a alteração; não contornes.
A interface não calcula elegibilidade nem verificação: recebe `canAccept`, `canReject`, `canBatchAccept` e `quote.found` prontos.
