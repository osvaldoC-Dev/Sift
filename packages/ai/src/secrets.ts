/**
 * Remove segredos de qualquer texto que possa sair do processo (erro, log, relatório, gravação).
 * Troca cada ocorrência literal dos segredos (e da forma `Bearer <segredo>`) por `[redigido]`.
 * Segredos curtos demais (< 8 caracteres) são ignorados para não estragar o texto à toa.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 8) continue;
    out = out.split(s).join('[redigido]');
  }
  return out;
}
