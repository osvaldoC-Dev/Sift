/** Tipos do conjunto de avaliação da IA (Marco 3.1). Sem modelo: só fontes, gabarito e pontuação. */

export type ItemType = 'claim' | 'assumption' | 'question' | 'decision';
export const ITEM_TYPES: readonly ItemType[] = ['claim', 'assumption', 'question', 'decision'];

export interface GoldItem {
  /** Chave única em TODO o conjunto (ex.: `arch.billing-least-coupled`). */
  key: string;
  type: ItemType;
  /** Paráfrase de referência, para quem lê o gabarito. Não é usada no casamento. */
  statement: string;
  /** Trechos literais da fonte (as posições são calculadas pelo código, nunca escritas à mão). */
  quotes: string[];
  /** O trecho aparece mais de uma vez na fonte; qualquer ocorrência vale. */
  repeated?: boolean;
  note?: string;
}

/** O que NÃO deve ser extraído como tal. Atinge a armadilha quem cita o trecho com um dos `types`. */
export interface GoldTrap {
  key: string;
  types: ItemType[];
  quotes: string[];
  reason: string;
}

/** Instrução embutida na fonte. Obedecê-la, ou citá-la, é falha grave. */
export interface GoldInjection {
  key: string;
  quote: string;
  /** Fragmentos em minúsculas: se aparecem no texto ou na citação de um item previsto, a instrução foi obedecida. */
  signatures: string[];
  description: string;
}

export interface GoldSource {
  source: string;
  /** Caminho do texto da fonte, relativo a `eval/`. */
  file: string;
  items: GoldItem[];
  traps: GoldTrap[];
  injections: GoldInjection[];
}

export interface GoldPair {
  a: string;
  b: string;
  note: string;
}
/** Relações entre itens (podem cruzar fontes). A pontuação delas é da Fase B; aqui só são validadas. */
export interface GoldRelations {
  contradictions: GoldPair[];
  near_misses: GoldPair[];
  duplicates: string[][];
}

export interface Prediction {
  sourceId: string;
  type: ItemType;
  text: string;
  /** Citação literal copiada da fonte; vazia = sem citação. */
  quote: string;
}

export interface EvalData {
  golds: GoldSource[];
  relations: GoldRelations;
  /** Texto bruto de cada fonte, por `source`. */
  sources: Record<string, string>;
}
