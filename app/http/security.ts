// Security headers, CSRF, and a small in-memory rate limiter. Every response gets the headers; every
// state-changing API request must come from our own origin.
import { randomBytes } from 'node:crypto';
import type { ServerResponse, IncomingMessage } from 'node:http';
import type { Config } from '../config.ts';
import { HttpError } from './router.ts';

export const newNonce = (): string => randomBytes(16).toString('base64');

/** Strict CSP for the web app: nonce-only scripts and styles, same-origin everything else. */
export function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function baseHeaders(res: ServerResponse, config: Config): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=()');
  if (config.origin.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** State-changing requests need our Origin (browsers send it on fetch POST/PUT/PATCH/DELETE). */
export function checkCsrf(req: IncomingMessage, config: Config): void {
  if (SAFE.has(req.method || 'GET')) return;
  const origin = req.headers.origin;
  if (origin !== config.origin) throw new HttpError(403, 'bad_origin', 'Requests must come from the Community site');
}

/** Fixed-window limiter per key. Returns false when over the limit. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private limit: number;
  private windowMs: number;
  constructor(limit: number, windowMs: number) { this.limit = limit; this.windowMs = windowMs; }
  take(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 50_000) this.sweep(now);
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
  private sweep(now: number) { for (const [k, h] of this.hits) if (h.reset <= now) this.hits.delete(k); }
}

/** Shared limiters: writes per person, auth attempts per address. */
export const limits = {
  write: new RateLimiter(60, 60_000),
  auth: new RateLimiter(20, 10 * 60_000),
  upload: new RateLimiter(30, 60 * 60_000),
};

export function limit(l: RateLimiter, key: string): void {
  if (!l.take(key)) throw new HttpError(429, 'slow_down', 'Too many requests. Try again in a minute.');
}
