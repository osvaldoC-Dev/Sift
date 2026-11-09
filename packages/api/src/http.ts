import {
  ApiError, ResponseSchemas, Routes, checkProposalInvariants,
  type ProposalView, type BlockCode,
} from '@sift/contract';


/** Pedido já separado do transporte: o servidor Node e os testes montam o mesmo objeto. */
export interface ApiRequest {
  method: string;
  /** Caminho sem query string. */
  path: string;
  query?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  /** Corpo já interpretado (testes) ou texto bruto (servidor); o texto é lido como JSON. */
  body?: unknown;
  rawBody?: string;
}
export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type ApiErrorBody = ReturnType<typeof ApiError.parse>;
export type ApiErrorCode = ApiErrorBody['code'];

export const STATUS_OF: Record<ApiErrorCode, number> = {
  not_found: 404, invalid_request: 400, not_allowed: 409, stale: 409, conflict: 409, internal: 500,
};

/** Erro que vira resposta `ApiError`. Nunca carrega pilha nem texto de fonte. */
export class HttpError extends Error {
  constructor(readonly code: ApiErrorCode, message: string, readonly block?: BlockCode) {
    super(message);
  }
}
export const fail = (code: ApiErrorCode, message: string, block?: BlockCode): HttpError =>
  new HttpError(code, message, block);

/** Rota do contrato compilada: `POST /projects/:projectId/sources` -> método + segmentos. */
export interface CompiledRoute {
  key: keyof typeof Routes;
  method: string;
  segments: string[];
}
export function compileRoutes(): CompiledRoute[] {
  return (Object.entries(Routes) as [keyof typeof Routes, string][]).map(([key, spec]) => {
    const [method, rest] = spec.split(' ') as [string, string];
    const path = rest.split('?')[0]!;
    return { key, method, segments: path.split('/').filter((s) => s !== '') };
  });
}

export function matchRoute(
  routes: readonly CompiledRoute[], method: string, path: string,
): { route: CompiledRoute; params: Record<string, string> } | undefined {
  const parts = path.split('/').filter((s) => s !== '');
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    route.segments.forEach((seg, idx) => {
      const part = parts[idx]!;
      if (seg.startsWith(':')) {
        let decoded = part;
        try { decoded = decodeURIComponent(part); } catch { ok = false; }
        params[seg.slice(1)] = decoded;
      } else if (seg !== part) ok = false;
    });
    if (ok) return { route, params };
  }
  return undefined;
}

type Schema = { safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: { issues: { path: (string | number)[]; code: string }[] } } };

/** Só caminhos e códigos das falhas: nunca o valor recebido (pode ser texto de fonte). */
export function describeIssues(issues: readonly { path: (string | number)[]; code: string }[]): string {
  return issues.slice(0, 5).map((x) => `${x.path.join('.') || '(corpo)'}: ${x.code}`).join('; ');
}

export function parseBody<T>(schema: { safeParse(v: unknown): unknown }, body: unknown): T {
  const r = (schema as Schema).safeParse(body);
  if (!r.success) throw fail('invalid_request', `pedido inválido: ${describeIssues(r.error.issues)}`);
  return r.data as T;
}

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const;

export interface Emitter {
  /** Valida contra o schema do contrato e as invariantes das propostas ANTES de a resposta sair. */
  emit(schema: Schema, body: unknown, proposals: readonly ProposalView[], status?: number): ApiResponse;
  error(e: HttpError): ApiResponse;
}

export class ResponseInvalid extends Error {}

export function makeEmitter(onInvalid: (detail: string) => void): Emitter {
  return {
    emit(schema, body, proposals, status = 200) {
      const r = schema.safeParse(body);
      if (!r.success) {
        onInvalid(`schema: ${describeIssues(r.error.issues)}`);
        throw new ResponseInvalid('resposta fora do contrato');
      }
      for (const p of proposals) {
        const v = checkProposalInvariants(p);
        if (v.length > 0) {
          onInvalid(`invariantes: ${v.join(' | ')}`);
          throw new ResponseInvalid('proposta viola as invariantes do contrato');
        }
      }
      return { status, headers: { ...JSON_HEADERS }, body: r.data };
    },
    error(e) {
      const body = { code: e.code, message: e.message, ...(e.block !== undefined ? { block: e.block } : {}) };
      const r = ResponseSchemas.error.safeParse(body);
      const safe = r.success ? r.data : { code: 'internal' as const, message: 'erro interno' };
      return { status: STATUS_OF[safe.code], headers: { ...JSON_HEADERS }, body: safe };
    },
  };
}
