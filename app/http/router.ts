// A small router on node:http. Every route the app answers is registered through here, so the whole
// surface is readable from app/modules/*/routes.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Scope } from './scopes.ts';

export interface SessionUser {
  id: string;
  handle: string;
  status: 'active' | 'suspended' | 'deleted';
  /** The staff role the person holds now (ended roles count as none), or null. */
  staffRole: string | null;
  /** What that role lets them do (decision 0009). Empty for members. */
  scopes: Scope[];
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  db: Db;
  config: Config;
  /** The signed-in person, or null. Use requireUser(ctx) in handlers that need one. */
  user: SessionUser | null;
  /** The client address (X-Forwarded-For only when config.trustProxy). */
  ip: string;
  /** Parsed JSON body (max 64 KB); throws HttpError 400 on bad JSON. */
  json<T = Record<string, unknown>>(): Promise<T>;
  /** Raw body bytes (max given, default 4 MB), for uploads. */
  raw(max?: number): Promise<Buffer>;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer | object | null;
}

export type Handler = (ctx: Ctx) => Promise<Reply> | Reply;

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Reply => ({ status, headers, body: body as object });
export const noContent = (): Reply => ({ status: 204 });
export const fail = (status: number, code: string, message?: string): never => { throw new HttpError(status, code, message); };

interface Route { method: string; parts: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];
  add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
  }
  get(path: string, h: Handler) { this.add('GET', path, h); }
  post(path: string, h: Handler) { this.add('POST', path, h); }
  put(path: string, h: Handler) { this.add('PUT', path, h); }
  patch(path: string, h: Handler) { this.add('PATCH', path, h); }
  delete(path: string, h: Handler) { this.add('DELETE', path, h); }

  /** Match `/a/:id/b`; returns the handler and params, or null. HEAD falls back to GET. */
  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const segs = pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return '\u0000'; } });
    const want = method === 'HEAD' ? 'GET' : method;
    for (const r of this.routes) {
      if (r.method !== want || r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i] as string, s = segs[i] as string;
        if (p.startsWith(':')) params[p.slice(1)] = s;
        else if (p !== s) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }

  /** Every registered route, for the API listing test. */
  list(): string[] { return this.routes.map((r) => `${r.method} /${r.parts.join('/')}`); }
}

/** UUID check for path params. */
export const isUuid = (s: string | undefined): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
