import { applyInto, InvariantError } from './apply';
import { canonicalize } from './canonical';
import type { BasisRule, BasisSpec, FieldDef, ProjectSchema, TransitionDef } from './schema';
import { cloneState } from './state';
import type {
  Attrs, BasisKind, Change, ChangeDraft, Impact, ItemId, Operation, Origin, State,
} from './types';

export type IssueCode =
  | 'schema_mismatch' | 'no_operations' | 'missing_rationale' | 'base_version_invalid'
  | 'unknown_item_type' | 'unknown_relation_type' | 'unknown_status'
  | 'item_exists' | 'relation_exists' | 'item_missing' | 'relation_missing' | 'item_retired'
  | 'status_not_allowed_on_creation' | 'body_mismatch'
  | 'unknown_attribute' | 'missing_attribute' | 'invalid_attribute'
  | 'before_mismatch' | 'empty_patch' | 'patch_not_allowed' | 'no_change'
  | 'endpoint_type_not_allowed' | 'self_relation' | 'reason_missing'
  | 'basis_missing' | 'evidence_malformed' | 'derived_mismatch' | 'invariant';

export interface Issue {
  code: IssueCode;
  message: string;
  opIndex?: number;
}

export interface Analysis {
  issues: Issue[];
  impact: Impact;
  basisKind: BasisKind;
  explicitTransitions: TransitionDef[];
  promotions: number;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const RANK: Record<Impact, number> = { low: 0, medium: 1, high: 2 };

const own = <T>(obj: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(obj, key) ? obj[key] : undefined;
const eq = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined ? a === b : canonicalize(a) === canonicalize(b);

// ---- basis ------------------------------------------------------------------------------------

type BasisVia = 'none' | 'evidence' | 'justification';

function pickRule(spec: BasisSpec | undefined, origin: Origin): BasisRule | undefined {
  return spec ? (spec[origin.kind] ?? spec.any) : undefined;
}

function justificationOk(
  rule: BasisRule,
  op: Operation,
  work: State,
  origin: Origin,
  ends?: { from: ItemId; to: ItemId },
): boolean {
  const j = op.justification;
  if (!j) return false;
  const agent = origin.kind === 'agent';
  if (j.statement.trim().length < (rule.statementMin ?? (agent ? 20 : 10))) return false;
  const ids = new Set(j.basedOn);
  if (ids.size < (rule.basedOnMin ?? (agent ? 1 : 0))) return false;
  for (const id of ids) {
    const it = work.items.get(id);
    if (!it || it.retired) return false;
  }
  for (const side of rule.basedOnMustInclude ?? []) {
    const id = ends?.[side];
    if (!id || !ids.has(id)) return false;
  }
  return true;
}

/** undefined = regra não satisfeita. */
function evalBasis(
  rule: BasisRule | undefined,
  op: Operation,
  work: State,
  origin: Origin,
  existingEvidence: number,
  ends?: { from: ItemId; to: ItemId },
): BasisVia | undefined {
  if (!rule || rule.evidenceMin === 0) return 'none';
  const count = op.evidence.length + (rule.countsExisting ? existingEvidence : 0);
  if (count >= rule.evidenceMin) return 'evidence';
  if (rule.orJustification && justificationOk(rule, op, work, origin, ends)) return 'justification';
  return undefined;
}

// ---- atributos --------------------------------------------------------------------------------

function checkAttributes(
  attrs: Attrs,
  fields: Record<string, FieldDef> | undefined,
  report: (code: IssueCode, message: string) => void,
): void {
  const defs = fields ?? {};
  for (const k of Object.keys(attrs)) {
    if (!Object.hasOwn(defs, k)) report('unknown_attribute', `atributo desconhecido: ${k}`);
  }
  for (const [k, d] of Object.entries(defs)) {
    const v = attrs[k];
    if (v === undefined) {
      if (d.required) report('missing_attribute', `atributo obrigatório ausente: ${k}`);
      continue;
    }
    let ok: boolean;
    switch (d.type) {
      case 'string':
      case 'text':
        ok = typeof v === 'string' && (!d.required || v.trim().length > 0);
        break;
      case 'number':
        ok = typeof v === 'number' && Number.isFinite(v);
        break;
      case 'boolean':
        ok = typeof v === 'boolean';
        break;
      case 'enum':
        ok = typeof v === 'string' && (d.values ?? []).includes(v);
        break;
    }
    if (!ok) report('invalid_attribute', `valor inválido para ${k}`);
  }
}

// ---- análise do change ------------------------------------------------------------------------

interface OpResult {
  impact?: Impact;
  via?: BasisVia;
  promotion?: boolean;
  explicit?: TransitionDef;
}

/**
 * Valida o change contra o schema e o estado informado, simulando as operações em ordem
 * (uma operação pode referenciar itens criados antes dela no mesmo change) e calcula os campos
 * derivados: impacto, basisKind e transições explícitas.
 */
export function analyzeChange(schema: ProjectSchema, state: State, change: Change): Analysis {
  const issues: Issue[] = [];
  const report = (code: IssueCode, message: string, opIndex?: number) =>
    issues.push({ code, message, opIndex });

  if (change.schemaRef.key !== schema.key || change.schemaRef.version !== schema.version) {
    report('schema_mismatch', 'schemaRef não corresponde ao schema do projeto');
  }
  if (change.operations.length === 0) report('no_operations', 'o change não tem operações');
  if (change.rationale.trim() === '') report('missing_rationale', 'justificativa do change vazia');
  if (!Number.isInteger(change.baseVersion) || change.baseVersion < 0 || change.baseVersion > state.version) {
    report('base_version_invalid', `baseVersion ${change.baseVersion} inválida (head ${state.version})`);
  }

  let impact: Impact = 'low';
  let anyEvidence = false;
  let anyJustification = false;
  let promotions = 0;
  const explicit: TransitionDef[] = [];
  const work = cloneState(state);
  const meta = { version: state.version + 1, changeId: change.id, origin: change.origin };
  const origin = change.origin;

  const checkOp = (op: Operation, i: number): OpResult => {
    const rep = (code: IssueCode, message: string) => report(code, message, i);

    for (const ev of op.evidence) {
      const ok =
        HASH_RE.test(ev.contentHash) &&
        Number.isInteger(ev.start) && Number.isInteger(ev.end) &&
        ev.start >= 0 && ev.end > ev.start && ev.quote.length > 0;
      if (!ok) rep('evidence_malformed', 'evidência malformada');
    }

    switch (op.op) {
      case 'create_item': {
        const t = own(schema.itemTypes, op.type);
        if (!t) {
          rep('unknown_item_type', `tipo de item desconhecido: ${op.type}`);
          return {};
        }
        if (work.items.has(op.itemId)) rep('item_exists', `item já existe: ${op.itemId}`);
        if (!t.creation[origin.kind].includes(op.status)) {
          rep('status_not_allowed_on_creation', `status ${op.status} não permitido na criação por ${origin.kind}`);
        }
        if (t.body === 'inline') {
          if (typeof op.content !== 'string' || op.content.trim() === '' || op.contentHash !== undefined) {
            rep('body_mismatch', 'tipo inline exige content não vazio e sem contentHash');
          }
        } else if (op.contentHash === undefined || !HASH_RE.test(op.contentHash) || op.content !== undefined) {
          rep('body_mismatch', 'tipo content exige contentHash válido e sem content');
        }
        checkAttributes(op.attributes, t.fields, rep);
        const via = evalBasis(pickRule(t.basis, origin), op, work, origin, 0);
        if (via === undefined) rep('basis_missing', `base (evidência ou justificativa) insuficiente para criar ${op.type}`);
        return { impact: t.impact, via };
      }

      case 'update_item': {
        const item = work.items.get(op.itemId);
        if (!item) {
          rep('item_missing', `item inexistente: ${op.itemId}`);
          return {};
        }
        if (item.retired) rep('item_retired', `item aposentado: ${op.itemId}`);
        const t = own(schema.itemTypes, item.type);
        if (!t) {
          rep('unknown_item_type', `tipo de item desconhecido: ${item.type}`);
          return { impact: 'high' };
        }
        const patch = op.patch as Record<string, unknown>;
        const before = op.before as Record<string, unknown>;
        const patchKeys = Object.keys(patch).filter((k) => patch[k] !== undefined);
        const beforeKeys = Object.keys(before).filter((k) => before[k] !== undefined);
        if (patchKeys.length === 0) rep('empty_patch', 'patch vazio');
        for (const k of patchKeys) {
          if (!['status', 'content', 'contentHash', 'attributes'].includes(k)) {
            rep('patch_not_allowed', `campo não atualizável: ${k}`);
          }
        }
        if ([...patchKeys].sort().join() !== [...beforeKeys].sort().join()) {
          rep('before_mismatch', 'before deve ter as mesmas chaves do patch');
        } else {
          const current: Record<string, unknown> = {
            status: item.status, content: item.content,
            contentHash: item.contentHash, attributes: item.attributes,
          };
          for (const k of beforeKeys) {
            if (!eq(before[k], current[k])) rep('before_mismatch', `before.${k} difere do estado atual`);
          }
        }
        const p = op.patch;
        if (p.status !== undefined) {
          if (!t.statuses.includes(p.status)) rep('unknown_status', `status desconhecido: ${p.status}`);
          else if (p.status === item.status) rep('no_change', 'status já é esse');
        }
        if (p.content !== undefined && (t.body !== 'inline' || p.content.trim() === '')) {
          rep('patch_not_allowed', 'content só em tipos inline e não vazio');
        }
        if (p.contentHash !== undefined && (t.body !== 'content' || !HASH_RE.test(p.contentHash))) {
          rep('patch_not_allowed', 'contentHash só em tipos content e válido');
        }
        if (p.attributes !== undefined) checkAttributes(p.attributes, t.fields, rep);

        const result: OpResult = { impact: t.impact };
        if (
          p.status !== undefined && t.provisionalStatus !== undefined &&
          item.status === t.provisionalStatus && p.status !== t.provisionalStatus
        ) {
          result.promotion = true;
          result.via = evalBasis(
            pickRule(t.promotion?.basis, origin), op, work, origin, item.evidence.length,
          );
          if (result.via === undefined) rep('basis_missing', 'promoção exige evidência ou justificativa');
        }
        if (p.status !== undefined) {
          result.explicit = schema.transitions.find(
            (tr) => tr.type === item.type && tr.from === item.status && tr.to === p.status,
          );
        }
        return result;
      }

      case 'create_relation': {
        const rt = own(schema.relationTypes, op.type);
        if (!rt) {
          rep('unknown_relation_type', `tipo de relação desconhecido: ${op.type}`);
          return {};
        }
        if (work.relations.has(op.relationId)) rep('relation_exists', `relação já existe: ${op.relationId}`);
        const from = work.items.get(op.from);
        const to = work.items.get(op.to);
        if (!from || !to) {
          rep('item_missing', 'extremo da relação inexistente');
          return { impact: rt.impact };
        }
        if (from.retired || to.retired) rep('item_retired', 'extremo da relação aposentado');
        if (op.from === op.to) rep('self_relation', 'relação com o mesmo item nos dois extremos');
        const typesOk = rt.sameType
          ? from.type === to.type
          : (rt.from ?? []).includes(from.type) && (rt.to ?? []).includes(to.type);
        if (!typesOk) rep('endpoint_type_not_allowed', `tipos ${from.type} → ${to.type} não permitidos em ${op.type}`);
        checkAttributes(op.attributes, rt.fields, rep);
        const via = evalBasis(pickRule(rt.basis, origin), op, work, origin, 0, { from: op.from, to: op.to });
        if (via === undefined) rep('basis_missing', `base insuficiente para a relação ${op.type}`);
        return { impact: rt.impact, via };
      }

      case 'retire': {
        const cur =
          op.target.kind === 'item' ? work.items.get(op.target.id) : work.relations.get(op.target.id);
        if (!cur) {
          rep(op.target.kind === 'item' ? 'item_missing' : 'relation_missing', 'alvo inexistente');
          return {};
        }
        if (op.reason.trim() === '') rep('reason_missing', 'motivo vazio');
        if (cur.retired === op.retired) rep('no_change', 'o alvo já está nesse estado');
        const def =
          op.target.kind === 'item'
            ? own(schema.itemTypes, cur.type)
            : own(schema.relationTypes, cur.type);
        return { impact: def?.impact ?? 'high' };
      }
    }
  };

  for (let i = 0; i < change.operations.length; i++) {
    const op = change.operations[i]!;
    const before = issues.length;
    const r = checkOp(op, i);
    if (r.impact !== undefined && RANK[r.impact] > RANK[impact]) impact = r.impact;
    if (r.via === 'evidence') anyEvidence = true;
    if (r.via === 'justification') anyJustification = true;
    if (r.promotion) promotions++;
    if (r.explicit) explicit.push(r.explicit);
    if (issues.length > before) break; // não simula depois da primeira operação inválida
    try {
      applyInto(work.items, work.relations, op, meta);
    } catch (e) {
      if (e instanceof InvariantError) {
        report('invariant', e.message, i);
        break;
      }
      throw e;
    }
  }

  const basisKind: BasisKind = anyJustification ? 'justification_only' : anyEvidence ? 'evidence' : 'none';
  return { issues, impact, basisKind, explicitTransitions: explicit, promotions };
}

/** Lista de problemas; vazia = válido. Os campos derivados do change devem bater com a análise. */
export function validateChange(schema: ProjectSchema, state: State, change: Change): Issue[] {
  const a = analyzeChange(schema, state, change);
  const issues = [...a.issues];
  if (issues.length === 0 && (change.impact !== a.impact || change.basisKind !== a.basisKind)) {
    issues.push({
      code: 'derived_mismatch',
      message: `impact/basisKind gravados (${change.impact}/${change.basisKind}) diferem dos calculados (${a.impact}/${a.basisKind})`,
    });
  }
  return issues;
}

/** Completa o rascunho com os campos derivados. Quem propõe nunca os define. */
export function prepareChange(
  schema: ProjectSchema,
  state: State,
  draft: ChangeDraft,
): { change: Change; analysis: Analysis; issues: Issue[] } {
  const provisional: Change = { ...draft, impact: 'low', basisKind: 'none' };
  const analysis = analyzeChange(schema, state, provisional);
  return {
    change: { ...draft, impact: analysis.impact, basisKind: analysis.basisKind },
    analysis,
    issues: analysis.issues,
  };
}
