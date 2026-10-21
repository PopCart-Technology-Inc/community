// Live site review roulette. Anyone (signed in or not) sends a website to be reviewed on the PopCart
// Community live: one entry per device per round, with every consent point agreed and a typed
// signature. Staff check each entry before it joins the wheel, then run the round from the host
// screen: open and close entries, start a new round, and spin. The server draws (crypto.randomInt);
// the wheel only shows it.
//
// Holding one entry per device: a random code in an essential cookie (`rv`), kept as a keyed hash; the
// internet address is kept the same way, only to cap entries from one address (shared mobile
// addresses are common, so the cap is loose). Both hashes are cleared when the next round starts.
// Entries are deleted 90 days after they were sent (swept on a timer, see sweepReviews).
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import type { Config } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { fail, isUuid, json, noContent, type Ctx, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { readCookie, requireStaff } from '../../http/session.ts';
import { bad, oneOf, str } from '../shared.ts';

/**
 * The consent text version an entry agreed to. The text itself is in app/web/static/screens/review.js,
 * which sends its own copy of this version: change both whenever the text changes (a test holds them equal).
 */
export const CONSENT_VERSION = '2026-10-22';
/** Every point must be agreed, in this order (the web shows the same keys). */
export const CONSENTS = ['shown', 'recorded', 'owner', 'clean', 'draw', 'data'] as const;
export const KEEP_DAYS = 90;
/** Entries one internet address may send in a round (many people can share one mobile address). */
export const PER_ADDRESS = 5;
const COOKIE = 'rv';
const COOKIE_DAYS = 120;
/** Staff may set these; `pending` is only ever the start, `picked` only ever the draw. */
const SETTABLE = ['waiting', 'reviewed', 'skipped'] as const;

interface Round { id: string; code: string; accepting: boolean; created_at: string }
interface Entry { id: string; url: string; name: string; handle: string; status: string; created_at: string; picked_at: string | null; done_at: string | null }

const ENTRY_COLS = 'id, url, name, handle, status, created_at, picked_at, done_at';

const keyed = (config: Config, what: string, roundId: string, value: string): Buffer => {
  if (!config.emailKey) return fail(503, 'not_set_up', 'Entries are not set up on this server');
  return createHmac('sha256', config.emailKey).update(`review-${what}:${roundId}:${value}`).digest();
};

/** This device's code from the `rv` cookie, or a new one with the Set-Cookie header to keep it. */
function device(ctx: Ctx): { token: string; setCookie: Record<string, string> } {
  const have = readCookie(ctx.req, COOKIE);
  if (have && /^[A-Za-z0-9_-]{43}$/.test(have)) return { token: have, setCookie: {} };
  const token = randomBytes(32).toString('base64url');
  const secure = ctx.config.origin.startsWith('https://') ? '; Secure' : '';
  return { token, setCookie: { 'Set-Cookie': `${COOKIE}=${token}; Path=/api/review; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}${secure}` } };
}

/** The current round is the newest one; null before the first. */
const current = (db: Db) => db.one<Round>('SELECT id, code, accepting, created_at FROM review_rounds ORDER BY created_at DESC LIMIT 1');

/** Delete entries older than KEEP_DAYS. The server runs it on a timer (app/main.ts). */
export async function sweepReviews(db: Db): Promise<number> {
  return (await db.query(`DELETE FROM review_entries WHERE created_at < now() - make_interval(days => $1) RETURNING 1`, [KEEP_DAYS])).length;
}
// Requests sweep too, at most every 10 minutes, so a missed timer never keeps an entry for long.
let swept = 0;
// A failed sweep is logged, never turned into an error for the person visiting.
const maybeSweep = async (db: Db) => {
  if (Date.now() - swept <= 600_000) return;
  swept = Date.now();
  await sweepReviews(db).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'review sweep failed', err: String(e) })));
};

/** "live-202610221936": the Manila time (UTC+8, no DST) the round was made, to the minute. */
export function roundCode(at = new Date()): string {
  const d = new Date(at.getTime() + 8 * 3600_000).toISOString();
  return 'live-' + d.slice(0, 16).replace(/[-T:]/g, '');
}

/**
 * A public website address: http(s) only, a real host name (no IP address, no localhost, no internal
 * names), no user name or password in it, at most 300 characters. Returns the normalised address.
 */
export function siteUrl(v: unknown): string {
  let s = str(v, 'url', { min: 4, max: 300 });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // "javascript:…", "mailto:…" are schemes; "mysite.com:8080" is a site with a port
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return bad('url', 'must start with https://');
    s = 'https://' + s;
  }
  let u: URL;
  try { u = new URL(s); } catch { return bad('url', 'is not a website address'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad('url', 'must start with https://');
  if (u.username || u.password) return bad('url', 'must not carry a user name or password');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return bad('url', 'must be a site name, not an IP address');
  if (!host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|home|test|invalid|example)$/.test(host)) return bad('url', 'must be a public website');
  if (u.href.length > 300) return bad('url', 'can be at most 300 characters');
  return u.href;
}

async function hostView(db: Db) {
  const round = await current(db);
  const entries = round ? await db.query<Entry>(`SELECT ${ENTRY_COLS} FROM review_entries WHERE round_id = $1 ORDER BY created_at, id`, [round.id]) : [];
  const n = (st: string) => entries.filter((e) => e.status === st).length;
  return {
    round,
    entries,
    counts: { in: entries.length - n('pending'), left: n('waiting'), to_check: n('pending') },
    as_of: new Date().toISOString(),
  };
}

export function register(r: Router): void {
  // ---- For everyone: is a round open, and does this device have an entry in it? ----
  r.get('/review', async (ctx) => {
    await maybeSweep(ctx.db);
    const round = await current(ctx.db);
    const dev = device(ctx);
    const entered = !!(round && ctx.config.emailKey && await ctx.db.one('SELECT 1 FROM review_entries WHERE round_id = $1 AND device_hash = $2', [round.id, keyed(ctx.config, 'device', round.id, dev.token)]));
    return json({ round: round && { code: round.code, accepting: round.accepting }, entered, consent_version: CONSENT_VERSION, keep_days: KEEP_DAYS, as_of: new Date().toISOString() }, 200, dev.setCookie);
  });

  r.post('/review/entries', async (ctx) => {
    limit(limits.auth, 'review:' + ctx.ip);
    const b = await ctx.json<Record<string, unknown>>();
    const url = siteUrl(b.url);
    const name = str(b.name, 'name', { min: 1, max: 60 });
    let handle = str(b.handle, 'handle', { max: 40, optional: true, pattern: /^@?[\p{L}\p{N}._-]+$/u });
    if (handle && !handle.startsWith('@')) handle = '@' + handle;
    const signature = str(b.signature, 'signature', { min: 2, max: 80, pattern: /\p{L}/u });
    if (b.consent_version !== CONSENT_VERSION) return fail(409, 'consent_changed', 'The consent text has changed. Reload the page and read it again.');
    const agreed = (b.consents && typeof b.consents === 'object' ? b.consents : {}) as Record<string, unknown>;
    for (const k of CONSENTS) if (agreed[k] !== true) return bad('consents', 'every point must be agreed');
    await maybeSweep(ctx.db);
    const round = await current(ctx.db);
    if (!round || !round.accepting) return fail(409, 'closed', 'Entries are closed until the next live.');
    const dev = device(ctx);
    const ipHash = keyed(ctx.config, 'ip', round.id, ctx.ip);
    const entry = await ctx.db.tx(async (tx) => {
      // lock the round row: the per-address count cannot be raced, and closing entries or starting a
      // new round (which locks the same row) waits for this entry or makes it fail here
      const locked = await tx.one<{ accepting: boolean }>('SELECT accepting FROM review_rounds WHERE id = $1 FOR UPDATE', [round.id]);
      const newest = await tx.one<{ id: string }>('SELECT id FROM review_rounds ORDER BY created_at DESC LIMIT 1');
      if (!locked || !locked.accepting || newest?.id !== round.id) return fail(409, 'closed', 'Entries are closed until the next live.');
      const here = Number((await tx.one<{ n: string }>('SELECT count(*) AS n FROM review_entries WHERE round_id = $1 AND ip_hash = $2', [round.id, ipHash]))?.n || 0);
      if (here >= PER_ADDRESS) return fail(429, 'too_many_here', 'Too many entries from this internet connection in this round.');
      return tx.one<{ id: string; created_at: string }>(
        `INSERT INTO review_entries (round_id, url, name, handle, signature, consent_version, device_hash, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (round_id, device_hash) DO NOTHING RETURNING id, created_at`,
        [round.id, url, name, handle, signature, CONSENT_VERSION, keyed(ctx.config, 'device', round.id, dev.token), ipHash]);
    });
    if (!entry) return fail(409, 'already_entered', 'This device already has an entry in this round. One entry per live.');
    return json({ entry: { url, name, handle, round: round.code, consented_at: entry.created_at } }, 201, dev.setCookie);
  });

  // ---- The host screen (staff) ----
  r.get('/review/host', async (ctx) => {
    requireStaff(ctx);
    await maybeSweep(ctx.db);
    return json(await hostView(ctx.db));
  });

  r.post('/review/rounds', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    const code = roundCode();
    await ctx.db.tx(async (tx) => {
      // lock the round being replaced, so an entry still being written finishes first (and its hashes
      // are cleared below) or sees the new round and is refused
      await tx.query('SELECT id FROM review_rounds WHERE id = (SELECT id FROM review_rounds ORDER BY created_at DESC LIMIT 1) FOR UPDATE');
      // two rounds in the same minute: the next takes a suffix (-2, -3…)
      let made = null;
      for (let i = 1; !made && i <= 20; i++) {
        made = await tx.one<{ id: string }>('INSERT INTO review_rounds (code, created_by) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING id', [i === 1 ? code : `${code}-${i}`, me.id]);
      }
      if (!made) return fail(409, 'busy', 'Too many rounds this minute');
      // the hashes only hold one entry per device and cap an address within a round: drop them now
      await tx.query('UPDATE review_entries SET device_hash = NULL, ip_hash = NULL WHERE round_id <> $1 AND (device_hash IS NOT NULL OR ip_hash IS NOT NULL)', [made.id]);
    });
    return json(await hostView(ctx.db), 201);
  });

  r.patch('/review/rounds/current', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    if (typeof b.accepting !== 'boolean') return bad('accepting', 'must be true or false');
    const round = await current(ctx.db) ?? fail(409, 'no_round', 'Start a round first');
    await ctx.db.query('UPDATE review_rounds SET accepting = $1 WHERE id = $2', [b.accepting, round.id]);
    return json(await hostView(ctx.db));
  });

  /** Draw the next site. `pool` is the wheel as it was drawn from (waiting entries, oldest first). */
  r.post('/review/spin', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    const round = await current(ctx.db) ?? fail(409, 'no_round', 'Start a round first');
    const out = await ctx.db.tx(async (tx) => {
      // lock the round first: two host screens spinning at once take turns (and the
      // review_entries_one_picked index refuses a second pick in any case)
      await tx.query('SELECT 1 FROM review_rounds WHERE id = $1 FOR UPDATE', [round.id]);
      if (await tx.one(`SELECT 1 FROM review_entries WHERE round_id = $1 AND status = 'picked'`, [round.id])) {
        return fail(409, 'still_picked', 'Mark the current site reviewed or skipped first');
      }
      const pool = await tx.query<Entry>(`SELECT ${ENTRY_COLS} FROM review_entries WHERE round_id = $1 AND status = 'waiting' ORDER BY created_at, id`, [round.id]);
      if (!pool.length) return fail(409, 'empty', 'No entries left to draw');
      const pick = pool[randomInt(pool.length)] as Entry;
      await tx.query(`UPDATE review_entries SET status = 'picked', picked_at = now() WHERE id = $1`, [pick.id]);
      return { pool: pool.map((e) => ({ id: e.id, name: e.name })), picked: pick.id };
    });
    return json({ ...out, ...(await hostView(ctx.db)) });
  });

  /** Let a checked entry into the draw (waiting), mark one reviewed or skipped, or put it back in. */
  r.patch('/review/entries/:id', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such entry');
    const b = await ctx.json<Record<string, unknown>>();
    const status = oneOf(b.status, 'status', SETTABLE);
    const done = await ctx.db.one(
      `UPDATE review_entries SET status = $2, done_at = CASE WHEN $2 = 'waiting' THEN NULL ELSE now() END,
         picked_at = CASE WHEN $2 = 'waiting' THEN NULL ELSE picked_at END WHERE id = $1 RETURNING 1`, [ctx.params.id, status]);
    if (!done) return fail(404, 'not_found', 'No such entry');
    return json(await hostView(ctx.db));
  });

  /** Remove an entry for good: it broke the rules, or the person asked to withdraw. */
  r.delete('/review/entries/:id', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such entry');
    if (!(await ctx.db.one('DELETE FROM review_entries WHERE id = $1 RETURNING 1', [ctx.params.id]))) return fail(404, 'not_found', 'No such entry');
    return noContent();
  });
}
