// Staff sessions on the staff host (decision 0009, point 9). Separate from member sessions: their own
// __Host- cookie (this host only, https only, never sent cross-site), 15 idle minutes, 12 hours at most.
// A session counts only while the person still holds a staff role and, with the gate on, only for the
// address the gate let through.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Db } from '../db/index.ts';
import { readCookie } from './session.ts';
import type { SessionUser } from './router.ts';
import { scopesOf } from './scopes.ts';

export const STAFF_COOKIE = '__Host-staff';
export const IDLE_MINUTES = 15, MAX_HOURS = 12;
const hash = (v: string) => createHash('sha256').update(v).digest();

/** Is this staff member's gate address the one the gate let through? (null `gate`: gate off, local only) */
export const gateMatches = (stored: Uint8Array | null, gate: Buffer | null): boolean =>
  gate === null || (!!stored && stored.length === gate.length && timingSafeEqual(Buffer.from(stored), gate));

export interface StaffUser extends SessionUser { idleEndsAt: string }

/**
 * The staff member signed in on this request, or null. `touch` renews the idle time (every staff
 * action does; reading the session's own status does not).
 */
export async function loadStaffSession(db: Db, req: IncomingMessage, gate: Buffer | null, touch = true): Promise<StaffUser | null> {
  const v = readCookie(req, STAFF_COOKIE);
  if (!v || !/^[A-Za-z0-9_-]{43}$/.test(v)) return null;
  const row = await db.one<{ id: string; handle: string; role: string; scopes: string[]; email_hash: Uint8Array | null; last_seen_at: string }>(
    `SELECT u.id, u.handle, sm.role, sr.scopes, sm.email_hash, s.last_seen_at
     FROM staff_sessions s JOIN users u ON u.id = s.user_id
       JOIN staff_members sm ON sm.user_id = u.id AND (sm.ends_at IS NULL OR sm.ends_at > now())
       JOIN staff_roles sr ON sr.name = sm.role
     WHERE s.id_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(mins => $2) AND u.status = 'active'`,
    [hash(v), IDLE_MINUTES]);
  if (!row || !gateMatches(row.email_hash, gate)) return null;
  let seen = row.last_seen_at;
  if (touch) seen = (await db.one<{ last_seen_at: string }>('UPDATE staff_sessions SET last_seen_at = now() WHERE id_hash = $1 RETURNING last_seen_at', [hash(v)]))!.last_seen_at;
  return {
    id: row.id, handle: row.handle, status: 'active', staffRole: row.role, scopes: scopesOf(row.role, row.scopes),
    idleEndsAt: new Date(Date.parse(seen) + IDLE_MINUTES * 60_000).toISOString(),
  };
}

const cookie = (value: string, maxAge: number) => `${STAFF_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export async function startStaffSession(db: Db, userId: string): Promise<string> {
  const v = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO staff_sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`, [hash(v), userId, MAX_HOURS]);
  return cookie(v, MAX_HOURS * 3600);
}

export async function endStaffSession(db: Db, req: IncomingMessage): Promise<string> {
  const v = readCookie(req, STAFF_COOKIE);
  if (v) await db.query('DELETE FROM staff_sessions WHERE id_hash = $1', [hash(v)]);
  return cookie('', 0);
}
