import type { ModelPort, ModelRequest, ModelResponse } from '@sift/ai';
import type { JsonValue } from '@sift/core';

/**
 * Extrator determinístico para a interface funcionar SEM fornecedor e SEM custo (`SIFT_MODEL=fake`).
 * Não "entende" nada: separa a passagem em frases e classifica por pistas simples. A citação de cada item é a frase
 * copiada à letra da passagem (o pipeline confere isso contra a fonte, como com qualquer modelo). O verificador
 * responde sempre `full`. Mesma entrada, mesma saída.
 */
const MAX_ITEMS = 6;
const MIN_LENGTH = 12;

const OPEN = /^<<<SIFT_SOURCE_\d+>>>$/;
const CLOSE = /^<<<END_SIFT_SOURCE_\d+>>>$/;

/** Passagem entre o marcador de abertura e o de fecho (o texto é dado, nunca instrução). */
function passageOf(content: string): string {
  const lines = content.split('\n');
  const from = lines.findIndex((l) => OPEN.test(l));
  let to = -1;
  for (let i = lines.length - 1; i > from; i--) if (CLOSE.test(lines[i]!)) { to = i; break; }
  return from < 0 || to < 0 ? '' : lines.slice(from + 1, to).join('\n');
}

function classify(sentence: string): 'question' | 'decision' | 'assumption' | 'claim' {
  if (sentence.endsWith('?')) return 'question';
  if (/\b(decid(ed|imos|iu)|we will|vamos)\b/i.test(sentence)) return 'decision';
  if (/\b(may|might|likely|assum(e|ed|imos)|talvez|provavelmente)\b/i.test(sentence)) return 'assumption';
  return 'claim';
}

function extract(passage: string): { type: string; statement: string; quote: string }[] {
  const items: { type: string; statement: string; quote: string }[] = [];
  for (const sentence of passage.split(/(?<=[.!?])\s+/)) {
    if (items.length >= MAX_ITEMS) break;
    if (sentence.length < MIN_LENGTH || !sentence.includes(' ')) continue;
    items.push({ type: classify(sentence), statement: sentence.replace(/\s+/g, ' ').trim(), quote: sentence });
  }
  return items;
}

const tokens = (s: string): number => Math.max(1, Math.ceil(s.length / 4));

export function createDemoModel(): ModelPort {
  return {
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const content = request.messages.map((m) => m.content).join('\n');
      const props = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
      const output: JsonValue = 'items' in props
        ? { items: extract(passageOf(content)) }
        : { verdict: 'full' };
      return {
        output, model: 'demo-heuristico',
        usage: { inputTokens: tokens(request.system + content), outputTokens: tokens(JSON.stringify(output)) },
      };
    },
  };
}
