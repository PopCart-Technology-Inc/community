// Accounts: invite-only joining with a passkey (decision 0006, point 8), passkey login, sessions,
// and the signed-in person's own settings. No passwords, no phone numbers (not until the lawyer's review).
// Invites go to an email address (decision 0008): joining needs that address and the code sent to it,
// so an invite cannot be passed on as a link. The address is never stored, only a keyed hash of it.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Config } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { fail, json, noContent, type Ctx, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { endSession, requireScope, requireUser, STAFF_JOIN, startSession } from '../../http/session.ts';
import { OVERSEER, scopesOf } from '../../http/scopes.ts';
import { inviteEmail, joinCodeEmail } from '../../mail/messages.ts';
import { sendMail } from '../../mail/send.ts';
import { bool, oneOf, str } from '../shared.ts';
import { checkHandle, handleKey } from './handles.ts';

export const TERMS_VERSION = '2026-10-19';
export const TRADES = ['rider', 'fresh', 'grill', 'grocery', 'creator', 'tutor', 'coder', 'other'] as const;
const sha = (v: string) => createHash('sha256').update(v).digest();
export const CODE_MINUTES = 10, CODE_TRIES = 5, RESEND_SECONDS = 30, TICKET_MINUTES = 30;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** Trimmed, lower-cased address, or a 400. */
export function emailOf(v: unknown): string {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (e.length > 254 || !EMAIL_RE.test(e)) fail(400, 'invalid', 'email: type a full email address, like name@example.com');
  return e;
}

/** Keyed hash of an address: matches it without keeping it. Changing EMAIL_HASH_KEY retires open invites. */
export function emailHash(config: Config, email: string): Buffer {
  if (!config.emailKey) return fail(503, 'mail_down', 'Email is not set up on this server');
  return createHmac('sha256', config.emailKey).update(email).digest();
}
const codeHash = (config: Config, eh: Buffer, code: string) => createHmac('sha256', config.emailKey!).update(eh).update(':' + code).digest();

async function liveInvite(ctx: Ctx, ticket: unknown) {
  const t = str(ticket, 'ticket', { min: 16, max: 64 });
  const inv = await ctx.db.one<{ code_hash: Buffer; role: 'member' | 'staff'; expires_at: string }>(
    `SELECT code_hash, role, expires_at FROM invites
     WHERE ticket_hash = $1 AND ticket_expires_at > now() AND used_at IS NULL AND expires_at > now()`, [sha(t)]);
  return inv ?? fail(404, 'invite_invalid', 'This join step expired. Start again from the join page.');
}

const MY_COLS = `u.id, u.handle, u.first_name, u.trade, u.bio, u.home_area, u.avatar_media_id, u.cover_media_id, u.status,
  u.terms_version, u.improve_usage, u.improve_surveys, u.dm_public_key, u.created_at`;

/**
 * The signed-in person's own record. `staff` is their role, its scopes and when it ends (null for
 * members); `role` ('staff' or 'member') is kept for clients written before 0.8.0.
 */
export async function myself(db: Db, id: string) {
  const u = await db.one<Record<string, unknown> & { staff_role: string | null; staff_scopes: string[] | null; staff_ends_at: string | null }>(
    `SELECT ${MY_COLS}, sm.role AS staff_role, sr.scopes AS staff_scopes, sm.ends_at AS staff_ends_at FROM users u ${STAFF_JOIN} WHERE u.id = $1`, [id]);
  if (!u) return null;
  const { staff_role, staff_scopes, staff_ends_at, ...rest } = u;
  return { ...rest, role: staff_role ? 'staff' : 'member', staff: staff_role ? { role: staff_role, scopes: scopesOf(staff_role, staff_scopes), ends_at: staff_ends_at } : null };
}

export function register(r: Router): void {
  r.get('/terms', () => json({ version: TERMS_VERSION }));

  // Joining, step 1: the invited address. A code goes to it only if it has a live invite, but the reply
  // is the same either way, so nobody can test which addresses are invited.
  r.post('/accounts/join/start', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const email = emailOf((await ctx.json()).email);
    const eh = emailHash(ctx.config, email);
    limit(limits.mail, eh.toString('hex'));
    const invited = await ctx.db.one('SELECT 1 FROM invites WHERE email_hash = $1 AND used_at IS NULL AND expires_at > now()', [eh]);
    const recent = await ctx.db.one(`SELECT 1 FROM email_codes WHERE email_hash = $1 AND sent_at > now() - make_interval(secs => $2)`, [eh, RESEND_SECONDS]);
    if (invited && !recent) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await ctx.db.tx(async (t) => {
        await t.query(`INSERT INTO email_codes (email_hash, code_hash, attempts, sent_at, expires_at) VALUES ($1, $2, 0, now(), now() + make_interval(mins => $3))
          ON CONFLICT (email_hash) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0, sent_at = now(), expires_at = EXCLUDED.expires_at`,
        [eh, codeHash(ctx.config, eh, code), CODE_MINUTES]);
        await sendMail(ctx.config, email, joinCodeEmail(ctx.config, { code }));
      });
    }
    return json({ sent: true, resend_after_seconds: RESEND_SECONDS, code_minutes: CODE_MINUTES }, 202);
  });

  // Joining, step 2: the emailed code. Right code: a join ticket for the passkey step (30 minutes).
  r.post('/accounts/join/verify', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const b = await ctx.json<{ email?: unknown; code?: unknown }>();
    const eh = emailHash(ctx.config, emailOf(b.email));
    const code = String(b.code ?? '').replace(/\D/g, '');
    if (code.length !== 6) fail(400, 'code_invalid', 'Type the 6-digit code from the email');
    const row = await ctx.db.one<{ code_hash: Buffer; attempts: number }>(
      'UPDATE email_codes SET attempts = attempts + 1 WHERE email_hash = $1 AND expires_at > now() RETURNING code_hash, attempts', [eh]);
    if (!row) return fail(400, 'code_expired', 'That code has expired. Ask for a new one.');
    if (row.attempts > CODE_TRIES) {
      await ctx.db.query('DELETE FROM email_codes WHERE email_hash = $1', [eh]);
      return fail(400, 'code_expired', 'Too many wrong tries. Ask for a new code.');
    }
    if (!timingSafeEqual(Buffer.from(row.code_hash), codeHash(ctx.config, eh, code))) {
      const left = CODE_TRIES - row.attempts;
      if (left <= 0) await ctx.db.query('DELETE FROM email_codes WHERE email_hash = $1', [eh]);
      return fail(400, left > 0 ? 'code_invalid' : 'code_expired', left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Ask for a new code.');
    }
    // One use: only the request that deletes the row goes on.
    if (!(await ctx.db.one('DELETE FROM email_codes WHERE email_hash = $1 RETURNING 1', [eh]))) return fail(400, 'code_expired', 'That code has expired. Ask for a new one.');
    const ticket = randomBytes(24).toString('base64url');
    const inv = await ctx.db.one<{ expires_at: string }>(
      `UPDATE invites SET ticket_hash = $1, ticket_expires_at = now() + make_interval(mins => $2)
       WHERE code_hash = (SELECT code_hash FROM invites WHERE email_hash = $3 AND used_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1)
       RETURNING expires_at`, [sha(ticket), TICKET_MINUTES, eh]);
    if (!inv) return fail(404, 'invite_invalid', 'This invite has been used or has expired');
    return json({ ticket, ticket_minutes: TICKET_MINUTES });
  });

  // Joining, step 3: check the ticket and the profile, get passkey options.
  r.post('/accounts/register/options', async (ctx) => {
    limit(limits.auth, ctx.ip);
    const b = await ctx.json<Record<string, unknown>>();
    const inv = await liveInvite(ctx, b.ticket);
    if (b.agree !== true) fail(400, 'agree', 'Tick the box to agree to the Terms, Privacy notice and Community rules');
    if (b.adult !== true) fail(400, 'adult', 'PopCart Community is for people 18 and older');
    if (b.terms_version !== TERMS_VERSION) fail(409, 'terms_changed', 'The terms changed. Read them again.');
    const handle = await checkHandle(b.handle, ctx.db);
    const pending = {
      code_hash: Buffer.from(inv.code_hash).toString('hex'), role: inv.role, handle,
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
      // A staff invite's address is the one on the staff host's gate list (decision 0009): keep its hash there.
      const staffGate = p.role === 'staff' ? (await t.one<{ email_hash: Buffer | null }>('SELECT email_hash FROM invites WHERE code_hash = $1', [Buffer.from(p.code_hash, 'hex')]))?.email_hash ?? null : null;
      // Used: the address hash and the ticket are cleared, so nothing ties the account to an email.
      const used = await t.one(`UPDATE invites SET used_at = now(), email_hash = NULL, ticket_hash = NULL, ticket_expires_at = NULL
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING 1`, [Buffer.from(p.code_hash, 'hex')]);
      if (!used) fail(404, 'invite_invalid', 'This invite has been used or has expired');
      if (await t.one('SELECT 1 FROM users WHERE handle_key = $1', [handleKey(p.handle)])) fail(409, 'handle_taken', 'That username is taken');
      const u = await t.one<{ id: string }>(
        `INSERT INTO users (handle, first_name, trade, home_area, terms_version, terms_accepted_at, improve_usage, improve_surveys)
         VALUES ($1, $2, $3, $4, $5, now(), $6, $7) RETURNING id`,
        [p.handle, p.first_name, p.trade, p.home_area, TERMS_VERSION, p.improve_usage, p.improve_surveys]);
      // A staff invite comes only from the server's command line (npm run invite -- --staff): it makes an Overseer.
      if (p.role === 'staff') await t.query('INSERT INTO staff_members (user_id, role, email_hash) VALUES ($1, $2, $3)', [u!.id, OVERSEER, staffGate]);
      await t.query('UPDATE invites SET used_by = $1 WHERE code_hash = $2', [u!.id, Buffer.from(p.code_hash, 'hex')]);
      await t.query('INSERT INTO passkeys (id, user_id, public_key, counter, transports) VALUES ($1, $2, $3, $4, $5)',
        [cred.id, u!.id, Buffer.from(cred.publicKey), cred.counter, cred.transports || []]);
      return u!;
    });
    const cookie = await startSession(ctx.db, ctx.config, user.id);
    return json({ user: await myself(ctx.db, user.id) }, 201, { 'Set-Cookie': cookie });
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
    return json({ user: await myself(ctx.db, pk.user_id) }, 200, { 'Set-Cookie': cookie });
  });

  // Staff invite people by email while joining is invite-only.
  r.post('/accounts/invites', async (ctx) => {
    const me = requireScope(ctx, 'invites.send');
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const email = emailOf(b.email);
    const { expiresAt } = await inviteByEmail(ctx.db, ctx.config, { email, createdBy: me.id, note: str(b.note, 'note', { max: 80, optional: true }), days: INVITE_DAYS });
    return json({ sent: true, expires_at: expiresAt, expires_in_days: INVITE_DAYS }, 201);
  });

  r.post('/accounts/logout', async (ctx) => noContent2(await endSession(ctx.db, ctx.config, ctx.req)));

  r.get('/me', async (ctx) => {
    if (!ctx.user) return json({ user: null });
    return json({ user: await myself(ctx.db, ctx.user.id) });
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
    return json({ user: await myself(ctx.db, me.id) });
  });
}

const noContent2 = (cookie: string) => ({ ...noContent(), headers: { 'Set-Cookie': cookie } });

export const INVITE_DAYS = 7;

/**
 * Invite an address and email it. An open invite for the same address is renewed (new expiry, the
 * higher role kept) rather than doubled. The row and the email go together: if the email cannot be
 * sent, no invite is left behind. Used by staff in the app and by the CLI.
 */
export async function inviteByEmail(db: Db, config: Config, opts: { email: string; createdBy?: string | null; note?: string; days?: number; role?: 'member' | 'staff' }): Promise<{ expiresAt: string; renewed: boolean }> {
  const eh = emailHash(config, opts.email);
  const days = opts.days || INVITE_DAYS;
  const role = opts.role || 'member';
  return db.tx(async (t) => {
    const open = await t.one<{ expires_at: string; role: string }>(
      `UPDATE invites SET expires_at = now() + make_interval(days => $2), role = CASE WHEN role = 'staff' OR $3 = 'staff' THEN 'staff' ELSE 'member' END
       WHERE email_hash = $1 AND used_at IS NULL RETURNING expires_at, role`, [eh, days, role]);
    const row = open ?? await t.one<{ expires_at: string; role: string }>(
      `INSERT INTO invites (code_hash, email_hash, created_by, note, role, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
       RETURNING expires_at, role`, [randomBytes(32), eh, opts.createdBy || null, (opts.note || '').slice(0, 80), role, days]);
    const expiresAt = new Date(row!.expires_at).toISOString();
    await sendMail(config, opts.email, inviteEmail(config, { expiresAt, staff: row!.role === 'staff' }));
    return { expiresAt, renewed: !!open };
  });
}
