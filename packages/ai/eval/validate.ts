import { ITEM_TYPES, type EvalData, type GoldPair } from './types';
import { locate, overlap } from './locate';

/** Problemas do gabarito. Lista vazia = o gabarito é coerente com as fontes. */
export function validateGold(data: EvalData): string[] {
  const out: string[] = [];
  const keys = new Map<string, string>();
  const itemKeys = new Set<string>();
  const claim = (key: string, where: string) => {
    if (key.trim() === '') out.push(`${where}: chave vazia`);
    const prev = keys.get(key);
    if (prev !== undefined) out.push(`${where}: chave duplicada "${key}" (já usada em ${prev})`);
    else keys.set(key, where);
  };

  const ids = new Set<string>();
  for (const g of data.golds) {
    const at = (s: string) => `${g.source}: ${s}`;
    if (ids.has(g.source)) out.push(at('fonte duplicada'));
    ids.add(g.source);
    const text = data.sources[g.source];
    if (text === undefined) {
      out.push(at('texto da fonte não carregado'));
      continue;
    }
    const itemSpans: Array<{ key: string; start: number; end: number }> = [];

    for (const it of g.items) {
      claim(it.key, at(`item ${it.key}`));
      itemKeys.add(it.key);
      if (!ITEM_TYPES.includes(it.type)) out.push(at(`${it.key}: tipo inválido "${String(it.type)}"`));
      if (it.statement.trim() === '') out.push(at(`${it.key}: statement vazio`));
      if (it.quotes.length === 0) out.push(at(`${it.key}: sem citação`));
      for (const q of it.quotes) {
        const spans = locate(text, q);
        if (spans.length === 0) out.push(at(`${it.key}: citação não existe na fonte: "${q}"`));
        else if (it.repeated === true && spans.length < 2) out.push(at(`${it.key}: marcado como repetido, mas aparece ${spans.length} vez`));
        else if (it.repeated !== true && spans.length > 1) out.push(at(`${it.key}: citação aparece ${spans.length} vezes e não está marcada como repetida`));
        for (const s of spans) itemSpans.push({ key: it.key, ...s });
      }
    }

    for (const t of g.traps) {
      claim(t.key, at(`armadilha ${t.key}`));
      if (t.types.length === 0) out.push(at(`${t.key}: armadilha sem tipos`));
      for (const ty of t.types) if (!ITEM_TYPES.includes(ty)) out.push(at(`${t.key}: tipo inválido "${String(ty)}"`));
      if (t.quotes.length === 0) out.push(at(`${t.key}: sem citação`));
      if (t.reason.trim() === '') out.push(at(`${t.key}: sem motivo`));
      for (const q of t.quotes) if (locate(text, q).length === 0) out.push(at(`${t.key}: citação não existe na fonte: "${q}"`));
    }

    for (const inj of g.injections) {
      claim(inj.key, at(`injeção ${inj.key}`));
      const spans = locate(text, inj.quote);
      if (spans.length !== 1) out.push(at(`${inj.key}: citação deve aparecer exatamente uma vez (aparece ${spans.length})`));
      if (inj.signatures.length === 0) out.push(at(`${inj.key}: sem assinaturas`));
      for (const sg of inj.signatures) if (sg !== sg.toLowerCase() || sg.trim() === '') out.push(at(`${inj.key}: assinatura deve ser não vazia e em minúsculas: "${sg}"`));
      for (const s of spans) {
        for (const it of itemSpans) {
          if (overlap(s, it) > 0) out.push(at(`${inj.key}: a injeção se sobrepõe ao item ${it.key}`));
        }
      }
    }
  }

  const known = (k: string, where: string) => {
    if (!itemKeys.has(k)) out.push(`relações: ${where}: chave "${k}" não é um item do gabarito`);
  };
  const unordered = (p: GoldPair) => [p.a, p.b].sort().join('|');
  const seen = new Map<string, string>();
  const pairs = (list: GoldPair[], label: string) => {
    for (const p of list) {
      known(p.a, label);
      known(p.b, label);
      if (p.a === p.b) out.push(`relações: ${label}: par de um item com ele mesmo (${p.a})`);
      if (p.note.trim() === '') out.push(`relações: ${label}: ${p.a}/${p.b} sem nota`);
      const k = unordered(p);
      const prev = seen.get(k);
      if (prev !== undefined) out.push(`relações: o par ${p.a}/${p.b} está em ${prev} e em ${label}`);
      else seen.set(k, label);
    }
  };
  pairs(data.relations.contradictions, 'contradictions');
  pairs(data.relations.near_misses, 'near_misses');
  for (const group of data.relations.duplicates) {
    if (new Set(group).size < 2) out.push('relações: grupo de duplicatas precisa de pelo menos 2 itens distintos');
    for (const k of group) known(k, 'duplicates');
  }
  return out;
}

/** Os casos que o conjunto precisa cobrir (escopo, seção 6). Cada um é verdadeiro ou falso. */
export function coverageCases(data: EvalData): Record<string, boolean> {
  const allQuotes = data.golds.flatMap((g) => [
    ...g.items.flatMap((i) => i.quotes),
    ...g.traps.flatMap((t) => t.quotes),
  ]);
  const hedgeTrap = data.golds.some((g) =>
    g.traps.some((t) => /hedge|conditional|hypothesis/i.test(t.reason)),
  );
  return {
    'sete fontes': data.golds.length === 7,
    'contradição real': data.relations.contradictions.length > 0,
    'falso alarme (quase-contradição)': data.relations.near_misses.length > 0,
    'afirmação duplicada': data.relations.duplicates.length > 0,
    'contradição entre fontes diferentes': data.relations.contradictions.some((p) => p.a.split('.')[0] !== p.b.split('.')[0]),
    'citação ambígua (trecho repetido)': data.golds.some((g) => g.items.some((i) => i.repeated === true)),
    'injeção de prompt': data.golds.some((g) => g.injections.length > 0),
    'armadilha de opinião sem fonte': data.golds.some((g) => g.traps.some((t) => /marketing|opinion|promotional|unverifiable|anecdotal/i.test(t.reason))),
    'negação': data.golds.some((g) => g.items.some((i) => /\bnot\b/.test(i.quotes.join(' ')) && /negation/i.test(i.note ?? ''))),
    'ressalva transformada em fato (armadilha)': hedgeTrap,
    'espaço duro (U+00A0) em citação': allQuotes.some((q) => q.includes(' ')),
    'hifenização com quebra de linha': allQuotes.some((q) => /-\n/.test(q)),
    'unidades diferentes sem conflito': data.relations.near_misses.some((p) => /unit/i.test(p.note)),
    'tipo pergunta': data.golds.some((g) => g.items.some((i) => i.type === 'question')),
    'tipo premissa': data.golds.some((g) => g.items.some((i) => i.type === 'assumption')),
    'tipo decisão': data.golds.some((g) => g.items.some((i) => i.type === 'decision')),
    'decisão proposta mas não decidida (armadilha)': data.golds.some((g) => g.traps.some((t) => t.types.includes('decision'))),
  };
}
