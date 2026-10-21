// Live site review roulette. Anyone (signed in or not) sends a website to be reviewed on the PopCart
// Community live: one entry per person per round, with every consent point agreed and a typed
// signature. Staff run the round from the host screen: open and close entries, start a new round, and
// spin. The server draws (crypto.randomInt), the wheel only shows it. The sender's address is kept as
// a keyed hash scoped to the round, never in the clear; entries are deleted 90 days after they were sent.
import { createHmac, randomInt } from 'node:crypto';
import type { Config } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { fail, isUuid, json, noContent, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { requireStaff } from '../../http/session.ts';
import { bad, oneOf, str } from '../shared.ts';

/** The consent text version an entry agreed to. Change it whenever the points below change. */
export const CONSENT_VERSION = '2026-10-22';
/** Every point must be agreed, in this order (the web shows the same keys). */
export const CONSENTS = ['shown', 'recorded', 'owner', 'clean', 'draw', 'data'] as const;
export const KEEP_DAYS = 90;
const STATUSES = ['waiting', 'picked', 'reviewed', 'skipped'] as const;

interface Round { id: string; code: string; accepting: boolean; created_at: string }
interface Entry { id: string; url: string; name: string; handle: string; status: string; created_at: string; picked_at: string | null; done_at: string | null }

const ENTRY_COLS = 'id, url, name, handle, status, created_at, picked_at, done_at';

const ipHash = (config: Config, roundId: string, ip: string): Buffer => {
  if (!config.emailKey) return fail(503, 'not_set_up', 'Entries are not set up on this server');
  return createHmac('sha256', config.emailKey).update('review:' + roundId + ':' + ip).digest();
};

/** The current round is the newest one; null before the first. */
const current = (db: Db) => db.one<Round>('SELECT id, code, accepting, created_at FROM review_rounds ORDER BY created_at DESC LIMIT 1');

const sweep = (db: Db) => db.query(`DELETE FROM review_entries WHERE created_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);

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
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
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
  await sweep(db);
  const round = await current(db);
  const entries = round ? await db.query<Entry>(`SELECT ${ENTRY_COLS} FROM review_entries WHERE round_id = $1 ORDER BY created_at, id`, [round.id]) : [];
  return {
    round,
    entries,
    counts: { in: entries.length, left: entries.filter((e) => e.status === 'waiting').length },
    as_of: new Date().toISOString(),
  };
}

export function register(r: Router): void {
  // ---- For everyone: is a round open, and is my entry in it? ----
  r.get('/review', async (ctx) => {
    const round = await current(ctx.db);
    const entered = !!(round && ctx.config.emailKey && await ctx.db.one('SELECT 1 FROM review_entries WHERE round_id = $1 AND ip_hash = $2', [round.id, ipHash(ctx.config, round.id, ctx.ip)]));
    return json({ round: round && { code: round.code, accepting: round.accepting }, entered, consent_version: CONSENT_VERSION, keep_days: KEEP_DAYS, as_of: new Date().toISOString() });
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
    await sweep(ctx.db);
    const round = await current(ctx.db);
    if (!round || !round.accepting) return fail(409, 'closed', 'Entries are closed until the next live.');
    const entry = await ctx.db.one<{ id: string; created_at: string }>(
      `INSERT INTO review_entries (round_id, url, name, handle, signature, consent_version, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (round_id, ip_hash) DO NOTHING RETURNING id, created_at`,
      [round.id, url, name, handle, signature, CONSENT_VERSION, ipHash(ctx.config, round.id, ctx.ip)]);
    if (!entry) return fail(409, 'already_entered', 'You already have an entry in this round. One entry per live.');
    return json({ entry: { url, name, handle, round: round.code, consented_at: entry.created_at } }, 201);
  });

  // ---- The host screen (staff) ----
  r.get('/review/host', async (ctx) => {
    requireStaff(ctx);
    return json(await hostView(ctx.db));
  });

  r.post('/review/rounds', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    const code = roundCode();
    // two rounds in the same minute: the second takes a suffix
    const n = Number((await ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM review_rounds WHERE code LIKE $1', [code + '%']))?.n || 0);
    await ctx.db.query('INSERT INTO review_rounds (code, created_by) VALUES ($1, $2)', [n ? `${code}-${n + 1}` : code, me.id]);
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
      if (await tx.one(`SELECT 1 FROM review_entries WHERE round_id = $1 AND status = 'picked'`, [round.id])) {
        return fail(409, 'still_picked', 'Mark the current site reviewed or skipped first');
      }
      const pool = await tx.query<Entry>(`SELECT ${ENTRY_COLS} FROM review_entries WHERE round_id = $1 AND status = 'waiting' ORDER BY created_at, id FOR UPDATE`, [round.id]);
      if (!pool.length) return fail(409, 'empty', 'No entries left to draw');
      const pick = pool[randomInt(pool.length)] as Entry;
      await tx.query(`UPDATE review_entries SET status = 'picked', picked_at = now() WHERE id = $1`, [pick.id]);
      return { pool: pool.map((e) => ({ id: e.id, name: e.name })), picked: pick.id };
    });
    return json({ ...out, ...(await hostView(ctx.db)) });
  });

  /** Mark an entry reviewed or skipped, or put it back in the draw. */
  r.patch('/review/entries/:id', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such entry');
    const b = await ctx.json<Record<string, unknown>>();
    const status = oneOf(b.status, 'status', STATUSES.filter((s) => s !== 'picked'));
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
