// The staff host's API (decision 0009). Only served on STAFF_ORIGIN, after the gate: the public host has
// none of these. Signing in takes the gate (Cloudflare Access, the address on the list) and a staff
// passkey made for the staff host. A staff passkey is set up once with a code made on the public site
// by the same person, signed in with their member passkey.
import { createHash, randomInt } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { fail, json, noContent, type Ctx, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { requireUser, STAFF_JOIN } from '../../http/session.ts';
import { endStaffSession, gateMatches, IDLE_MINUTES, startStaffSession, type StaffUser } from '../../http/staff-session.ts';
import type { Scope } from '../../http/scopes.ts';
import { page } from '../shared.ts';
import { KINDS, logStaff, readLog } from './audit.ts';

const sha = (v: string) => createHash('sha256').update(v).digest();
export const SETUP_MINUTES = 10;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to misread
const setupCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const normCode = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The signed-in staff member on the staff host, or 401. */
export function requireStaffSession(ctx: Ctx): StaffUser {
  if (ctx.staffGate === undefined || !ctx.user) return fail(401, 'staff_sign_in', 'Sign in with your staff passkey');
  return ctx.user as StaffUser;
}

/** The signed-in staff member, if their role has the scope; otherwise 403. */
export function requireStaffScope(ctx: Ctx, scope: Scope): StaffUser {
  const u = requireStaffSession(ctx);
  if (!u.scopes.includes(scope)) fail(403, 'no_scope', 'Your role does not allow this');
  return u;
}

/** On the public site: a signed-in staff member asks for a one-time code to set up their staff passkey. */
export function registerPublic(r: Router): void {
  r.post('/me/staff-code', async (ctx) => {
    if (!ctx.config.staffOrigin) return fail(404, 'not_found', 'No such endpoint');
    const me = requireUser(ctx);
    limit(limits.auth, ctx.ip);
    const staff = await ctx.db.one(`SELECT 1 FROM users u ${STAFF_JOIN} WHERE u.id = $1 AND sm.role IS NOT NULL`, [me.id]);
    if (!staff) return fail(403, 'staff_only', 'Staff only');
    const code = setupCode();
    await ctx.db.tx(async (t) => {
      await t.query('DELETE FROM staff_setup_codes WHERE user_id = $1 OR expires_at < now()', [me.id]);
      await t.query(`INSERT INTO staff_setup_codes (code_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`, [sha(code), me.id, SETUP_MINUTES]);
      await logStaff(t, me, 'session', 'asked for a staff passkey setup code');
    });
    return json({ code, expires_minutes: SETUP_MINUTES }, 201);
  });
}

/** Who the gate let through, as a staff member: their id, if they hold a role now. */
async function gatePerson(ctx: Ctx): Promise<{ id: string; handle: string } | null> {
  if (ctx.staffGate === null) return null; // gate off (this machine only): no address to match
  return ctx.db.one<{ id: string; handle: string }>(
    `SELECT u.id, u.handle FROM staff_members sm JOIN users u ON u.id = sm.user_id
     WHERE sm.email_hash = $1 AND (sm.ends_at IS NULL OR sm.ends_at > now()) AND u.status = 'active'`, [ctx.staffGate]);
}

/** Holds a role now, active, and (gate on) the gate's address is theirs. */
async function staffOk(ctx: Ctx, userId: string): Promise<{ handle: string } | null> {
  const row = await ctx.db.one<{ handle: string; email_hash: Uint8Array | null }>(
    `SELECT u.handle, sm.email_hash FROM users u JOIN staff_members sm ON sm.user_id = u.id AND (sm.ends_at IS NULL OR sm.ends_at > now())
     WHERE u.id = $1 AND u.status = 'active'`, [userId]);
  return row && gateMatches(row.email_hash, ctx.staffGate ?? null) ? { handle: row.handle } : null;
}

const staffOrigin = (ctx: Ctx) => ctx.config.staffOrigin as string;
const rpId = (ctx: Ctx) => ctx.config.staffRpId as string;

export function registerHost(r: Router): void {
  r.get('/staff/session', async (ctx) => {
    const u = ctx.user as StaffUser | null;
    const gp = await gatePerson(ctx);
    const enrolled = gp ? !!(await ctx.db.one('SELECT 1 FROM staff_passkeys WHERE user_id = $1', [gp.id])) : null;
    return json({
      user: u && { handle: u.handle, role: u.staffRole, scopes: u.scopes, idle_ends_at: u.idleEndsAt },
      idle_minutes: IDLE_MINUTES,
      public_origin: ctx.config.origin,
      gate: ctx.staffGate === null ? 'off' : 'access',
      // With the gate on: is the address the gate let through on the staff list, and has it a staff passkey?
      listed: ctx.staffGate === null ? null : !!gp,
      enrolled,
    });
  });

  // Setting up a staff passkey: the code from the public site, then the passkey.
  r.post('/staff/enroll/options', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const code = normCode((await ctx.json()).code);
    if (code.length !== 8) return fail(400, 'code_invalid', 'Type the 8-character code from Settings on Community');
    const row = await ctx.db.one<{ user_id: string }>('SELECT user_id FROM staff_setup_codes WHERE code_hash = $1 AND expires_at > now()', [sha(code)]);
    if (!row) return fail(400, 'code_invalid', 'That code is wrong or has expired. Make a new one in Settings on Community.');
    const who = await staffOk(ctx, row.user_id);
    if (!who) return fail(403, 'not_listed', 'This code belongs to someone the gate did not let in, or who holds no staff role');
    const existing = await ctx.db.query<{ id: string }>('SELECT id FROM staff_passkeys WHERE user_id = $1', [row.user_id]);
    const options = await generateRegistrationOptions({
      rpName: 'Community staff', rpID: rpId(ctx), userName: '@' + who.handle, userDisplayName: '@' + who.handle + ' (staff)',
      attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: existing.map((p) => ({ id: p.id })),
    });
    const ch = await ctx.db.one<{ id: string }>(
      `INSERT INTO staff_challenges (kind, challenge, user_id, expires_at) VALUES ('enroll', $1, $2, now() + interval '10 minutes') RETURNING id`, [options.challenge, row.user_id]);
    return json({ challengeId: ch!.id, options });
  });

  r.post('/staff/enroll/verify', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const b = await ctx.json<{ challengeId?: string; response?: unknown; code?: unknown }>();
    const ch = await ctx.db.one<{ challenge: string; user_id: string }>(
      `DELETE FROM staff_challenges WHERE id = $1 AND kind = 'enroll' AND expires_at > now() RETURNING challenge, user_id`, [String(b.challengeId || '')]);
    if (!ch) return fail(400, 'challenge', 'This step expired. Start again.');
    // The code is used up here, so it works once.
    if (!(await ctx.db.one('DELETE FROM staff_setup_codes WHERE code_hash = $1 AND user_id = $2 AND expires_at > now() RETURNING 1', [sha(normCode(b.code)), ch.user_id]))) {
      return fail(400, 'code_invalid', 'That code is wrong or has expired. Make a new one in Settings on Community.');
    }
    const who = await staffOk(ctx, ch.user_id);
    if (!who) return fail(403, 'not_listed', 'Staff only');
    const v = await verifyRegistrationResponse({
      response: b.response as never, expectedChallenge: ch.challenge, expectedOrigin: staffOrigin(ctx), expectedRPID: rpId(ctx), requireUserVerification: true,
    }).catch(() => ({ verified: false as const }));
    if (!v.verified) return fail(400, 'passkey', 'The passkey could not be checked');
    const cred = v.registrationInfo.credential;
    await ctx.db.query('INSERT INTO staff_passkeys (id, user_id, public_key, counter, transports) VALUES ($1, $2, $3, $4, $5)',
      [cred.id, ch.user_id, Buffer.from(cred.publicKey), cred.counter, cred.transports || []]);
    await logStaff(ctx.db, { id: ch.user_id, handle: who.handle }, 'session', 'set up a staff passkey');
    return json({ ok: true }, 201, { 'Set-Cookie': await startStaffSession(ctx.db, ch.user_id) });
  });

  r.post('/staff/login/options', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const options = await generateAuthenticationOptions({ rpID: rpId(ctx), userVerification: 'required' });
    const ch = await ctx.db.one<{ id: string }>(
      `INSERT INTO staff_challenges (kind, challenge, expires_at) VALUES ('login', $1, now() + interval '5 minutes') RETURNING id`, [options.challenge]);
    return json({ challengeId: ch!.id, options });
  });

  r.post('/staff/login/verify', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const b = await ctx.json<{ challengeId?: string; response?: { id?: string } }>();
    const ch = await ctx.db.one<{ challenge: string }>(
      `DELETE FROM staff_challenges WHERE id = $1 AND kind = 'login' AND expires_at > now() RETURNING challenge`, [String(b.challengeId || '')]);
    if (!ch) return fail(400, 'challenge', 'This step expired. Try again.');
    const pk = await ctx.db.one<{ id: string; user_id: string; public_key: Uint8Array; counter: string; transports: string[] }>(
      'SELECT id, user_id, public_key, counter, transports FROM staff_passkeys WHERE id = $1', [String(b.response?.id || '')]);
    if (!pk) return fail(401, 'passkey', 'This is not a staff passkey');
    const who = await staffOk(ctx, pk.user_id);
    if (!who) return fail(401, 'passkey', 'This is not a staff passkey');
    const v = await verifyAuthenticationResponse({
      response: b.response as never, expectedChallenge: ch.challenge, expectedOrigin: staffOrigin(ctx), expectedRPID: rpId(ctx), requireUserVerification: true,
      credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports as never },
    }).catch(() => ({ verified: false, authenticationInfo: { newCounter: 0 } }));
    if (!v.verified) {
      await logStaff(ctx.db, { id: pk.user_id, handle: who.handle }, 'session', 'a staff passkey sign-in failed');
      return fail(401, 'passkey', 'The passkey could not be checked');
    }
    await ctx.db.query('UPDATE staff_passkeys SET counter = $1, last_used_at = now() WHERE id = $2', [v.authenticationInfo.newCounter, pk.id]);
    await logStaff(ctx.db, { id: pk.user_id, handle: who.handle }, 'session', 'opened the staff panel with a passkey');
    return json({ ok: true }, 200, { 'Set-Cookie': await startStaffSession(ctx.db, pk.user_id) });
  });

  // Locking ends the session; the passkey opens a new one.
  r.post('/staff/lock', async (ctx) => {
    const u = ctx.user;
    const b = await ctx.json<{ why?: unknown }>();
    if (u) await logStaff(ctx.db, u, 'session', b.why === 'idle' ? `locked the panel (idle ${IDLE_MINUTES} minutes)` : 'locked the panel');
    return { ...noContent(), headers: { 'Set-Cookie': await endStaffSession(ctx.db, ctx.req) } };
  });

  r.get('/staff/audit', async (ctx) => {
    requireStaffScope(ctx, 'audit.read');
    const { limit: n, before } = page(ctx.query);
    const kind = ctx.query.get('kind');
    if (kind && !(KINDS as readonly string[]).includes(kind)) return fail(400, 'invalid', 'kind: not a kind of entry');
    const entries = await readLog(ctx.db, { who: ctx.query.get('who'), kind, q: (ctx.query.get('q') || '').slice(0, 80), before, limit: n });
    return json({ entries, kinds: KINDS, as_of: new Date().toISOString() });
  });
}
