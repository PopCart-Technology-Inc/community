// Sessions: an opaque random cookie; only its sha256 is stored. HttpOnly, SameSite=Lax, Secure on https.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { HttpError, type Ctx, type SessionUser } from './router.ts';

export const COOKIE = 'cs';
const hash = (v: string) => createHash('sha256').update(v).digest();

export function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

export async function loadSession(db: Db, req: IncomingMessage): Promise<SessionUser | null> {
  const v = readCookie(req, COOKIE);
  if (!v || !/^[A-Za-z0-9_-]{43}$/.test(v)) return null;
  return db.one<SessionUser>(
    `SELECT u.id, u.handle, u.role, u.status FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = $1 AND s.expires_at > now() AND u.status <> 'deleted'`, [hash(v)]);
}

/** Create a session and return the Set-Cookie header value. */
export async function startSession(db: Db, config: Config, userId: string): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [hash(v), userId, config.sessionDays]);
  return cookie(config, v, config.sessionDays * 86400);
}

export async function endSession(db: Db, config: Config, req: IncomingMessage): Promise<string> {
  const v = readCookie(req, COOKIE);
  if (v) await db.query('DELETE FROM sessions WHERE id_hash = $1', [hash(v)]);
  return cookie(config, '', 0);
}

function cookie(config: Config, value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.origin.startsWith('https://') ? '; Secure' : ''}`;
}

export function requireUser(ctx: Ctx): SessionUser {
  if (!ctx.user) throw new HttpError(401, 'sign_in', 'Sign in first');
  if (ctx.user.status !== 'active') throw new HttpError(403, 'suspended', 'This account is suspended');
  return ctx.user;
}

export function requireStaff(ctx: Ctx): SessionUser {
  const u = requireUser(ctx);
  if (u.role !== 'staff') throw new HttpError(403, 'staff_only', 'Staff only');
  return u;
}
