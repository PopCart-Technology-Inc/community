// The HTTP server: /api/* through the router, the web app (app/web) with a fresh CSP nonce per page,
// the optional brand pack at /brand/*, and uploaded media at /media/:id.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { HttpError, Router, type Ctx, type Reply } from './http/router.ts';
import { baseHeaders, checkCsrf, newNonce, pageCsp } from './http/security.ts';
import { loadSession } from './http/session.ts';
import { registerAll } from './modules/index.ts';

const WEB = join(import.meta.dirname, 'web');
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return; // keep draining so the 413 reply reaches the client
      size += c.length;
      if (size > max) { over = true; chunks.length = 0; fail(new HttpError(413, 'too_large', 'Request body is too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) ok(Buffer.concat(chunks)); });
    req.on('error', fail);
  });
}

function send(res: ServerResponse, r: Reply): void {
  res.statusCode = r.status;
  for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
  if (r.body === undefined || r.body === null || r.status === 204) { res.end(); return; }
  if (typeof r.body === 'string' || Buffer.isBuffer(r.body)) { res.end(r.body); return; }
  if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(r.body));
}

/** The app shell: index.html with this request's nonce on every <script> and <style>. */
function shell(config: Config): (res: ServerResponse) => void {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const brand = !!(config.brandDir && existsSync(join(config.brandDir, 'sprite.svg')));
  return (res) => {
    const nonce = newNonce();
    res.setHeader('Content-Security-Policy', pageCsp(nonce));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(html.replaceAll('__NONCE__', nonce).replace('__BRAND__', brand ? '1' : '0'));
  };
}

/** How the app's own files may be cached: `no-cache` means "ask every time": an unchanged file costs a 304. */
const REVALIDATE = 'no-cache';
const etags = new Map<string, { mtime: number; size: number; tag: string }>();

/**
 * Serve a file with an ETag (content hash), answering 304 when the browser already has it. `cache` is
 * the Cache-Control value: REVALIDATE for the app's code, so a deploy is seen on the next load, never
 * hours later (a long max-age let browsers and the CDN run old and new files side by side).
 */
function staticFile(req: IncomingMessage, res: ServerResponse, dir: string, rel: string, cache: string): boolean {
  const p = normalize(join(dir, rel));
  if (!p.startsWith(normalize(dir)) || !existsSync(p)) return false;
  const st = statSync(p);
  if (!st.isFile()) return false;
  let e = etags.get(p);
  if (!e || e.mtime !== st.mtimeMs || e.size !== st.size) {
    e = { mtime: st.mtimeMs, size: st.size, tag: '"' + createHash('sha256').update(readFileSync(p)).digest('base64url').slice(0, 22) + '"' };
    etags.set(p, e);
  }
  res.setHeader('Content-Type', TYPES[extname(p)] || 'application/octet-stream');
  res.setHeader('Cache-Control', cache);
  res.setHeader('ETag', e.tag);
  const inm = String(req.headers['if-none-match'] || '');
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === e.tag)) { res.statusCode = 304; res.end(); return true; }
  res.end(req.method === 'HEAD' ? undefined : readFileSync(p));
  return true;
}

export interface App { server: Server; router: Router }

export function createApp(db: Db, config: Config): App {
  const router = new Router();
  registerAll(router);
  const page = shell(config);

  const server = createServer(async (req, res) => {
    baseHeaders(res, config);
    const url = new URL(req.url || '/', config.origin);
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        checkCsrf(req, config);
        const m = router.match(req.method || 'GET', path.slice(4));
        if (!m) throw new HttpError(404, 'not_found', 'No such endpoint');
        const ip = (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim()) || req.socket.remoteAddress || '';
        const ctx: Ctx = {
          req, res, method: req.method || 'GET', url, params: m.params, query: url.searchParams, db, config, ip,
          user: await loadSession(db, req),
          async json<T>() {
            const buf = await readBody(req, 64 * 1024);
            if (!buf.length) return {} as T;
            try { return JSON.parse(buf.toString('utf8')) as T; } catch { throw new HttpError(400, 'bad_json', 'The request body is not valid JSON'); }
          },
          raw: (max = 4_000_000) => readBody(req, max),
        };
        send(res, await m.handler(ctx));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method', 'Method not allowed');
      if (path.startsWith('/brand/')) {
        // brand art and fonts change rarely; a day, then revalidated with the ETag
        if (config.brandDir && staticFile(req, res, config.brandDir, path.slice(7), 'public, max-age=86400')) return;
        throw new HttpError(404, 'not_found', 'No brand pack');
      }
      if (path.startsWith('/static/') && staticFile(req, res, join(WEB, 'static'), path.slice(8), REVALIDATE)) return;
      if (path === '/sw.js' && staticFile(req, res, WEB, 'sw.js', REVALIDATE)) return;
      if (path === '/manifest.webmanifest' && staticFile(req, res, WEB, 'manifest.webmanifest', REVALIDATE)) return;
      if (path.startsWith('/media/')) {
        const id = path.slice(7);
        const row = /^[0-9a-f-]{36}$/.test(id) ? await db.one<{ mime: string }>('SELECT mime FROM media WHERE id = $1', [id]) : null;
        if (row && existsSync(join(config.mediaDir, id))) {
          res.setHeader('Content-Type', row.mime);
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
          res.end(readFileSync(join(config.mediaDir, id)));
          return;
        }
        throw new HttpError(404, 'not_found', 'No such file');
      }
      page(res); // every other path is a screen of the web app
    } catch (e) {
      const he = e instanceof HttpError ? e : null;
      if (!he) console.error(JSON.stringify({ level: 'error', msg: 'request failed', path, err: String((e as Error)?.stack || e) }));
      if (!res.headersSent) send(res, { status: he?.status || 500, body: { error: { code: he?.code || 'server_error', message: he?.message || 'Something went wrong on our side' } } });
      else res.end();
    }
  });
  return { server, router };
}
