// Work: gigs, applications with signed proof, picking, marking done, criteria ratings, and the live work
// record on a profile. Community never holds money: a gig only says how the poster pays (`paid_how`),
// and the two people settle it between themselves. Contract: docs/api.md, "Work".
import type { Db } from '../../db/index.ts';
import { fail, isUuid, json, noContent, type Ctx, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { requireUser } from '../../http/session.ts';
import { LEVELS, PERSON_COLS, bad, int, oneOf, page, resolveArea, str, type AreaCodes, type Person } from '../shared.ts';
import { registerCredentials } from './credentials.ts';
import {
  GIG_RULE, GIG_WEIGHTS, NEWEST_RULE, distanceHint, freshSignal, gigScore, nearSignal, tradeSignal, trustSignal, type GigSignals,
} from './weights.ts';

export const PAY_UNITS = ['fixed', 'hour', 'day', 'night', 'run'] as const;
export const GIG_STATUSES = ['open', 'filled', 'closed'] as const;
export const TABS = ['for_you', 'newest', 'saved', 'mine'] as const;
export const MAX_PAY = 10_000_000;
/** How far back "For you" looks, and how many candidates it scores. */
const FOR_YOU_DAYS = 30;
const FOR_YOU_POOL = 500;

interface GigRow {
  id: string; poster_id: string; title: string; body: string; pay_amount: number; pay_currency: string; pay_unit: string;
  pay_note: string; when_text: string; paid_how: string; skills: string[]; area_code: string | null; area_name: string | null;
  barangay_code: string | null; city_code: string | null; region_code: string | null; country_code: string | null;
  status: string; created_at: Date; space_id: string | null; poster: Person; applicants: number; saved: boolean;
  poster_ratings: number; poster_avg: number | null;
}

interface Viewer { id: string; trade: string; codes: AreaCodes | null }

/** Every gig query goes through here. $1 is always the viewer id (or null). Private-Space gigs: members only. */
function gigSelect(join = ''): string {
  return `SELECT g.id, g.poster_id, g.title, g.body, g.pay_amount, g.pay_currency, g.pay_unit, g.pay_note, g.when_text, g.paid_how,
      g.skills, g.area_code, a.name AS area_name, g.barangay_code, g.city_code, g.region_code, g.country_code, g.status,
      g.created_at, g.space_id,
      (SELECT row_to_json(p) FROM (SELECT ${PERSON_COLS} FROM users u WHERE u.id = g.poster_id) p) AS poster,
      (SELECT count(*)::int FROM applications ap WHERE ap.gig_id = g.id AND ap.status <> 'withdrawn') AS applicants,
      EXISTS (SELECT 1 FROM saves sv WHERE sv.gig_id = g.id AND sv.user_id = $1::uuid) AS saved,
      (SELECT count(*)::int FROM ratings rt WHERE rt.ratee_id = g.poster_id) AS poster_ratings,
      (SELECT avg((rt.on_time + rt.quality + rt.easy + rt.again) / 4.0)::float8 FROM ratings rt WHERE rt.ratee_id = g.poster_id) AS poster_avg
    FROM gigs g
    JOIN users pu ON pu.id = g.poster_id AND pu.status = 'active'
    LEFT JOIN areas a ON a.code = g.area_code
    ${join}
    WHERE (g.space_id IS NULL OR EXISTS (SELECT 1 FROM spaces sp WHERE sp.id = g.space_id AND (sp.visibility = 'public'
      OR EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = sp.id AND sm.user_id = $1::uuid))))`;
}

function toGig(r: GigRow, viewer: Viewer | null) {
  return {
    id: r.id, poster: r.poster, title: r.title, body: r.body,
    pay_amount: r.pay_amount, pay_currency: r.pay_currency, pay_unit: r.pay_unit, pay_note: r.pay_note,
    when_text: r.when_text, paid_how: r.paid_how, skills: r.skills,
    place: r.area_code ? { code: r.area_code, name: r.area_name } : null,
    distance_hint: viewer?.codes ? distanceHint(viewer.codes, r) : null,
    status: r.status, applicants: r.applicants, created_at: r.created_at, saved: r.saved, space_id: r.space_id,
  };
}

async function loadViewer(ctx: Ctx): Promise<Viewer | null> {
  if (!ctx.user) return null;
  const u = await ctx.db.one<{ trade: string; home_area: string | null }>('SELECT trade, home_area FROM users WHERE id = $1', [ctx.user.id]);
  if (!u) return null;
  return { id: ctx.user.id, trade: u.trade, codes: u.home_area ? await resolveArea(ctx.db, u.home_area) : null };
}

async function getGigRow(db: Db, id: string, viewerId: string | null): Promise<GigRow | null> {
  if (!isUuid(id)) return null;
  return db.one<GigRow>(`${gigSelect()} AND g.id = $2`, [viewerId, id]);
}

async function idChecked(db: Db, userId: string): Promise<boolean> {
  return !!(await db.one(`SELECT 1 FROM credentials WHERE user_id = $1 AND verified AND type = 'IdentityCheck'`, [userId]));
}

/** The live work record of a person: ratings received, gigs posted and done, paid-on-time share. */
export async function workSummary(db: Db, userId: string) {
  const r = await db.one<{ count: number; on_time: number | null; quality: number | null; easy: number | null; again: number | null }>(
    `SELECT count(*)::int AS count, round(avg(on_time), 2)::float8 AS on_time, round(avg(quality), 2)::float8 AS quality,
       round(avg(easy), 2)::float8 AS easy, round(avg(again), 2)::float8 AS again FROM ratings WHERE ratee_id = $1`, [userId]);
  const c = await db.one<{ posted: number; done: number; paid_good: number; paid_n: number }>(
    `SELECT (SELECT count(*)::int FROM gigs WHERE poster_id = $1) AS posted,
       (SELECT count(*)::int FROM applications WHERE applicant_id = $1 AND status = 'picked'
          AND done_by_poster IS NOT NULL AND done_by_applicant IS NOT NULL) AS done,
       (SELECT count(*)::int FROM ratings rt JOIN gigs g ON g.id = rt.gig_id WHERE rt.ratee_id = $1 AND g.poster_id = $1 AND rt.on_time >= 4) AS paid_good,
       (SELECT count(*)::int FROM ratings rt JOIN gigs g ON g.id = rt.gig_id WHERE rt.ratee_id = $1 AND g.poster_id = $1) AS paid_n`, [userId]);
  return {
    ratings: { count: r?.count ?? 0, on_time: r?.on_time ?? null, quality: r?.quality ?? null, easy: r?.easy ?? null, again: r?.again ?? null },
    gigs_posted: c?.posted ?? 0,
    gigs_done: c?.done ?? 0,
    // Workers rate the poster's on_time as "paid on time". Share of those ratings at 4 or 5; null until there is one.
    paid_on_time_share: c && c.paid_n ? Math.round((c.paid_good / c.paid_n) * 100) / 100 : null,
    as_of: new Date().toISOString(),
  };
}

function skillsList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 8) return bad('skills', 'must be a list of at most 8');
  const out = v.map((s, i) => str(s, `skills[${i}]`, { min: 2, max: 30, pattern: /^[\p{L}\p{N} .&-]+$/u }).toLowerCase());
  return [...new Set(out)];
}

const score = (v: unknown, field: string): number => int(v, field, 1, 5);

async function loadApplication(db: Db, id: string | undefined) {
  if (!isUuid(id)) return null;
  return db.one<{ id: string; gig_id: string; applicant_id: string; status: string; poster_id: string; gig_status: string }>(
    `SELECT ap.id, ap.gig_id, ap.applicant_id, ap.status, g.poster_id, g.status AS gig_status
     FROM applications ap JOIN gigs g ON g.id = ap.gig_id WHERE ap.id = $1`, [id]);
}

export function register(r: Router): void {
  registerCredentials(r);

  // ---- Gigs ----
  r.get('/gigs', async (ctx) => {
    const tab = oneOf(ctx.query.get('tab'), 'tab', TABS, 'newest');
    const viewer = await loadViewer(ctx);
    if (tab !== 'newest' && !viewer) return fail(401, 'sign_in', 'Sign in first');
    const { limit: n, before } = page(ctx.query);
    const params: unknown[] = [viewer?.id ?? null];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

    const levelQ = ctx.query.get('level');
    if (levelQ) {
      const level = oneOf(levelQ, 'level', LEVELS);
      if (level !== 'world') {
        const code = ctx.query.get('code') || viewer?.codes?.area_code;
        if (!code) return bad('code', 'is required for this level (or set your home area)');
        const codes = await resolveArea(ctx.db, code);
        const at = codes[`${level}_code`];
        if (!at) return bad('code', `is not inside a ${level}`);
        add(`g.${level}_code = ?`, at);
      }
    }
    const trade = ctx.query.get('trade');
    if (trade) add('? = ANY(g.skills)', str(trade, 'trade', { max: 30 }).toLowerCase());
    const minPay = ctx.query.get('min_pay');
    if (minPay) add('g.pay_amount >= ?', int(minPay, 'min_pay', 1, MAX_PAY));

    const as_of = new Date();
    if (tab === 'for_you') {
      const me = viewer as Viewer;
      add('g.created_at > ?', new Date(as_of.getTime() - FOR_YOU_DAYS * 86400_000).toISOString());
      const rows = await ctx.db.query<GigRow>(
        `${gigSelect()} AND g.status = 'open' AND g.poster_id <> $1::uuid ${where.map((w) => `AND ${w}`).join(' ')}
         ORDER BY g.created_at DESC LIMIT ${FOR_YOU_POOL}`, params);
      const ranked = rows.map((row) => {
        const signals: GigSignals = {
          near: nearSignal(me.codes, row),
          trade: tradeSignal(me.trade, row.skills),
          trust: trustSignal(row.poster_ratings, row.poster_avg),
          fresh: freshSignal(new Date(row.created_at), as_of),
        };
        return { row, signals, score: gigScore(signals) };
      }).sort((a, b) => b.score - a.score || new Date(b.row.created_at).getTime() - new Date(a.row.created_at).getTime());
      const gigs = ranked.slice(0, n).map(({ row, signals, score: s }) => ({ ...toGig(row, me), signals: { ...signals, score: Math.round(s * 1000) / 1000 } }));
      return json({ gigs, tab, rule: GIG_RULE, weights: GIG_WEIGHTS, as_of: as_of.toISOString() });
    }

    let sql: string;
    if (tab === 'saved') {
      if (before) add('mysave.created_at < ?', before);
      sql = `${gigSelect('JOIN saves mysave ON mysave.gig_id = g.id AND mysave.user_id = $1::uuid')} ${where.map((w) => `AND ${w}`).join(' ')}
        ORDER BY mysave.created_at DESC LIMIT ${n}`;
    } else if (tab === 'mine') {
      if (before) add('g.created_at < ?', before);
      sql = `${gigSelect()} AND g.poster_id = $1::uuid ${where.map((w) => `AND ${w}`).join(' ')} ORDER BY g.created_at DESC LIMIT ${n}`;
    } else {
      if (before) add('g.created_at < ?', before);
      sql = `${gigSelect()} AND g.status = 'open' ${where.map((w) => `AND ${w}`).join(' ')} ORDER BY g.created_at DESC LIMIT ${n}`;
    }
    const rows = await ctx.db.query<GigRow>(sql, params);
    const rule = tab === 'newest' ? NEWEST_RULE : tab === 'saved' ? 'Saved: gigs you saved, last saved first.' : 'Mine: gigs you posted, newest first.';
    return json({ gigs: rows.map((row) => toGig(row, viewer)), tab, rule, as_of: as_of.toISOString() });
  });

  r.post('/gigs', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    if (!(await idChecked(ctx.db, me.id))) return fail(403, 'id_check', 'Posting work needs the ID check (an IdentityCheck credential)');
    const b = await ctx.json<Record<string, unknown>>();
    const title = str(b.title, 'title', { min: 5, max: 80 });
    const body = str(b.body, 'body', { min: 10, max: 2000 });
    const pay_amount = int(b.pay_amount, 'pay_amount', 1, MAX_PAY);
    const pay_unit = oneOf(b.pay_unit, 'pay_unit', PAY_UNITS);
    const pay_note = str(b.pay_note, 'pay_note', { max: 60, optional: true });
    const when_text = str(b.when_text, 'when_text', { min: 2, max: 80 });
    const paid_how = str(b.paid_how, 'paid_how', { min: 2, max: 60 });
    const skills = skillsList(b.skills);
    let areaCode = b.area_code === undefined || b.area_code === null || b.area_code === '' ? null : str(b.area_code, 'area_code', { max: 40 });
    if (!areaCode) areaCode = (await ctx.db.one<{ home_area: string | null }>('SELECT home_area FROM users WHERE id = $1', [me.id]))?.home_area ?? null;
    const codes = await resolveArea(ctx.db, areaCode);
    let spaceId: string | null = null;
    if (b.space_id !== undefined && b.space_id !== null && b.space_id !== '') {
      if (typeof b.space_id !== 'string' || !isUuid(b.space_id)) return bad('space_id', 'is not a Space');
      if (!(await ctx.db.one('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', [b.space_id, me.id]))) {
        return fail(403, 'not_member', 'Posting work in a Space needs membership');
      }
      spaceId = b.space_id;
    }
    const row = await ctx.db.one<{ id: string }>(
      `INSERT INTO gigs (poster_id, space_id, title, body, pay_amount, pay_unit, pay_note, when_text, paid_how, skills,
         area_code, barangay_code, city_code, region_code, country_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [me.id, spaceId, title, body, pay_amount, pay_unit, pay_note, when_text, paid_how, skills,
        codes.area_code, codes.barangay_code, codes.city_code, codes.region_code, codes.country_code]);
    const viewer = await loadViewer(ctx);
    return json({ gig: toGig((await getGigRow(ctx.db, row!.id, me.id))!, viewer) }, 201);
  });

  r.get('/gigs/:id', async (ctx) => {
    const viewer = await loadViewer(ctx);
    const row = await getGigRow(ctx.db, ctx.params.id as string, viewer?.id ?? null);
    if (!row) return fail(404, 'not_found', 'No such gig');
    const my_application = viewer
      ? await ctx.db.one(`SELECT id, note, credential_ids, status, done_by_poster, done_by_applicant, created_at FROM applications
          WHERE gig_id = $1 AND applicant_id = $2`, [row.id, viewer.id])
      : null;
    return json({ gig: toGig(row, viewer), poster: { ...row.poster, trust: await workSummary(ctx.db, row.poster_id) }, my_application });
  });

  r.patch('/gigs/:id', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const row = await getGigRow(ctx.db, ctx.params.id as string, me.id);
    if (!row) return fail(404, 'not_found', 'No such gig');
    if (row.poster_id !== me.id) return fail(403, 'not_poster', 'Only the poster can change this gig');
    const { status } = await ctx.json<{ status?: unknown }>();
    await ctx.db.query('UPDATE gigs SET status = $2 WHERE id = $1', [row.id, oneOf(status, 'status', GIG_STATUSES)]);
    return json({ gig: toGig((await getGigRow(ctx.db, row.id, me.id))!, await loadViewer(ctx)) });
  });

  r.post('/gigs/:id/save', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const row = await getGigRow(ctx.db, ctx.params.id as string, me.id);
    if (!row) return fail(404, 'not_found', 'No such gig');
    await ctx.db.query('INSERT INTO saves (user_id, gig_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me.id, row.id]);
    return noContent();
  });

  r.delete('/gigs/:id/save', async (ctx) => {
    const me = requireUser(ctx);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such gig');
    await ctx.db.query('DELETE FROM saves WHERE user_id = $1 AND gig_id = $2', [me.id, ctx.params.id]);
    return noContent();
  });

  // ---- Applications ----
  r.post('/gigs/:id/applications', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const row = await getGigRow(ctx.db, ctx.params.id as string, me.id);
    if (!row) return fail(404, 'not_found', 'No such gig');
    if (row.poster_id === me.id) return fail(403, 'own_gig', 'You cannot apply to your own gig');
    if (row.status !== 'open') return fail(409, 'not_open', 'This gig is no longer open');
    const b = await ctx.json<{ note?: unknown; credential_ids?: unknown }>();
    const note = str(b.note, 'note', { max: 1000, optional: true });
    const ids = b.credential_ids ?? [];
    if (!Array.isArray(ids) || ids.length > 10 || !ids.every((x) => typeof x === 'string' && isUuid(x))) {
      return bad('credential_ids', 'must be a list of at most 10 credential ids');
    }
    const unique = [...new Set(ids as string[])];
    if (unique.length) {
      const mine = await ctx.db.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM credentials WHERE user_id = $1 AND id = ANY($2::uuid[]) AND verified AND shown', [me.id, unique]);
      if ((mine?.n ?? 0) !== unique.length) return fail(400, 'credential', 'You can attach only your own shown, verified credentials');
    }
    const application = await ctx.db.one(
      `INSERT INTO applications (gig_id, applicant_id, note, credential_ids) VALUES ($1, $2, $3, $4::uuid[])
       ON CONFLICT (gig_id, applicant_id) DO NOTHING RETURNING id, gig_id, note, credential_ids, status, created_at`, [row.id, me.id, note, unique]);
    if (!application) return fail(409, 'already_applied', 'You already applied to this gig');
    await ctx.db.query(`INSERT INTO notifications (user_id, kind, actor_id, ref_kind, ref_id) VALUES ($1, 'application', $2, 'gig', $3)`, [row.poster_id, me.id, row.id]);
    return json({ application }, 201);
  });

  r.get('/gigs/:id/applications', async (ctx) => {
    const me = requireUser(ctx);
    const row = await getGigRow(ctx.db, ctx.params.id as string, me.id);
    if (!row) return fail(404, 'not_found', 'No such gig');
    if (row.poster_id !== me.id) return fail(403, 'not_poster', 'Only the poster sees the applications');
    // Credentials show only while the applicant still has them shown and verified: the person decides.
    const applications = await ctx.db.query(
      `SELECT ap.id, (SELECT row_to_json(p) FROM (SELECT ${PERSON_COLS} FROM users u WHERE u.id = ap.applicant_id) p) AS person,
         ap.note, ap.status, ap.done_by_poster, ap.done_by_applicant, ap.created_at,
         coalesce((SELECT json_agg(json_build_object('id', c.id, 'issuer', c.issuer, 'type', c.type, 'summary', c.summary, 'as_of', c.as_of, 'verified', c.verified) ORDER BY c.as_of DESC)
           FROM credentials c WHERE c.id = ANY(ap.credential_ids) AND c.user_id = ap.applicant_id AND c.verified AND c.shown), '[]'::json) AS credentials
       FROM applications ap JOIN users au ON au.id = ap.applicant_id AND au.status = 'active'
       WHERE ap.gig_id = $1 ORDER BY ap.created_at DESC`, [row.id]);
    return json({ applications, as_of: new Date().toISOString() });
  });

  r.post('/applications/:id/pick', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const ap = await loadApplication(ctx.db, ctx.params.id);
    if (!ap) return fail(404, 'not_found', 'No such application');
    if (ap.poster_id !== me.id) return fail(403, 'not_poster', 'Only the poster can pick');
    if (ap.status !== 'sent') return fail(409, 'not_sent', 'This application cannot be picked');
    const picked = await ctx.db.tx(async (t) => {
      const filled = await t.one(`UPDATE gigs SET status = 'filled' WHERE id = $1 AND status = 'open' RETURNING 1`, [ap.gig_id]);
      if (!filled) return false;
      await t.query(`UPDATE applications SET status = 'picked' WHERE id = $1`, [ap.id]);
      await t.query(`INSERT INTO notifications (user_id, kind, actor_id, ref_kind, ref_id) VALUES ($1, 'picked', $2, 'gig', $3)`, [ap.applicant_id, me.id, ap.gig_id]);
      return true;
    });
    if (!picked) return fail(409, 'not_open', 'This gig is no longer open');
    return noContent();
  });

  r.post('/applications/:id/done', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const ap = await loadApplication(ctx.db, ctx.params.id);
    if (!ap) return fail(404, 'not_found', 'No such application');
    const isPoster = ap.poster_id === me.id;
    if (!isPoster && ap.applicant_id !== me.id) return fail(403, 'not_part', 'Only the poster or the picked person can mark this done');
    if (ap.status !== 'picked') return fail(409, 'not_picked', 'Only a picked application can be marked done');
    const col = isPoster ? 'done_by_poster' : 'done_by_applicant';
    await ctx.db.query(`UPDATE applications SET ${col} = coalesce(${col}, now()) WHERE id = $1`, [ap.id]);
    return noContent();
  });

  // ---- Ratings: both directions, once per gig per rater, only after both sides marked done ----
  r.post('/gigs/:id/ratings', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const row = await getGigRow(ctx.db, ctx.params.id as string, me.id);
    if (!row) return fail(404, 'not_found', 'No such gig');
    let ratee: string;
    if (row.poster_id === me.id) {
      const done = await ctx.db.one<{ applicant_id: string }>(
        `SELECT applicant_id FROM applications WHERE gig_id = $1 AND status = 'picked'
           AND done_by_poster IS NOT NULL AND done_by_applicant IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [row.id]);
      if (!done) return fail(409, 'not_done', 'Rate after both of you mark the work done');
      ratee = done.applicant_id;
    } else {
      const mine = await ctx.db.one<{ status: string; all_done: boolean }>(
        `SELECT status, (done_by_poster IS NOT NULL AND done_by_applicant IS NOT NULL) AS all_done
         FROM applications WHERE gig_id = $1 AND applicant_id = $2`, [row.id, me.id]);
      if (!mine || mine.status !== 'picked') return fail(403, 'not_part', 'Only the poster and the picked person can rate this gig');
      if (!mine.all_done) return fail(409, 'not_done', 'Rate after both of you mark the work done');
      ratee = row.poster_id;
    }
    const b = await ctx.json<Record<string, unknown>>();
    const vals = [score(b.on_time, 'on_time'), score(b.quality, 'quality'), score(b.easy, 'easy'), score(b.again, 'again')];
    const rating = await ctx.db.one(
      `INSERT INTO ratings (gig_id, rater_id, ratee_id, on_time, quality, easy, again) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (gig_id, rater_id) DO NOTHING RETURNING id, gig_id, on_time, quality, easy, again, created_at`, [row.id, me.id, ratee, ...vals]);
    if (!rating) return fail(409, 'already_rated', 'You already rated this gig');
    return json({ rating }, 201);
  });

  r.get('/people/:handle/work', async (ctx) => {
    const p = await ctx.db.one<{ id: string }>(`SELECT id FROM users WHERE handle = $1 AND status = 'active'`, [ctx.params.handle]);
    if (!p) return fail(404, 'not_found', 'No one has that username');
    return json(await workSummary(ctx.db, p.id));
  });
}
