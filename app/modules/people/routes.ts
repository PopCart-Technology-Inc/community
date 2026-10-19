// People: public profiles, follows and the follow lists. Counts are live, never cached guesses.
import { fail, json, noContent, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { requireUser } from '../../http/session.ts';
import { PERSON_COLS, page } from '../shared.ts';

export function register(r: Router): void {
  r.get('/people/:handle', async (ctx) => {
    const p = await ctx.db.one<Record<string, unknown> & { id: string }>(
      `SELECT ${PERSON_COLS}, u.bio, u.cover_media_id, u.created_at, a.name AS home_area_name, a.code AS home_area,
         (SELECT count(*)::int FROM follows f WHERE f.followee_id = u.id) AS followers,
         (SELECT count(*)::int FROM follows f WHERE f.follower_id = u.id) AS following,
         (SELECT count(*)::int FROM salamats s WHERE s.receiver_id = u.id) AS salamats
       FROM users u LEFT JOIN areas a ON a.code = u.home_area WHERE u.handle = $1 AND u.status = 'active'`, [ctx.params.handle]);
    if (!p) return fail(404, 'not_found', 'No one has that username');
    const credentials = await ctx.db.query(
      `SELECT id, issuer, type, summary, as_of, verified FROM credentials WHERE user_id = $1 AND shown AND verified ORDER BY as_of DESC`, [p.id]);
    const is_following = ctx.user ? !!(await ctx.db.one('SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2', [ctx.user.id, p.id])) : false;
    return json({ person: { ...p, credentials, is_following, as_of: new Date().toISOString() } });
  });

  r.post('/people/:handle/follow', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const t = await ctx.db.one<{ id: string }>(`SELECT id FROM users WHERE handle = $1 AND status = 'active'`, [ctx.params.handle]);
    if (!t) return fail(404, 'not_found', 'No one has that username');
    if (t.id === me.id) return fail(400, 'self', 'You cannot follow yourself');
    const added = await ctx.db.one('INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [me.id, t.id]);
    if (added) await ctx.db.query(`INSERT INTO notifications (user_id, kind, actor_id) VALUES ($1, 'follow', $2)`, [t.id, me.id]);
    return noContent();
  });

  r.delete('/people/:handle/follow', async (ctx) => {
    const me = requireUser(ctx);
    await ctx.db.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = (SELECT id FROM users WHERE handle = $2)', [me.id, ctx.params.handle]);
    return noContent();
  });

  r.get('/people/:handle/followers', async (ctx) => {
    const { limit: n } = page(ctx.query);
    return json({ people: await ctx.db.query(
      `SELECT ${PERSON_COLS} FROM follows f JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id = (SELECT id FROM users WHERE handle = $1) AND u.status = 'active' ORDER BY f.created_at DESC LIMIT $2`, [ctx.params.handle, n]) });
  });

  r.get('/people/:handle/following', async (ctx) => {
    const { limit: n } = page(ctx.query);
    return json({ people: await ctx.db.query(
      `SELECT ${PERSON_COLS} FROM follows f JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id = (SELECT id FROM users WHERE handle = $1) AND u.status = 'active' ORDER BY f.created_at DESC LIMIT $2`, [ctx.params.handle, n]) });
  });

  // Suggestions: people in your trade and city. Never from contact uploads (decision 0001).
  r.get('/people', async (ctx) => {
    const me = requireUser(ctx);
    const trade = ctx.query.get('trade');
    return json({ people: await ctx.db.query(
      `SELECT ${PERSON_COLS} FROM users u, users me WHERE me.id = $1 AND u.id <> me.id AND u.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = me.id AND f.followee_id = u.id)
         AND u.trade = coalesce($2, me.trade)
       ORDER BY (u.home_area IS NOT DISTINCT FROM me.home_area) DESC, u.created_at DESC LIMIT 20`, [me.id, trade]) });
  });
}
