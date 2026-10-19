// Accounts: invite-only joining with a passkey (decision 0006, point 8), passkey login, sessions,
// and the signed-in person's own settings. No passwords, no phone numbers (not until the lawyer's review).
import { createHash } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { fail, json, noContent, type Ctx, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { endSession, requireUser, startSession } from '../../http/session.ts';
import { bool, oneOf, str } from '../shared.ts';

export const TERMS_VERSION = '2026-10-19';
export const TRADES = ['rider', 'fresh', 'grill', 'grocery', 'creator', 'tutor', 'coder', 'other'] as const;
const HANDLE = /^[a-z0-9._]{3,30}$/;
const hash = (v: string) => createHash('sha256').update(v.trim().toUpperCase()).digest();

async function liveInvite(ctx: Ctx, code: unknown) {
  const c = str(code, 'code', { min: 8, max: 64 });
  const inv = await ctx.db.one<{ code_hash: Buffer; role: 'member' | 'staff'; expires_at: string }>(
    'SELECT code_hash, role, expires_at FROM invites WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()', [hash(c)]);
  return inv ?? fail(404, 'invite_invalid', 'This invite has been used or has expired');
}

const MY_COLS = `id, handle, first_name, trade, bio, home_area, avatar_media_id, cover_media_id, role, status,
  terms_version, improve_usage, improve_surveys, dm_public_key, created_at`;

export function register(r: Router): void {
  r.get('/terms', () => json({ version: TERMS_VERSION }));

  r.post('/accounts/invite/check', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const inv = await liveInvite(ctx, (await ctx.json()).code);
    return json({ ok: true, expires_at: inv.expires_at });
  });

  // Step 1 of joining: check the invite and the profile, get passkey options.
  r.post('/accounts/register/options', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const b = await ctx.json<Record<string, unknown>>();
    const inv = await liveInvite(ctx, b.code);
    if (b.agree !== true) fail(400, 'agree', 'Tick the box to agree to the Terms, Privacy notice and Community rules');
    if (b.adult !== true) fail(400, 'adult', 'PopCart Community is for people 18 and older');
    if (b.terms_version !== TERMS_VERSION) fail(409, 'terms_changed', 'The terms changed. Read them again.');
    const handle = str(b.handle, 'handle', { min: 3, max: 30, pattern: HANDLE }).toLowerCase();
    if (await ctx.db.one('SELECT 1 FROM users WHERE handle = $1', [handle])) fail(409, 'handle_taken', 'That username is taken');
    const pending = {
      code_hash: inv.code_hash.toString('hex'), role: inv.role, handle,
      first_name: str(b.first_name, 'first_name', { min: 1, max: 40 }),
      trade: oneOf(b.trade, 'trade', TRADES, 'other'),
      home_area: b.home_area ? str(b.home_area, 'home_area', { max: 40 }) : null,
      improve_usage: bool(b.improve_usage), improve_surveys: bool(b.improve_surveys),
    };
    if (pending.home_area && !(await ctx.db.one('SELECT 1 FROM areas WHERE code = $1', [pending.home_area]))) fail(400, 'invalid', 'home_area: is not a known place');
    const options = await generateRegistrationOptions({
      rpName: ctx.config.rpName, rpID: ctx.config.rpId, userName: handle, userDisplayName: pending.first_name,
      attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const ch = await ctx.db.one<{ id: string }>(
      `INSERT INTO webauthn_challenges (kind, challenge, pending, expires_at) VALUES ('register', $1, $2, now() + interval '10 minutes') RETURNING id`,
      [options.challenge, JSON.stringify(pending)]);
    return json({ challengeId: ch!.id, options });
  });

  // Step 2: verify the new passkey, create the account, sign in.
  r.post('/accounts/register/verify', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const b = await ctx.json<{ challengeId?: string; response?: unknown }>();
    const ch = await ctx.db.one<{ challenge: string; pending: Record<string, unknown> }>(
      `DELETE FROM webauthn_challenges WHERE id = $1 AND kind = 'register' AND expires_at > now() RETURNING challenge, pending`, [String(b.challengeId || '')]);
    if (!ch) return fail(400, 'challenge', 'This sign-up step expired. Start again.');
    const v = await verifyRegistrationResponse({
      response: b.response as never, expectedChallenge: ch.challenge, expectedOrigin: ctx.config.origin, expectedRPID: ctx.config.rpId,
    }).catch(() => ({ verified: false as const }));
    if (!v.verified) return fail(400, 'passkey', 'The passkey could not be checked');
    const p = ch.pending as { code_hash: string; role: string; handle: string; first_name: string; trade: string; home_area: string | null; improve_usage: boolean; improve_surveys: boolean };
    const cred = v.registrationInfo.credential;
    const user = await ctx.db.tx(async (t) => {
      const used = await t.one('UPDATE invites SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING 1', [Buffer.from(p.code_hash, 'hex')]);
      if (!used) fail(404, 'invite_invalid', 'This invite has been used or has expired');
      if (await t.one('SELECT 1 FROM users WHERE handle = $1', [p.handle])) fail(409, 'handle_taken', 'That username is taken');
      const u = await t.one<{ id: string }>(
        `INSERT INTO users (handle, first_name, trade, home_area, role, terms_version, terms_accepted_at, improve_usage, improve_surveys)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8) RETURNING id`,
        [p.handle, p.first_name, p.trade, p.home_area, p.role, TERMS_VERSION, p.improve_usage, p.improve_surveys]);
      await t.query('UPDATE invites SET used_by = $1 WHERE code_hash = $2', [u!.id, Buffer.from(p.code_hash, 'hex')]);
      await t.query('INSERT INTO passkeys (id, user_id, public_key, counter, transports) VALUES ($1, $2, $3, $4, $5)',
        [cred.id, u!.id, Buffer.from(cred.publicKey), cred.counter, cred.transports || []]);
      return u!;
    });
    const cookie = await startSession(ctx.db, ctx.config, user.id);
    return json({ user: await ctx.db.one(`SELECT ${MY_COLS} FROM users WHERE id = $1`, [user.id]) }, 201, { 'Set-Cookie': cookie });
  });

  r.post('/accounts/login/options', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const options = await generateAuthenticationOptions({ rpID: ctx.config.rpId, userVerification: 'preferred' });
    const ch = await ctx.db.one<{ id: string }>(
      `INSERT INTO webauthn_challenges (kind, challenge, expires_at) VALUES ('login', $1, now() + interval '5 minutes') RETURNING id`, [options.challenge]);
    return json({ challengeId: ch!.id, options });
  });

  r.post('/accounts/login/verify', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const b = await ctx.json<{ challengeId?: string; response?: { id?: string } }>();
    const ch = await ctx.db.one<{ challenge: string }>(
      `DELETE FROM webauthn_challenges WHERE id = $1 AND kind = 'login' AND expires_at > now() RETURNING challenge`, [String(b.challengeId || '')]);
    if (!ch) return fail(400, 'challenge', 'This sign-in step expired. Try again.');
    const pk = await ctx.db.one<{ id: string; user_id: string; public_key: Uint8Array; counter: string; transports: string[] }>(
      `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports FROM passkeys p JOIN users u ON u.id = p.user_id
       WHERE p.id = $1 AND u.status <> 'deleted'`, [String(b.response?.id || '')]);
    if (!pk) return fail(401, 'passkey', 'This passkey is not registered here');
    const v = await verifyAuthenticationResponse({
      response: b.response as never, expectedChallenge: ch.challenge, expectedOrigin: ctx.config.origin, expectedRPID: ctx.config.rpId,
      credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports as never },
    }).catch(() => ({ verified: false, authenticationInfo: { newCounter: 0 } }));
    if (!v.verified) return fail(401, 'passkey', 'The passkey could not be checked');
    await ctx.db.query('UPDATE passkeys SET counter = $1, last_used_at = now() WHERE id = $2', [v.authenticationInfo.newCounter, pk.id]);
    const cookie = await startSession(ctx.db, ctx.config, pk.user_id);
    return json({ user: await ctx.db.one(`SELECT ${MY_COLS} FROM users WHERE id = $1`, [pk.user_id]) }, 200, { 'Set-Cookie': cookie });
  });

  // Staff invite people while joining is invite-only. The code is shown once and stored only as a hash.
  r.post('/accounts/invites', async (ctx) => {
    const me = requireUser(ctx);
    if (me.role !== 'staff') fail(403, 'staff_only', 'Only staff can invite while joining is invite-only');
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const code = await createInvite(ctx.db, { createdBy: me.id, note: str(b.note, 'note', { max: 80, optional: true }), days: 7 });
    return json({ code, url: `${ctx.config.origin}/join?code=${code}`, expires_in_days: 7 }, 201);
  });

  r.post('/accounts/logout', async (ctx) => noContent2(await endSession(ctx.db, ctx.config, ctx.req)));

  r.get('/me', async (ctx) => {
    if (!ctx.user) return json({ user: null });
    return json({ user: await ctx.db.one(`SELECT ${MY_COLS} FROM users WHERE id = $1`, [ctx.user.id]) });
  });

  r.patch('/me', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const sets: string[] = [], vals: unknown[] = [];
    const set = (col: string, val: unknown) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if ('first_name' in b) set('first_name', str(b.first_name, 'first_name', { min: 1, max: 40 }));
    if ('bio' in b) set('bio', str(b.bio, 'bio', { max: 300, optional: true }));
    if ('trade' in b) set('trade', oneOf(b.trade, 'trade', TRADES));
    if ('home_area' in b) {
      const a = b.home_area ? str(b.home_area, 'home_area', { max: 40 }) : null;
      if (a && !(await ctx.db.one('SELECT 1 FROM areas WHERE code = $1', [a]))) fail(400, 'invalid', 'home_area: is not a known place');
      set('home_area', a);
    }
    if ('improve_usage' in b) set('improve_usage', bool(b.improve_usage));
    if ('improve_surveys' in b) set('improve_surveys', bool(b.improve_surveys));
    for (const col of ['avatar_media_id', 'cover_media_id'] as const) {
      if (!(col in b)) continue;
      const id = b[col] ? String(b[col]) : null;
      if (id && !(await ctx.db.one('SELECT 1 FROM media WHERE id = $1 AND owner_id = $2', [id, me.id]))) fail(400, 'invalid', `${col}: not your upload`);
      set(col, id);
    }
    if ('dm_public_key' in b) {
      const k = b.dm_public_key as Record<string, unknown> | null;
      if (k !== null && (typeof k !== 'object' || k.kty !== 'EC' || k.crv !== 'P-256' || typeof k.x !== 'string' || typeof k.y !== 'string' || 'd' in k)) {
        fail(400, 'invalid', 'dm_public_key: must be a public ECDH P-256 key (JWK)');
      }
      set('dm_public_key', k === null ? null : JSON.stringify({ kty: 'EC', crv: 'P-256', x: k.x, y: k.y }));
    }
    if (sets.length) { vals.push(me.id); await ctx.db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals); }
    return json({ user: await ctx.db.one(`SELECT ${MY_COLS} FROM users WHERE id = $1`, [me.id]) });
  });
}

const noContent2 = (cookie: string) => ({ ...noContent(), headers: { 'Set-Cookie': cookie } });

/** Create an invite; returns the code (shown once). Used by the CLI and by staff in the app. */
export async function createInvite(db: Ctx['db'], opts: { createdBy?: string | null; note?: string; days?: number; role?: 'member' | 'staff' }): Promise<string> {
  const { randomBytes } = await import('node:crypto');
  const code = randomBytes(12).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12).padEnd(12, 'X');
  await db.query(`INSERT INTO invites (code_hash, created_by, note, role, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [hash(code), opts.createdBy || null, (opts.note || '').slice(0, 80), opts.role || 'member', opts.days || 7]);
  return code;
}
