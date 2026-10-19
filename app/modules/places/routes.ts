// Places (decision 0005): the area hierarchy from barangay to World. Names and codes only: the server
// never stores or returns coordinates.
import { fail, json, type Router } from '../../http/router.ts';
import { str } from '../shared.ts';

const CODE = /^[A-Za-z0-9-]{1,40}$/;
const LEVEL_ORDER = `CASE a.level WHEN 'country' THEN 0 WHEN 'region' THEN 1 WHEN 'province' THEN 2 WHEN 'city' THEN 3 WHEN 'barangay' THEN 4 ELSE 5 END`;

/** Escape LIKE wildcards so a search for "100%" means the text, not a pattern. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);

export function register(r: Router): void {
  // Who published each country's area list: the credit shown with place names. Before `/places/:code`.
  r.get('/places/sources', async (ctx) => {
    const sources = await ctx.db.query(
      'SELECT country_code, publisher, dataset, edition, url, areas, imported_at FROM area_sources ORDER BY country_code');
    return json({ sources, as_of: new Date().toISOString() });
  });

  r.get('/places/search', async (ctx) => {
    const q = str(ctx.query.get('q'), 'q', { min: 2, max: 60 }).toLowerCase();
    const pat = likeEscape(q);
    const areas = await ctx.db.query(
      `SELECT a.code, a.name, a.level, p.name AS parent_name
       FROM areas a LEFT JOIN areas p ON p.code = a.parent_code
       WHERE a.level <> 'world' AND lower(a.name) LIKE '%' || $1 || '%' ESCAPE '\\'
       ORDER BY (lower(a.name) LIKE $1 || '%' ESCAPE '\\') DESC, ${LEVEL_ORDER}, a.name
       LIMIT 20`, [pat]);
    return json({ areas, as_of: new Date().toISOString() });
  });

  r.get('/places/:code', async (ctx) => {
    const code = ctx.params.code || '';
    if (!CODE.test(code)) return fail(404, 'not_found', 'No such place');
    // The area itself, then each parent up to World (depth-limited so bad data can never loop).
    const chain = await ctx.db.query<{ code: string; name: string; level: string }>(
      `WITH RECURSIVE up AS (
         SELECT code, name, level, parent_code, 0 AS depth FROM areas WHERE code = $1
         UNION ALL
         SELECT a.code, a.name, a.level, a.parent_code, up.depth + 1 FROM areas a JOIN up ON a.code = up.parent_code WHERE up.depth < 10
       ) SELECT code, name, level FROM up ORDER BY depth`, [code]);
    const area = chain[0];
    if (!area) return fail(404, 'not_found', 'No such place');
    return json({ area, chain, as_of: new Date().toISOString() });
  });

  r.get('/places/:code/children', async (ctx) => {
    const code = ctx.params.code || '';
    if (!CODE.test(code) || !(await ctx.db.one('SELECT 1 FROM areas WHERE code = $1', [code]))) return fail(404, 'not_found', 'No such place');
    const areas = await ctx.db.query(
      'SELECT code, name, level FROM areas WHERE parent_code = $1 ORDER BY name', [code]);
    return json({ areas, as_of: new Date().toISOString() });
  });
}
