import { z } from 'zod';
import type { Impact } from './types';

// ---- Tipos do Project Schema (dado, versionado) --------------------------------------------

export interface BasisRule {
  evidenceMin: number;
  orJustification?: boolean;
  statementMin?: number; // padrão: 20 (agente) / 10 (humano)
  basedOnMin?: number; // padrão: 1 (agente) / 0 (humano)
  basedOnMustInclude?: Array<'from' | 'to'>; // só em relações
  countsExisting?: boolean; // evidências já ancoradas no item contam
}
/** Regra por origem; a específica vence `any`. */
export interface BasisSpec {
  agent?: BasisRule;
  human?: BasisRule;
  any?: BasisRule;
}
export interface FieldDef {
  type: 'string' | 'text' | 'number' | 'boolean' | 'enum';
  required?: boolean;
  values?: string[];
}
export interface ItemTypeDef {
  statuses: string[];
  body: 'inline' | 'content';
  impact: Impact;
  provisionalStatus?: string;
  creation: { agent: string[]; human: string[] };
  basis?: BasisSpec;
  promotion?: { basis: BasisSpec };
  fields?: Record<string, FieldDef>;
}
export interface RelationTypeDef {
  from?: string[];
  to?: string[];
  sameType?: boolean;
  impact: Impact;
  basis?: BasisSpec;
  fields?: Record<string, FieldDef>;
}
export interface TransitionDef {
  type: string;
  from: string;
  to: string;
  requires: 'explicit';
}
export interface ProjectSchema {
  key: string;
  version: number;
  itemTypes: Record<string, ItemTypeDef>;
  transitions: TransitionDef[];
  relationTypes: Record<string, RelationTypeDef>;
  review: { batchEligibleImpact: Impact[]; maxChangesPerSet: number };
  migrations: unknown[]; // reservado
}

// ---- Validação da FORMA (zod) ---------------------------------------------------------------

const ImpactZ = z.enum(['low', 'medium', 'high']);
const BasisRuleZ = z
  .object({
    evidenceMin: z.number().int().min(0),
    orJustification: z.boolean().optional(),
    statementMin: z.number().int().min(0).optional(),
    basedOnMin: z.number().int().min(0).optional(),
    basedOnMustInclude: z.array(z.enum(['from', 'to'])).optional(),
    countsExisting: z.boolean().optional(),
  })
  .strict();
const BasisSpecZ = z
  .object({
    agent: BasisRuleZ.optional(),
    human: BasisRuleZ.optional(),
    any: BasisRuleZ.optional(),
  })
  .strict();
const FieldDefZ = z
  .object({
    type: z.enum(['string', 'text', 'number', 'boolean', 'enum']),
    required: z.boolean().optional(),
    values: z.array(z.string()).optional(),
  })
  .strict();
const ItemTypeZ = z
  .object({
    statuses: z.array(z.string().min(1)).min(1),
    body: z.enum(['inline', 'content']),
    impact: ImpactZ,
    provisionalStatus: z.string().optional(),
    creation: z.object({ agent: z.array(z.string()), human: z.array(z.string()) }).strict(),
    basis: BasisSpecZ.optional(),
    promotion: z.object({ basis: BasisSpecZ }).strict().optional(),
    fields: z.record(z.string(), FieldDefZ).optional(),
  })
  .strict();
const RelationTypeZ = z
  .object({
    from: z.array(z.string()).optional(),
    to: z.array(z.string()).optional(),
    sameType: z.boolean().optional(),
    impact: ImpactZ,
    basis: BasisSpecZ.optional(),
    fields: z.record(z.string(), FieldDefZ).optional(),
  })
  .strict();
const TransitionZ = z
  .object({
    type: z.string(),
    from: z.string(),
    to: z.string(),
    requires: z.literal('explicit'),
  })
  .strict();
const ProjectSchemaZ = z
  .object({
    key: z.string().min(1),
    version: z.number().int().min(1),
    itemTypes: z.record(z.string(), ItemTypeZ),
    transitions: z.array(TransitionZ),
    relationTypes: z.record(z.string(), RelationTypeZ),
    review: z
      .object({
        batchEligibleImpact: z.array(ImpactZ),
        maxChangesPerSet: z.number().int().min(1),
      })
      .strict(),
    migrations: z.array(z.unknown()),
  })
  .strict();

// ---- Validação de referências cruzadas -------------------------------------------------------

export interface SchemaIssue {
  path: string;
  message: string;
}
export type ParseResult =
  | { ok: true; schema: ProjectSchema }
  | { ok: false; issues: SchemaIssue[] };

function crossValidate(s: ProjectSchema): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const typeNames = Object.keys(s.itemTypes);
  if (typeNames.length === 0) add('itemTypes', 'deve declarar ao menos um tipo de item');

  const checkFields = (path: string, fields?: Record<string, FieldDef>) => {
    for (const [name, def] of Object.entries(fields ?? {})) {
      if (def.type === 'enum' && (!def.values || def.values.length === 0)) {
        add(`${path}.fields.${name}`, 'campo enum exige values');
      }
    }
  };
  const checkSpec = (path: string, spec: BasisSpec | undefined, relation: boolean) => {
    for (const k of ['agent', 'human', 'any'] as const) {
      const rule = spec?.[k];
      if (rule?.basedOnMustInclude && !relation) {
        add(`${path}.${k}`, 'basedOnMustInclude só vale em tipos de relação');
      }
    }
  };

  for (const [name, t] of Object.entries(s.itemTypes)) {
    const p = `itemTypes.${name}`;
    if (new Set(t.statuses).size !== t.statuses.length) add(`${p}.statuses`, 'status duplicados');
    if (t.provisionalStatus !== undefined && !t.statuses.includes(t.provisionalStatus)) {
      add(`${p}.provisionalStatus`, 'deve estar em statuses');
    }
    for (const origin of ['agent', 'human'] as const) {
      for (const st of t.creation[origin]) {
        if (!t.statuses.includes(st)) add(`${p}.creation.${origin}`, `status desconhecido: ${st}`);
      }
    }
    checkSpec(`${p}.basis`, t.basis, false);
    checkSpec(`${p}.promotion.basis`, t.promotion?.basis, false);
    checkFields(p, t.fields);
    if (t.provisionalStatus !== undefined) {
      for (const st of t.statuses) {
        if (st === t.provisionalStatus) continue;
        const declared = s.transitions.some(
          (tr) => tr.type === name && tr.from === t.provisionalStatus && tr.to === st,
        );
        if (!declared) {
          add(
            `${p}`,
            `sair de ${t.provisionalStatus} para ${st} deve estar declarado em transitions (explicit)`,
          );
        }
      }
    }
  }

  s.transitions.forEach((tr, i) => {
    const t = s.itemTypes[tr.type];
    const p = `transitions.${i}`;
    if (!t) return add(p, `tipo desconhecido: ${tr.type}`);
    if (!t.statuses.includes(tr.from)) add(p, `status desconhecido: ${tr.from}`);
    if (!t.statuses.includes(tr.to)) add(p, `status desconhecido: ${tr.to}`);
  });

  for (const [name, r] of Object.entries(s.relationTypes)) {
    const p = `relationTypes.${name}`;
    const hasEnds = r.from !== undefined && r.to !== undefined;
    if (r.sameType && (r.from !== undefined || r.to !== undefined)) {
      add(p, 'sameType não combina com from/to');
    } else if (!r.sameType && !(hasEnds && r.from!.length > 0 && r.to!.length > 0)) {
      add(p, 'declare sameType ou from e to não vazios');
    }
    for (const t of [...(r.from ?? []), ...(r.to ?? [])]) {
      if (!Object.hasOwn(s.itemTypes, t)) add(p, `tipo de item desconhecido: ${t}`);
    }
    checkSpec(`${p}.basis`, r.basis, true);
    checkFields(p, r.fields);
  }
  return issues;
}

export function parseProjectSchema(input: unknown): ParseResult {
  const parsed = ProjectSchemaZ.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i: { path: ReadonlyArray<PropertyKey>; message: string }) => ({
        path: i.path.map((p) => String(p)).join('.'),
        message: i.message,
      })),
    };
  }
  const schema = parsed.data as unknown as ProjectSchema;
  const issues = crossValidate(schema);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, schema };
}

export function assertProjectSchema(input: unknown): ProjectSchema {
  const r = parseProjectSchema(input);
  if (!r.ok) {
    throw new Error('Project Schema inválido: ' + r.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
  }
  return r.schema;
}
