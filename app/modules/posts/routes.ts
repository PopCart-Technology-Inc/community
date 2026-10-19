// Posts, replies, salamat, saves, the feeds and notifications (decisions 0003 and 0005). Following is
// newest first and never re-ordered; Places, Trade and Picks follow the published rules in weights.ts.
// Every list is one SQL query (no query per post) and carries `as_of`.
import { fail, isUuid, json, noContent, type Ctx, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { requireUser } from '../../http/session.ts';
import { TRADES } from '../accounts/routes.ts';
import {
  bad, LEVELS, levelIndex, manilaWeek, oneOf, page, PERSON_COLS, resolveArea, SALAMATS_PER_WEEK, str,
  type AreaCodes, type Level, type Person,
} from '../shared.ts';
import {
  distanceHint, fairMix, mixGroup, nextLevel, quietNext, rank, RULES, score, signalsFor, TRADE_RULE, WEIGHTS, type Viewer,
} from './weights.ts';

/** How many recent posts a ranked feed considers before ranking. */
const CANDIDATES = 300;
const MAX_MEDIA = 4;

// $1 is always the viewer's id (or null when signed out).
const POST_SELECT = `SELECT p.id, p.body, p.created_at, p.reply_to, p.space_id, p.media_ids, p.reach, p.lang,
    p.area_code, pa.name AS area_name, p.barangay_code, pb.name AS barangay_name, p.city_code, pc.name AS city_name,
    p.region_code, p.country_code, pn.name AS country_name, p.author_id, au.trade AS author_trade,
    (SELECT row_to_json(x) FROM (SELECT ${PERSON_COLS} FROM users u WHERE u.id = p.author_id) x) AS author,
    (SELECT count(DISTINCT s.giver_id)::int FROM salamats s WHERE s.post_id = p.id) AS salamats,
    (SELECT count(*)::int FROM posts r WHERE r.reply_to = p.id AND r.deleted_at IS NULL) AS replies,
    EXISTS (SELECT 1 FROM saves sv WHERE sv.post_id = p.id AND sv.user_id = $1::uuid) AS saved,
    EXISTS (SELECT 1 FROM salamats sg WHERE sg.post_id = p.id AND sg.giver_id = $1::uuid) AS salamat_given
  FROM posts p JOIN users au ON au.id = p.author_id
    LEFT JOIN areas pa ON pa.code = p.area_code LEFT JOIN areas pb ON pb.code = p.barangay_code
    LEFT JOIN areas pc ON pc.code = p.city_code LEFT JOIN areas pn ON pn.code = p.country_code`;

/** Not deleted, author active, and not inside a private Space the viewer is not in. */
const VISIBLE = `p.deleted_at IS NULL AND au.status = 'active' AND (p.space_id IS NULL
    OR EXISTS (SELECT 1 FROM spaces sp WHERE sp.id = p.space_id AND sp.visibility = 'public')
    OR EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = p.space_id AND sm.user_id = $1::uuid))`;

interface PostRow {
  id: string; body: string; created_at: string | Date; reply_to: string | null; space_id: string | null; media_ids: string[];
  reach: Level; lang: string | null; area_code: string | null; area_name: string | null;
  barangay_code: string | null; barangay_name: string | null; city_code: string | null; city_name: string | null;
  region_code: string | null; country_code: string | null; country_name: string | null;
  author_id: string; author_trade: string; author: Person;
  salamats: number; replies: number; saved: boolean; salamat_given: boolean;
}

/** The contract shape of a post. `level` sets the precision of `distance_hint`. */
function toPost(r: PostRow, level: Level, viewer: Viewer) {
  return {
    id: r.id, author: r.author, body: r.body, created_at: r.created_at, reply_to: r.reply_to, space_id: r.space_id,
    media_ids: r.media_ids, reach: r.reach, place: r.area_code ? { code: r.area_code, name: r.area_name } : null,
    distance_hint: distanceHint(level, r, viewer), salamats: r.salamats, replies: r.replies, saved: r.saved,
    salamat_given: r.salamat_given, lang: r.lang,
  };
}

const asCandidate = (r: PostRow) => ({ ...r, salamats_distinct: r.salamats });
const now = () => new Date();

interface Me { id: string | null; trade: string | null; home: AreaCodes }

/** The viewer's trade and home area codes (empty when signed out). */
async function viewerOf(ctx: Ctx): Promise<Me> {
  if (!ctx.user) return { id: null, trade: null, home: await resolveArea(ctx.db, null) };
  const u = await ctx.db.one<{ trade: string; home_area: string | null }>('SELECT trade, home_area FROM users WHERE id = $1', [ctx.user.id]);
  return { id: ctx.user.id, trade: u?.trade ?? null, home: await resolveArea(ctx.db, u?.home_area) };
}

/** Nearness is measured from the viewer's home area, or from the area being viewed when they have none. */
const reference = (me: Me, viewed: AreaCodes): Viewer => {
  const from = me.home.city_code ? me.home : viewed;
  return { barangay_code: from.barangay_code, city_code: from.city_code, trade: me.trade };
};

const codeAt = (codes: AreaCodes, level: Level): string | null =>
  level === 'world' ? 'WORLD' : codes[`${level}_code` as 'barangay_code' | 'city_code' | 'region_code' | 'country_code'];

/** The Places filter for a level: reach at least that wide, and the post's code at that level. */
function placesWhere(level: Level, levelCode: string, params: unknown[]): string {
  if (level === 'world') return `p.reach = 'world'`;
  params.push(LEVELS.slice(levelIndex(level)), levelCode);
  return `p.reach = ANY($${params.length - 1}::text[]) AND p.${level}_code = $${params.length}`;
}

async function visiblePost(ctx: Ctx, id: string | undefined, viewerId: string | null): Promise<PostRow> {
  if (!isUuid(id)) return fail(404, 'not_found', 'No such post');
  const row = await ctx.db.one<PostRow>(`${POST_SELECT} WHERE p.id = $2 AND ${VISIBLE}`, [viewerId, id]);
  return row ?? fail(404, 'not_found', 'No such post');
}

function tagsOf(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 3) return bad('tags', 'up to 3 short tags');
  return [...new Set(v.map((t) => str(t, 'tags', { min: 1, max: 24 }).toLowerCase()))];
}

async function salamatState(ctx: Ctx, postId: string, me: string) {
  const s = await ctx.db.one<{ salamats: number; used: number }>(
    `SELECT (SELECT count(DISTINCT giver_id)::int FROM salamats WHERE post_id = $1) AS salamats,
            (SELECT count(*)::int FROM salamats WHERE giver_id = $2 AND week = $3) AS used`, [postId, me, manilaWeek()]);
  return { salamats: s!.salamats, left_this_week: Math.max(0, SALAMATS_PER_WEEK - s!.used), as_of: new Date().toISOString() };
}

export function register(r: Router): void {
  // ---- posts ----
  r.post('/posts', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const b = (await ctx.json<Record<string, unknown>>()) || {};
    const body = str(b.body, 'body', { min: 1, max: 2000 });

    let reach: Level, codes: AreaCodes, spaceId: string | null, parent: PostRow | null = null;
    if (b.reply_to !== undefined && b.reply_to !== null) {
      // A reply lives where its parent lives: same place, reach and Space.
      const p = await visiblePost(ctx, String(b.reply_to), me.id);
      parent = p;
      reach = p.reach; spaceId = p.space_id;
      codes = { area_code: p.area_code, barangay_code: p.barangay_code, city_code: p.city_code, region_code: p.region_code, country_code: p.country_code };
    } else {
      reach = oneOf(b.reach, 'reach', LEVELS, 'city');
      spaceId = b.space_id ? String(b.space_id) : null;
      if (spaceId !== null && !isUuid(spaceId)) bad('space_id', 'is not a Space');
      let area = b.area_code ? str(b.area_code, 'area_code', { max: 40 }) : null;
      if (!area) area = (await ctx.db.one<{ home_area: string | null }>('SELECT home_area FROM users WHERE id = $1', [me.id]))?.home_area ?? null;
      codes = await resolveArea(ctx.db, area);
    }
    if (spaceId && !(await ctx.db.one('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, me.id]))) {
      fail(403, 'not_member', 'Join this Space to post in it');
    }
    // Private means end-to-end encrypted (decision 0001, point 4). Posts are stored as plaintext, so they
    // are refused in private Spaces until sealed posts exist; the private Space's encrypted chat is open.
    if (spaceId && (await ctx.db.one(`SELECT 1 FROM spaces WHERE id = $1 AND visibility = 'private'`, [spaceId]))) {
      fail(400, 'private_space_posts', 'Posts in a private Space are not end-to-end encrypted yet. Use its chat instead.');
    }

    let media: string[] = [];
    if (b.media_ids !== undefined && b.media_ids !== null) {
      if (!Array.isArray(b.media_ids) || b.media_ids.length > MAX_MEDIA || !b.media_ids.every((m) => isUuid(m as string))) bad('media_ids', `up to ${MAX_MEDIA} uploads`);
      media = [...new Set(b.media_ids as string[])];
      const owned = await ctx.db.one<{ n: number }>('SELECT count(*)::int AS n FROM media WHERE id = ANY($1::uuid[]) AND owner_id = $2', [media, me.id]);
      if (owned!.n !== media.length) bad('media_ids', 'not your upload');
    }

    const row = await ctx.db.tx(async (t) => {
      const ins = await t.one<{ id: string }>(
        `INSERT INTO posts (author_id, body, reply_to, space_id, media_ids, reach, area_code, barangay_code, city_code, region_code, country_code)
         VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, $10, $11) RETURNING id`,
        [me.id, body, parent?.id ?? null, spaceId, media, reach, codes.area_code, codes.barangay_code, codes.city_code, codes.region_code, codes.country_code]);
      if (parent && parent.author_id !== me.id) {
        await t.query(`INSERT INTO notifications (user_id, kind, actor_id, ref_kind, ref_id) VALUES ($1, 'reply', $2, 'post', $3)`, [parent.author_id, me.id, parent.id]);
      }
      return ins!;
    });
    const viewer = await viewerOf(ctx);
    return json({ post: toPost(await visiblePost(ctx, row.id, me.id), 'region', reference(viewer, viewer.home)) }, 201);
  });

  r.get('/posts/:id', async (ctx) => {
    const me = await viewerOf(ctx);
    const v = reference(me, me.home);
    const post = await visiblePost(ctx, ctx.params.id, me.id);
    const replies = await ctx.db.query<PostRow>(`${POST_SELECT} WHERE p.reply_to = $2 AND ${VISIBLE} ORDER BY p.created_at ASC LIMIT 200`, [me.id, post.id]);
    return json({ post: toPost(post, 'region', v), replies: replies.map((x) => toPost(x, 'region', v)), as_of: new Date().toISOString() });
  });

  r.delete('/posts/:id', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such post');
    const p = await ctx.db.one<{ author_id: string }>('SELECT author_id FROM posts WHERE id = $1 AND deleted_at IS NULL', [ctx.params.id]);
    if (!p) return fail(404, 'not_found', 'No such post');
    if (p.author_id !== me.id && me.role !== 'staff') return fail(403, 'not_yours', 'Only the author can delete this post');
    await ctx.db.query('UPDATE posts SET deleted_at = now() WHERE id = $1', [ctx.params.id]);
    return noContent();
  });

  // ---- salamat: ten a week, one per post, never your own ----
  r.post('/posts/:id/salamat', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const tags = tagsOf(((await ctx.json<Record<string, unknown>>()) || {}).tags);
    const post = await visiblePost(ctx, ctx.params.id, me.id);
    if (post.author_id === me.id) return fail(400, 'own_post', 'You cannot thank your own post');
    const week = manilaWeek();
    await ctx.db.tx(async (t) => {
      if (await t.one('SELECT 1 FROM salamats WHERE giver_id = $1 AND post_id = $2', [me.id, post.id])) fail(409, 'already_thanked', 'You already said salamat for this post');
      const used = await t.one<{ n: number }>('SELECT count(*)::int AS n FROM salamats WHERE giver_id = $1 AND week = $2', [me.id, week]);
      if (used!.n >= SALAMATS_PER_WEEK) fail(429, 'no_salamats_left', `You have given all ${SALAMATS_PER_WEEK} salamats this week. They come back on Monday.`);
      await t.query('INSERT INTO salamats (giver_id, receiver_id, post_id, tags, week) VALUES ($1, $2, $3, $4, $5)', [me.id, post.author_id, post.id, tags, week]);
      await t.query(`INSERT INTO notifications (user_id, kind, actor_id, ref_kind, ref_id) VALUES ($1, 'salamat', $2, 'post', $3)`, [post.author_id, me.id, post.id]);
    });
    return json(await salamatState(ctx, post.id, me.id));
  });

  r.delete('/posts/:id/salamat', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const post = await visiblePost(ctx, ctx.params.id, me.id);
    const gone = await ctx.db.one('DELETE FROM salamats WHERE giver_id = $1 AND post_id = $2 RETURNING 1', [me.id, post.id]);
    if (gone) {
      await ctx.db.query(`DELETE FROM notifications WHERE user_id = $1 AND kind = 'salamat' AND actor_id = $2 AND ref_id = $3 AND read_at IS NULL`, [post.author_id, me.id, post.id]);
    }
    return json(await salamatState(ctx, post.id, me.id));
  });

  // ---- saves ----
  r.post('/posts/:id/save', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const post = await visiblePost(ctx, ctx.params.id, me.id);
    await ctx.db.query('INSERT INTO saves (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me.id, post.id]);
    return noContent();
  });

  r.delete('/posts/:id/save', async (ctx) => {
    const me = requireUser(ctx);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such post');
    await ctx.db.query('DELETE FROM saves WHERE user_id = $1 AND post_id = $2', [me.id, ctx.params.id]);
    return noContent();
  });

  r.get('/me/saved', async (ctx) => {
    requireUser(ctx);
    const me = await viewerOf(ctx);
    const { limit: n, before } = page(ctx.query);
    const rows = await ctx.db.query<PostRow & { saved_at: string }>(
      `${POST_SELECT} JOIN saves s ON s.post_id = p.id AND s.user_id = $1::uuid
       WHERE ${VISIBLE} AND ($2::timestamptz IS NULL OR s.created_at < $2) ORDER BY s.created_at DESC LIMIT $3`, [me.id, before, n]);
    const v = reference(me, me.home);
    return json({ posts: rows.map((x) => ({ ...toPost(x, 'region', v), saved_at: x.saved_at })), as_of: new Date().toISOString() });
  });

  // ---- feeds ----
  r.get('/feeds/following', async (ctx) => {
    requireUser(ctx);
    const me = await viewerOf(ctx);
    const { limit: n, before } = page(ctx.query);
    const rows = await ctx.db.query<PostRow>(
      `${POST_SELECT} WHERE p.reply_to IS NULL AND ${VISIBLE}
         AND (p.author_id = $1::uuid
           OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1::uuid)
           OR p.space_id IN (SELECT space_id FROM space_members WHERE user_id = $1::uuid))
         AND ($2::timestamptz IS NULL OR p.created_at < $2)
       ORDER BY p.created_at DESC LIMIT $3`, [me.id, before, n + 1]);
    const v = reference(me, me.home);
    return json({ posts: rows.slice(0, n).map((x) => toPost(x, 'region', v)), end: rows.length <= n, as_of: new Date().toISOString() });
  });

  r.get('/feeds/places', async (ctx) => {
    const level = oneOf(ctx.query.get('level'), 'level', LEVELS, 'city');
    const me = await viewerOf(ctx);
    const { limit: n, before } = page(ctx.query);
    const codeParam = ctx.query.get('code');
    const viewed = codeParam ? await resolveArea(ctx.db, str(codeParam, 'code', { max: 40 })) : me.home;
    const levelCode = codeAt(viewed, level);
    if (!levelCode) return fail(400, 'invalid', `code: choose a place at the ${level} level, or set your home area`);
    const area = await ctx.db.one<{ code: string; name: string; level: string }>('SELECT code, name, level FROM areas WHERE code = $1', [levelCode]);

    const params: unknown[] = [me.id];
    const where = `p.reply_to IS NULL AND p.space_id IS NULL AND ${VISIBLE} AND ${placesWhere(level, levelCode, params)}`;
    params.push(before);
    const rows = await ctx.db.query<PostRow>(
      `${POST_SELECT} WHERE ${where} AND ($${params.length}::timestamptz IS NULL OR p.created_at < $${params.length})
       ORDER BY p.created_at DESC LIMIT ${CANDIDATES}`, params);
    const viewer = reference(me, viewed);
    const group = mixGroup(level);
    const ordered = fairMix(rank(level, rows.map(asCandidate), viewer, now()), (x) => x.author_id, group ? (x) => x[group] : undefined);

    const recent = await ctx.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM posts p JOIN users au ON au.id = p.author_id WHERE ${where} AND p.created_at > now() - interval '24 hours'`,
      params.slice(0, -1));
    let quiet: { next_level: Level; next_code: string; next_name: string } | undefined;
    let next = quietNext(level, recent!.n);
    while (next && !codeAt(viewed, next)) next = nextLevel(next);
    if (next) {
      const nextCode = codeAt(viewed, next) as string;
      const nextArea = await ctx.db.one<{ name: string }>('SELECT name FROM areas WHERE code = $1', [nextCode]);
      if (nextArea) quiet = { next_level: next, next_code: nextCode, next_name: nextArea.name };
    }
    return json({
      posts: ordered.slice(0, n).map((x) => toPost(x, level, viewer)), level, area, rule: RULES[level], weights: WEIGHTS[level],
      as_of: new Date().toISOString(), ...(quiet ? { quiet } : {}),
    });
  });

  r.get('/feeds/trade', async (ctx) => {
    const me = await viewerOf(ctx);
    const trade = oneOf(ctx.query.get('trade'), 'trade', TRADES, (me.trade as (typeof TRADES)[number] | null) ?? undefined);
    const { before } = page(ctx.query);
    const n = page(ctx.query).limit;
    const params: unknown[] = [me.id, trade];
    // Your city when you have a home area; otherwise only posts their authors sent to the whole world.
    const where = me.home.city_code
      ? (params.push(LEVELS.slice(levelIndex('city')), me.home.city_code), `p.reach = ANY($3::text[]) AND p.city_code = $4`)
      : `p.reach = 'world'`;
    params.push(before);
    const rows = await ctx.db.query<PostRow>(
      `${POST_SELECT} WHERE p.reply_to IS NULL AND p.space_id IS NULL AND ${VISIBLE} AND au.trade = $2 AND ${where}
         AND ($${params.length}::timestamptz IS NULL OR p.created_at < $${params.length})
       ORDER BY p.created_at DESC LIMIT ${CANDIDATES}`, params);
    const viewer = reference(me, me.home);
    const ordered = fairMix(rank('city', rows.map(asCandidate), viewer, now()), (x) => x.author_id);
    return json({ posts: ordered.slice(0, n).map((x) => toPost(x, 'city', viewer)), trade, rule: TRADE_RULE, weights: WEIGHTS.city, as_of: new Date().toISOString() });
  });

  r.get('/feeds/picks', async (ctx) => {
    const me = await viewerOf(ctx);
    const { limit: n } = page(ctx.query);
    const week = manilaWeek(new Date(Date.now() - 7 * 86400_000));
    const rows = await ctx.db.query<PostRow>(
      `WITH top AS (SELECT post_id, count(DISTINCT giver_id)::int AS givers FROM salamats WHERE week = $2 AND post_id IS NOT NULL GROUP BY post_id)
       ${POST_SELECT} JOIN top ON top.post_id = p.id
       WHERE p.reply_to IS NULL AND ${VISIBLE} ORDER BY top.givers DESC, p.created_at DESC LIMIT ${CANDIDATES}`, [me.id, week]);
    const v = reference(me, me.home);
    const ordered = fairMix(rows, (x) => x.author_id);
    return json({ posts: ordered.slice(0, n).map((x) => toPost(x, 'region', v)), week, as_of: new Date().toISOString() });
  });

  r.get('/posts/:id/why', async (ctx) => {
    const level = oneOf(ctx.query.get('level'), 'level', LEVELS, 'city');
    const me = await viewerOf(ctx);
    const codeParam = ctx.query.get('code');
    const viewed = codeParam ? await resolveArea(ctx.db, str(codeParam, 'code', { max: 40 })) : me.home;
    const post = await visiblePost(ctx, ctx.params.id, me.id);
    const signals = signalsFor(asCandidate(post), reference(me, viewed), now());
    const w = WEIGHTS[level];
    return json({ signals, weights: w, rule: RULES[level], score: w ? Math.round(score(w, signals) * 1000) / 1000 : null, as_of: new Date().toISOString() });
  });

  // ---- notifications ----
  r.get('/notifications', async (ctx) => {
    const me = requireUser(ctx);
    const { limit: n, before } = page(ctx.query);
    const items = await ctx.db.query(
      `SELECT n.id, n.kind, n.ref_kind, n.ref_id, n.created_at, n.read_at IS NOT NULL AS read,
         (SELECT row_to_json(x) FROM (SELECT ${PERSON_COLS} FROM users u WHERE u.id = n.actor_id) x) AS actor
       FROM notifications n WHERE n.user_id = $1 AND ($2::timestamptz IS NULL OR n.created_at < $2)
       ORDER BY n.created_at DESC LIMIT $3`, [me.id, before, n]);
    const unread = await ctx.db.one<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [me.id]);
    return json({ items, unread: unread!.n, as_of: new Date().toISOString() });
  });

  r.post('/notifications/read', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    await ctx.db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [me.id]);
    return noContent();
  });
}
