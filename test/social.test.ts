// Places, posts, salamat, feeds and notifications. All names and places are test fixtures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { manilaWeek, resolveArea, SALAMATS_PER_WEEK, type Level } from '../app/modules/shared.ts';
import { buildAreas, importAreas, parseCsv, parsePsgc } from '../app/modules/places/import.ts';
import {
  distanceHint, FAIR, fairMix, freshness, mixGroup, nearness, nextLevel, quietNext, rank, score, signalsFor, WEIGHTS,
  type Candidate, type Viewer,
} from '../app/modules/posts/weights.ts';
import { seedTestAreas, startApp, type TestApp } from './helpers.ts';

// ---------------------------------------------------------------- pure ranking (weights.ts)

const NOW = new Date('2026-10-19T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
let cid = 0;
const cand = (o: Partial<Candidate> = {}): Candidate => ({
  id: `c${++cid}`, author_id: `a${cid}`, author_trade: 'other', created_at: hoursAgo(1),
  barangay_code: null, city_code: null, country_code: null, salamats_distinct: 0, ...o,
});
const V: Viewer = { barangay_code: 'B1', city_code: 'C1', trade: 'rider' };

/** Every window of `size` consecutive items has at most `max` with the same key (null keys ignored). */
function windowsOk<T>(xs: T[], key: (x: T) => string | null, size: number, max: number): boolean {
  for (let i = 0; i < xs.length; i++) {
    const counts = new Map<string, number>();
    for (const x of xs.slice(i, i + size)) {
      const k = key(x);
      if (k === null) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
      if ((counts.get(k) as number) > max) return false;
    }
  }
  return true;
}

test('weights: published per level; barangay has none; region weighs salamat more than city', () => {
  assert.equal(WEIGHTS.barangay, null);
  for (const l of ['city', 'region', 'country', 'world'] as const) assert.ok(WEIGHTS[l], l);
  assert.ok(WEIGHTS.city!.near > WEIGHTS.region!.near, 'city: near high');
  assert.ok(WEIGHTS.region!.salamat > WEIGHTS.city!.salamat, 'region: salamat up');
  assert.deepEqual({ ...FAIR }, { authorMax: 2, authorWindow: 20, mixMax: 1, mixWindow: 4 });
});

test('signals: freshness, nearness, trade, and the score formula', () => {
  assert.equal(freshness(0), 1);
  assert.equal(freshness(12), 0.5);
  assert.equal(freshness(-5), 1, 'future times never score above fresh');
  assert.equal(nearness({ barangay_code: 'B1', city_code: 'C1' }, V), 1);
  assert.equal(nearness({ barangay_code: 'B2', city_code: 'C1' }, V), 0.5);
  assert.equal(nearness({ barangay_code: null, city_code: 'C2' }, V), 0);
  assert.equal(nearness({ barangay_code: null, city_code: null }, { barangay_code: null, city_code: null, trade: null }), 0, 'unknown is never near');
  const s = signalsFor(cand({ barangay_code: 'B2', city_code: 'C1', author_trade: 'rider', salamats_distinct: 3, created_at: hoursAgo(12) }), V, NOW);
  assert.deepEqual(s, { near: 0.5, trade: 1, salamats_distinct: 3, fresh_hours: 12 });
  const w = WEIGHTS.city!;
  assert.equal(score(w, s), w.near * 0.5 + w.trade * 1 + w.salamat * Math.log2(4) + w.fresh * 0.5);
});

test('rank: barangay is time only; city prefers near; region lets thanks from many people win', () => {
  const old = cand({ created_at: hoursAgo(10), salamats_distinct: 50, barangay_code: 'B1', city_code: 'C1' });
  const fresh = cand({ created_at: hoursAgo(1) });
  assert.deepEqual(rank('barangay', [old, fresh], V, NOW).map((p) => p.id), [fresh.id, old.id]);

  const near = cand({ created_at: hoursAgo(2), barangay_code: 'B1', city_code: 'C1' });
  const far = cand({ created_at: hoursAgo(2), city_code: 'C9' });
  assert.equal(rank('city', [far, near], V, NOW)[0]!.id, near.id);

  const sameCity = cand({ created_at: hoursAgo(2), barangay_code: 'B2', city_code: 'C1' });
  const thanked = cand({ created_at: hoursAgo(2), city_code: 'C9', salamats_distinct: 1 });
  assert.equal(rank('city', [thanked, sameCity], V, NOW)[0]!.id, sameCity.id, 'city: nearness wins');
  assert.equal(rank('region', [sameCity, thanked], V, NOW)[0]!.id, thanked.id, 'region: thanks from different people win');

  const tieOld = cand({ created_at: hoursAgo(3) }), tieNew = cand({ created_at: hoursAgo(3) });
  const out = rank('world', [tieOld, tieNew], { barangay_code: null, city_code: null, trade: null }, NOW);
  assert.equal(out.length, 2, 'ties keep every post');
});

test('fair traffic: at most 2 posts per author in every 20, held back when nobody else is left', () => {
  const loud = Array.from({ length: 30 }, () => cand({ author_id: 'loud' }));
  const others = Array.from({ length: 40 }, (_, i) => cand({ author_id: `other${i}` }));
  const out = fairMix([...loud, ...others], (p) => p.author_id);
  assert.ok(windowsOk(out, (p) => p.author_id, 20, 2));
  assert.equal(out.slice(0, 2).every((p) => p.author_id === 'loud'), true, 'order kept as far as the cap allows');
  // loud at positions 1-2, 21-22, 41-42; after the 40 others run out (position 46) nothing can follow
  assert.equal(out.filter((p) => p.author_id === 'loud').length, 6);
  assert.equal(out.length, 46, 'the rest of the loud posts are held back, everyone else is shown');
  assert.equal(out.filter((p) => p.author_id !== 'loud').length, 40);

  const alone = fairMix(Array.from({ length: 9 }, () => cand({ author_id: 'solo' })), (p) => p.author_id);
  assert.equal(alone.length, 2);
  assert.deepEqual(fairMix([], (p: Candidate) => p.author_id), []);
});

test('mix rule: at most 1 in 4 from any one city (Country) or country (World)', () => {
  const cities = ['C1', 'C2', 'C3', 'C4', 'C5'];
  // the capital's posts all score highest, so without the rule they would fill the top
  const posts = [
    ...Array.from({ length: 6 }, (_, i) => cand({ author_id: `cap${i}`, city_code: 'C1' })),
    ...cities.slice(1).flatMap((c) => Array.from({ length: 6 }, (_, i) => cand({ author_id: `${c}-${i}`, city_code: c }))),
  ];
  const out = fairMix(posts, (p) => p.author_id, (p) => p.city_code);
  assert.ok(windowsOk(out, (p) => p.city_code, 4, 1), out.map((p) => p.city_code).join(' '));
  assert.equal(out[0]!.city_code, 'C1');
  assert.equal(out.length, posts.length, 'the mix rule never hides posts');
  assert.ok(windowsOk(out, (p) => p.author_id, 20, 2));
  // without the rule the capital would take the first 6 places
  assert.equal(out.slice(0, 6).filter((p) => p.city_code === 'C1').length, 2);

  // when one city has far more posts than the others, the rule holds until the others run out,
  // then the rest follow as spread out as they can be
  const heavy = [
    ...Array.from({ length: 10 }, (_, i) => cand({ author_id: `h${i}`, city_code: 'C1' })),
    ...cities.slice(1).flatMap((c) => Array.from({ length: 2 }, (_, i) => cand({ author_id: `${c}+${i}`, city_code: c }))),
  ];
  const h = fairMix(heavy, (p) => p.author_id, (p) => p.city_code);
  assert.equal(h.length, heavy.length);
  assert.ok(windowsOk(h.slice(0, 9), (p) => p.city_code, 4, 1), h.map((p) => p.city_code).join(' '));

  // property: whenever the posts can be spread 1 in 4, the output is (random mixes, fixed seed)
  let seed = 7, checked = 0;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let run = 0; run < 1000; run++) {
    const groups = 4 + rnd(5);
    const list = Array.from({ length: 8 + rnd(60) }, (_, i) => cand({ author_id: `r${run}-${i}`, city_code: `G${rnd(groups)}` }));
    const counts = [...list.reduce((m, p) => m.set(p.city_code, (m.get(p.city_code) || 0) + 1), new Map()).values()];
    const max = Math.max(...counts), atMax = counts.filter((c) => c === max).length;
    if ((max - 1) * FAIR.mixWindow + atMax > list.length) continue; // cannot be spread at all
    const o = fairMix(list, (p) => p.author_id, (p) => p.city_code);
    assert.equal(o.length, list.length);
    assert.ok(windowsOk(o, (p) => p.city_code, 4, 1), `run ${run}: ${o.map((p) => p.city_code).join(' ')}`);
    checked++;
  }
  assert.ok(checked > 100, `${checked} random mixes checked`);

  // only one city has posts: they follow in score order instead of disappearing
  const one = fairMix(Array.from({ length: 6 }, (_, i) => cand({ author_id: `x${i}`, city_code: 'C1' })), (p) => p.author_id, (p) => p.city_code);
  assert.equal(one.length, 6);

  // posts with no city are never limited by the mix rule
  const noCity = fairMix(Array.from({ length: 5 }, (_, i) => cand({ author_id: `n${i}` })), (p) => p.author_id, (p) => p.city_code);
  assert.equal(noCity.length, 5);

  // World mixes by country
  const world = [
    ...Array.from({ length: 8 }, (_, i) => cand({ author_id: `ph${i}`, country_code: 'PH' })),
    ...['XA', 'XB', 'XC'].flatMap((c) => Array.from({ length: 2 }, (_, i) => cand({ author_id: `${c}${i}`, country_code: c }))),
  ];
  const w = fairMix(world, (p) => p.author_id, (p) => p.country_code);
  assert.ok(windowsOk(w.slice(0, 8), (p) => p.country_code, 4, 1));
  assert.equal(mixGroup('country'), 'city_code');
  assert.equal(mixGroup('world'), 'country_code');
  assert.equal(mixGroup('city'), null);
  assert.equal(mixGroup('barangay'), null);
});

test('quiet: fewer than 5 posts in 24 hours suggests the next level out', () => {
  assert.equal(quietNext('barangay', 4), 'city');
  assert.equal(quietNext('barangay', 5), null);
  assert.equal(quietNext('city', 0), 'region');
  assert.equal(quietNext('country', 1), 'world');
  assert.equal(quietNext('world', 0), null);
  assert.equal(nextLevel('region'), 'country');
});

test('distance hint: names at the level precision, never coordinates', () => {
  const p = { barangay_code: 'B2', barangay_name: 'Test Barangay Two', city_code: 'C1', city_name: 'Test City', country_name: 'Testland' };
  assert.equal(distanceHint('barangay', { ...p, barangay_code: 'B1' }, V), 'same barangay');
  assert.equal(distanceHint('city', p, V), 'Test Barangay Two');
  assert.equal(distanceHint('region', p, V), 'Test City');
  assert.equal(distanceHint('country', p, V), 'Test City');
  assert.equal(distanceHint('world', p, V), 'Test City, Testland');
  assert.equal(distanceHint('region', { barangay_code: null, barangay_name: null, city_code: null, city_name: null, country_name: null }, V), null);
});

// ---------------------------------------------------------------- PSGC importer (fixture CSV, made-up names)

const CSV = [
  '﻿"10-digit PSGC",Name,Correspondence Code,Geographic Level',
  '0100000000,Test Region North,010000000,Reg',
  '0102800000,Test Province,012800000,Prov',
  '0102801000,Test Town,012801000,Mun',
  '102801001,Test Barangay A,012801001,Bgy',
  '0102801002,"Test Barangay ""B""",012801002,Bgy',
  '1300000000,Test Capital Region,130000000,Reg',
  '1380600000,Test Capital City,133900000,City',
  '1380601000,Test District,133901000,SubMun',
  '1380601001,Test Barangay C,133901001,Bgy',
  '1381300000,Test Second City,137400000,City',
  '1381300001,Test Barangay D,137400001,Bgy',
  '1380100000,Test District Two,,Dist',
  'not-a-code,Broken Row,,Bgy',
].join('\r\n') + '\r\n';

test('importer: CSV quoting, header detection, 9-digit codes, unknown levels skipped', () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\nx,y,z'), [['a', 'b,c', 'd "e"'], ['x', 'y', 'z']]);
  const { rows, skipped } = parsePsgc(CSV);
  assert.equal(rows.length, 11);
  assert.equal(skipped, 2);
  assert.equal(rows[3]!.code, '0102801001', 'leading zero restored');
  assert.equal(rows[4]!.name, 'Test Barangay "B"');
  // no header: positional columns
  assert.equal(parsePsgc('0100000000,Test Region North,Reg\n').rows[0]!.psgc_level, 'Reg');
  assert.throws(() => parsePsgc('foo,bar\n1,2\n'), /header/);
});

test('importer: parents and feed-level codes from the PSGC prefixes', () => {
  const by = new Map(buildAreas(parsePsgc(CSV).rows).map((a) => [a.code, a]));
  const get = (c: string) => by.get(c)!;
  assert.deepEqual([get('0100000000').level, get('0100000000').parent_code], ['region', 'PH']);
  assert.deepEqual([get('0102800000').level, get('0102800000').parent_code, get('0102800000').region_code], ['province', '0100000000', '0100000000']);
  assert.deepEqual([get('0102801000').level, get('0102801000').parent_code, get('0102801000').city_code], ['city', '0102800000', '0102801000']);
  assert.deepEqual([get('0102801001').level, get('0102801001').parent_code, get('0102801001').city_code], ['barangay', '0102801000', '0102801000']);
  // capital region: no provinces, so cities hang from the region
  assert.equal(get('1381300000').parent_code, '1300000000');
  assert.equal(get('1381300001').city_code, '1381300000');
  // a sub-municipality sits under its city; its barangays roll up to that city
  assert.deepEqual([get('1380601000').level, get('1380601000').parent_code, get('1380601000').city_code], ['city', '1380600000', '1380600000']);
  assert.deepEqual([get('1380601001').parent_code, get('1380601001').city_code, get('1380601001').region_code], ['1380601000', '1380600000', '1300000000']);
  for (const a of by.values()) assert.equal(a.country_code, 'PH');
  // parents come before children
  const order = buildAreas(parsePsgc(CSV).rows).map((a) => a.code);
  for (const a of by.values()) if (a.parent_code !== 'PH') assert.ok(order.indexOf(a.parent_code) < order.indexOf(a.code), a.code);
});

// ---------------------------------------------------------------- HTTP API

let app: TestApp;
before(async () => { app = await startApp(); await seedTestAreas(app.db); });
after(async () => { await app.close(); });

/** A post written straight to the database (to set its age), at an area, with a reach. */
async function rawPost(authorId: string, area: string, reach: Level, hours: number, body = 'Test post'): Promise<string> {
  const c = await resolveArea(app.db, area);
  const r = await app.db.one<{ id: string }>(
    `INSERT INTO posts (author_id, body, reach, area_code, barangay_code, city_code, region_code, country_code, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - make_interval(secs => $9)) RETURNING id`,
    [authorId, body, reach, c.area_code, c.barangay_code, c.city_code, c.region_code, c.country_code, hours * 3600]);
  return r!.id;
}

/** A fresh test region with one city and two barangays, so feed tests do not see each other's posts. */
let areaSeq = 0;
async function testCity(): Promise<{ reg: string; city: string; b1: string; b2: string }> {
  const n = ++areaSeq;
  const reg = `TR${n}`, city = `TC${n}`, b1 = `TB${n}A`, b2 = `TB${n}B`;
  await app.db.query(`INSERT INTO areas (code, name, level, parent_code, city_code, region_code, country_code) VALUES
    ($1, 'Test Region ' || $5, 'region', 'PH', NULL, $1, 'PH'),
    ($2, 'Test Town ' || $5, 'city', $1, $2, $1, 'PH'),
    ($3, 'Test Barangay ' || $5 || 'A', 'barangay', $2, $2, $1, 'PH'),
    ($4, 'Test Barangay ' || $5 || 'B', 'barangay', $2, $2, $1, 'PH')`, [reg, city, b1, b2, String(n)]);
  return { reg, city, b1, b2 };
}

test('places: import is safe to re-run; search, area chain and children', async () => {
  const areas = buildAreas(parsePsgc(CSV).rows);
  assert.equal(await importAreas(app.db, areas), 11);
  assert.equal(await importAreas(app.db, areas), 11, 're-run upserts');
  const ph = await app.db.one<{ name: string; parent_code: string }>(`SELECT name, parent_code FROM areas WHERE code = 'PH'`);
  assert.deepEqual(ph, { name: 'Philippines', parent_code: 'WORLD' });

  const s = await app.call('GET', '/places/search?q=test barangay');
  assert.equal(s.status, 200);
  assert.ok(s.body.as_of);
  assert.ok(s.body.areas.length >= 4 && s.body.areas.length <= 20);
  const c = s.body.areas.find((a: { code: string }) => a.code === '1380601001');
  assert.deepEqual(c, { code: '1380601001', name: 'Test Barangay C', level: 'barangay', parent_name: 'Test District' });
  assert.ok(s.body.areas.every((a: object) => Object.keys(a).sort().join() === 'code,level,name,parent_name'), 'names only, never coordinates');
  assert.equal((await app.call('GET', '/places/search?q=%25')).status, 400, 'too short');
  assert.equal((await app.call('GET', '/places/search?q=%25%25')).body.areas.length, 0, 'wildcards are text');

  const one = await app.call('GET', '/places/1380601001');
  assert.deepEqual(one.body.area, { code: '1380601001', name: 'Test Barangay C', level: 'barangay' });
  assert.deepEqual(one.body.chain.map((a: { code: string }) => a.code), ['1380601001', '1380601000', '1380600000', '1300000000', 'PH', 'WORLD']);
  assert.equal((await app.call('GET', '/places/NOPE')).status, 404);

  const kids = await app.call('GET', '/places/0102801000/children');
  assert.deepEqual(kids.body.areas.map((a: { name: string }) => a.name), ['Test Barangay "B"', 'Test Barangay A']);
  assert.equal((await app.call('GET', '/places/NOPE/children')).status, 404);
});

test('posts: write, read, reply inherits place and reach, replies oldest first, reply notifies', async () => {
  const a = await app.person({ home_area: 'T-BRGY1', trade: 'rider' });
  const b = await app.person({ home_area: 'T-BRGY2' });
  assert.equal((await app.call('POST', '/posts', { body: 'hi' })).status, 401);
  assert.equal((await a.call('POST', '/posts', { body: '' })).status, 400);
  assert.equal((await a.call('POST', '/posts', { body: 'x', reach: 'galaxy' })).status, 400);
  assert.equal((await a.call('POST', '/posts', { body: 'x', area_code: 'NOWHERE' })).status, 400);

  const made = await a.call('POST', '/posts', { body: 'Naghahanap ng rider bukas' });
  assert.equal(made.status, 201);
  const post = made.body.post;
  assert.equal(post.reach, 'city', 'default reach');
  assert.deepEqual(post.place, { code: 'T-BRGY1', name: 'Test Barangay One' }, 'default place: home area');
  assert.equal(post.author.handle, a.handle);
  assert.deepEqual(Object.keys(post.author).sort(), ['avatar_media_id', 'first_name', 'handle', 'id', 'id_checked', 'trade']);
  for (const k of ['id', 'body', 'created_at', 'reply_to', 'space_id', 'media_ids', 'reach', 'place', 'distance_hint', 'salamats', 'replies', 'saved', 'salamat_given', 'lang']) assert.ok(k in post, k);

  const wide = await b.call('POST', '/posts', { body: 'Para sa lahat', reach: 'world', area_code: 'T-CITY' });
  assert.equal(wide.body.post.reach, 'world');
  const r1 = await b.call('POST', '/posts', { body: 'Ako!', reply_to: post.id, reach: 'world', area_code: 'XX' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.post.reach, 'city', 'reply inherits reach');
  assert.equal(r1.body.post.place.code, 'T-BRGY1', 'reply inherits place');
  await a.call('POST', '/posts', { body: 'Salamat, message kita', reply_to: post.id });
  const got = await b.call('GET', `/posts/${post.id}`);
  assert.equal(got.body.post.replies, 2);
  assert.deepEqual(got.body.replies.map((x: { body: string }) => x.body), ['Ako!', 'Salamat, message kita']);
  assert.equal((await app.call('GET', '/posts/not-a-uuid')).status, 404);

  const n = await a.call('GET', '/notifications');
  assert.equal(n.body.unread, 1, 'own reply does not notify');
  assert.equal(n.body.items[0].kind, 'reply');
  assert.equal(n.body.items[0].actor.handle, b.handle);
  assert.equal(n.body.items[0].ref_id, post.id);
  assert.ok(n.body.as_of);
  assert.equal((await a.call('POST', '/notifications/read')).status, 204);
  assert.equal((await a.call('GET', '/notifications')).body.unread, 0);
});

test('posts: media must be your own upload; delete by author or staff only', async () => {
  const a = await app.person({ home_area: 'T-CITY' }), b = await app.person(), staff = await app.person({ role: 'staff' });
  assert.equal((await a.call('POST', '/posts', { body: 'x', media_ids: ['00000000-0000-0000-0000-000000000000'] })).status, 400);
  assert.equal((await a.call('POST', '/posts', { body: 'x', media_ids: 'nope' })).status, 400);
  const p = (await a.call('POST', '/posts', { body: 'to delete' })).body.post;
  assert.equal((await b.call('DELETE', `/posts/${p.id}`)).status, 403);
  assert.equal((await a.call('DELETE', `/posts/${p.id}`)).status, 204);
  assert.equal((await a.call('GET', `/posts/${p.id}`)).status, 404);
  assert.equal((await a.call('DELETE', `/posts/${p.id}`)).status, 404);
  const q = (await a.call('POST', '/posts', { body: 'staff removes' })).body.post;
  assert.equal((await staff.call('DELETE', `/posts/${q.id}`)).status, 204);
});

test('posts: posting in a Space needs membership; private Space posts stay inside', async () => {
  const owner = await app.person(), outsider = await app.person();
  const sp = await app.db.one<{ id: string }>(
    `INSERT INTO spaces (slug, name, kind, visibility, created_by) VALUES ('test-crew', 'Test Crew', 'crew', 'private', $1) RETURNING id`, [owner.id]);
  await app.db.query(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')`, [sp!.id, owner.id]);
  assert.equal((await outsider.call('POST', '/posts', { body: 'let me in', space_id: sp!.id })).status, 403);
  assert.equal((await outsider.call('POST', '/posts', { body: 'bad', space_id: 'nope' })).status, 400);
  const p = await owner.call('POST', '/posts', { body: 'crew only', space_id: sp!.id });
  assert.equal(p.status, 201);
  assert.equal(p.body.post.space_id, sp!.id);
  assert.equal((await outsider.call('GET', `/posts/${p.body.post.id}`)).status, 404);
  assert.equal((await outsider.call('POST', '/posts', { body: 'reply', reply_to: p.body.post.id })).status, 404);
  assert.equal((await owner.call('GET', `/posts/${p.body.post.id}`)).status, 200);
  const feed = await owner.call('GET', '/feeds/following');
  assert.ok(feed.body.posts.some((x: { id: string }) => x.id === p.body.post.id), 'members see Space posts in Following');
});

test('salamat: one per post, never your own, ten a week, notifies, can be taken back', async () => {
  const author = await app.person({ home_area: 'T-CITY' }), giver = await app.person();
  const post = (await author.call('POST', '/posts', { body: 'Libre ang turo sa Sabado' })).body.post;
  assert.equal((await author.call('POST', `/posts/${post.id}/salamat`)).body.error.code, 'own_post');
  assert.equal((await giver.call('POST', `/posts/${post.id}/salamat`, { tags: ['a', 'b', 'c', 'd'] })).status, 400);
  const g = await giver.call('POST', `/posts/${post.id}/salamat`, { tags: ['helpful'] });
  assert.equal(g.status, 200);
  assert.deepEqual([g.body.salamats, g.body.left_this_week], [1, SALAMATS_PER_WEEK - 1]);
  assert.equal((await giver.call('POST', `/posts/${post.id}/salamat`)).status, 409);
  const seen = await giver.call('GET', `/posts/${post.id}`);
  assert.equal(seen.body.post.salamat_given, true);
  assert.equal(seen.body.post.salamats, 1);
  const n = await author.call('GET', '/notifications');
  assert.equal(n.body.items[0].kind, 'salamat');

  const back = await giver.call('DELETE', `/posts/${post.id}/salamat`);
  assert.deepEqual([back.body.salamats, back.body.left_this_week], [0, SALAMATS_PER_WEEK]);
  assert.equal((await author.call('GET', '/notifications')).body.unread, 0, 'an unread salamat notification goes with it');

  // use up the week, then the next one is refused
  const week = manilaWeek();
  for (let i = 0; i < SALAMATS_PER_WEEK; i++) {
    const other = await rawPost(author.id, 'T-CITY', 'city', 1);
    await app.db.query('INSERT INTO salamats (giver_id, receiver_id, post_id, week) VALUES ($1, $2, $3, $4)', [giver.id, author.id, other, week]);
  }
  const over = await giver.call('POST', `/posts/${post.id}/salamat`);
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, 'no_salamats_left');
  // last week's salamats do not count against this week
  const g2 = await app.person();
  const lastWeek = manilaWeek(new Date(Date.now() - 7 * 86400_000));
  for (let i = 0; i < SALAMATS_PER_WEEK; i++) {
    const other = await rawPost(author.id, 'T-CITY', 'city', 1);
    await app.db.query('INSERT INTO salamats (giver_id, receiver_id, post_id, week) VALUES ($1, $2, $3, $4)', [g2.id, author.id, other, lastWeek]);
  }
  assert.equal((await g2.call('POST', `/posts/${post.id}/salamat`)).body.left_this_week, SALAMATS_PER_WEEK - 1);
});

test('saves: save, list newest saved first, unsave', async () => {
  const a = await app.person({ home_area: 'T-CITY' });
  const p1 = (await a.call('POST', '/posts', { body: 'first' })).body.post;
  const p2 = (await a.call('POST', '/posts', { body: 'second' })).body.post;
  assert.equal((await a.call('POST', `/posts/${p1.id}/save`)).status, 204);
  assert.equal((await a.call('POST', `/posts/${p1.id}/save`)).status, 204, 'saving twice is fine');
  await a.call('POST', `/posts/${p2.id}/save`);
  const s = await a.call('GET', '/me/saved');
  assert.deepEqual(s.body.posts.map((x: { id: string }) => x.id), [p2.id, p1.id]);
  assert.equal(s.body.posts[0].saved, true);
  assert.ok(s.body.as_of);
  await a.call('DELETE', `/posts/${p2.id}/save`);
  assert.equal((await a.call('GET', '/me/saved')).body.posts.length, 1);
  assert.equal((await app.call('GET', '/me/saved')).status, 401);
});

test('following feed: people you follow and yourself, newest first, paged with end', async () => {
  const me = await app.person(), friend = await app.person(), stranger = await app.person();
  await me.call('POST', `/people/${friend.handle}/follow`);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(await rawPost(friend.id, 'T-CITY', 'barangay', 3 - i, `friend ${i}`));
  await rawPost(stranger.id, 'T-CITY', 'world', 0.5, 'stranger');
  const mine = await rawPost(me.id, 'T-CITY', 'city', 0.1, 'mine');
  const f = await me.call('GET', '/feeds/following?limit=2');
  assert.deepEqual(f.body.posts.map((x: { id: string }) => x.id), [mine, ids[2]]);
  assert.equal(f.body.end, false);
  assert.ok(f.body.as_of);
  const next = await me.call('GET', `/feeds/following?limit=2&before=${encodeURIComponent(f.body.posts[1].created_at)}`);
  assert.deepEqual(next.body.posts.map((x: { id: string }) => x.id), [ids[1], ids[0]]);
  const last = await me.call('GET', `/feeds/following?limit=2&before=${encodeURIComponent(next.body.posts[1].created_at)}`);
  assert.deepEqual([last.body.posts.length, last.body.end], [0, true]);
  assert.equal((await app.call('GET', '/feeds/following')).status, 401);
});

test('places feed: reach decides the levels; barangay newest first; rule, weights and hints', async () => {
  const t = await testCity();
  const viewer = await app.person({ home_area: t.b1, trade: 'rider' });
  const a = await app.person({ trade: 'rider' }), b = await app.person(), c = await app.person();
  const nearOld = await rawPost(a.id, t.b1, 'barangay', 5, 'near, old');
  const otherBrgy = await rawPost(b.id, t.b2, 'city', 2, 'other barangay');
  const regionWide = await rawPost(c.id, t.b2, 'region', 1, 'region wide');
  const worldWide = await rawPost(c.id, t.city, 'world', 0.5, 'world wide');

  const brgy = await viewer.call('GET', `/feeds/places?level=barangay`);
  assert.equal(brgy.status, 200);
  assert.deepEqual(brgy.body.posts.map((x: { id: string }) => x.id), [nearOld], 'own barangay only');
  assert.equal(brgy.body.weights, null);
  assert.match(brgy.body.rule, /Newest first/);
  assert.equal(brgy.body.posts[0].distance_hint, 'same barangay');
  assert.deepEqual(brgy.body.area, { code: t.b1, name: `Test Barangay ${areaSeq}A`, level: 'barangay' });

  const city = await viewer.call('GET', `/feeds/places?level=city`);
  const cityIds = city.body.posts.map((x: { id: string }) => x.id);
  assert.ok(!cityIds.includes(nearOld), 'a barangay-reach post stays in its barangay');
  assert.deepEqual(new Set(cityIds), new Set([otherBrgy, regionWide, worldWide]));
  assert.deepEqual(city.body.weights, WEIGHTS.city);
  assert.equal(city.body.level, 'city');
  assert.ok(city.body.as_of);
  const hint = city.body.posts.find((x: { id: string }) => x.id === otherBrgy).distance_hint;
  assert.equal(hint, `Test Barangay ${areaSeq}B`);
  assert.doesNotMatch(JSON.stringify(city.body), /lat|lng|longitude|latitude/i);

  const region = await viewer.call('GET', `/feeds/places?level=region`);
  assert.deepEqual(new Set(region.body.posts.map((x: { id: string }) => x.id)), new Set([regionWide, worldWide]));
  assert.equal(region.body.posts[0].distance_hint, `Test Town ${areaSeq}`);

  const world = await app.call('GET', `/feeds/places?level=world`);
  assert.ok(world.body.posts.some((x: { id: string }) => x.id === worldWide));
  assert.ok(world.body.posts.every((x: { reach: string }) => x.reach === 'world'));
  assert.deepEqual(world.body.area, { code: 'WORLD', name: 'World', level: 'world' });

  // signed out with a code; and a code that has no area at the asked level
  assert.equal((await app.call('GET', `/feeds/places?level=city&code=${t.b2}`)).body.posts.length, 3);
  assert.equal((await app.call('GET', `/feeds/places?level=barangay&code=${t.city}`)).status, 400);
  assert.equal((await app.call('GET', `/feeds/places?level=city`)).status, 400, 'no code and no home area');
  assert.equal((await app.call('GET', `/feeds/places?level=moon&code=${t.city}`)).status, 400);
});

test('places feed: quiet levels suggest the next level out', async () => {
  const t = await testCity();
  const viewer = await app.person({ home_area: t.b1 });
  const a = await app.person();
  await rawPost(a.id, t.b1, 'city', 1);
  const q = await viewer.call('GET', '/feeds/places?level=barangay');
  assert.deepEqual(q.body.quiet, { next_level: 'city', next_code: t.city, next_name: `Test Town ${areaSeq}` });
  const c = await viewer.call('GET', '/feeds/places?level=city');
  assert.equal(c.body.quiet.next_level, 'region');
  const busy = await testCity();
  for (let i = 0; i < 5; i++) await rawPost((await app.person()).id, busy.b1, 'barangay', 1);
  assert.equal((await app.call('GET', `/feeds/places?level=barangay&code=${busy.b1}`)).body.quiet, undefined);
  // old posts do not count as activity
  const old = await testCity();
  for (let i = 0; i < 5; i++) await rawPost((await app.person()).id, old.b1, 'barangay', 30);
  assert.equal((await app.call('GET', `/feeds/places?level=barangay&code=${old.b1}`)).body.quiet.next_level, 'city');
});

test('places feed: fair traffic caps one author; ranking uses nearness and thanks', async () => {
  const t = await testCity();
  const viewer = await app.person({ home_area: t.b1 });
  const loud = await app.person(), quiet = await app.person();
  for (let i = 0; i < 6; i++) await rawPost(loud.id, t.b2, 'city', 1 + i * 0.1, `loud ${i}`);
  const q = await rawPost(quiet.id, t.b2, 'city', 3, 'quiet');
  const city = await viewer.call('GET', '/feeds/places?level=city');
  const authors = city.body.posts.map((x: { author: { id: string } }) => x.author.id);
  assert.equal(authors.filter((x: string) => x === loud.id).length, 2, 'at most 2 per author in every 20');
  assert.ok(city.body.posts.some((x: { id: string }) => x.id === q));

  // a nearer post outranks an equally fresh one from the other barangay at City level
  const t2 = await testCity();
  const v2 = await app.person({ home_area: t2.b1, trade: 'rider' });
  const far = await rawPost((await app.person()).id, t2.b2, 'city', 1, 'far');
  const near = await rawPost((await app.person()).id, t2.b1, 'city', 1, 'near');
  assert.deepEqual((await v2.call('GET', '/feeds/places?level=city')).body.posts.map((x: { id: string }) => x.id), [near, far]);

  const why = await v2.call('GET', `/posts/${near}/why?level=city`);
  assert.equal(why.body.signals.near, 1);
  assert.equal(why.body.signals.trade, 0);
  assert.equal(why.body.signals.salamats_distinct, 0);
  assert.ok(why.body.signals.fresh_hours >= 0.9 && why.body.signals.fresh_hours <= 1.2);
  assert.deepEqual(why.body.weights, WEIGHTS.city);
  assert.match(why.body.rule, /score =/);
  const whyFar = await v2.call('GET', `/posts/${far}/why?level=city`);
  assert.equal(whyFar.body.signals.near, 0.5);
});

test('places feed: Country mixes cities, at most 1 in 4 from one city while others have posts', async () => {
  const cities = [await testCity(), await testCity(), await testCity(), await testCity()];
  const viewer = await app.person({ home_area: cities[0]!.b1 });
  // the first city posts a lot and recently; the others a little
  for (let i = 0; i < 8; i++) await rawPost((await app.person()).id, cities[0]!.b1, 'country', 0.1 + i * 0.01);
  for (const c of cities.slice(1)) for (let i = 0; i < 3; i++) await rawPost((await app.person()).id, c.b1, 'country', 2 + i * 0.01);
  const f = await viewer.call('GET', '/feeds/places?level=country&limit=50');
  assert.match(f.body.rule, /1 in 4/);
  const posts: { place: { code: string } | null }[] = f.body.posts;
  const ours = posts.filter((x) => cities.some((c) => c.b1 === x.place?.code));
  assert.equal(ours.length, 17);
  // check the whole feed (other tests' posts included) by each post's city
  const rows = await app.db.query<{ code: string; city_code: string | null }>('SELECT code, city_code FROM areas WHERE code = ANY($1)', [posts.map((x) => x.place?.code ?? '')]);
  const cityOf = new Map(rows.map((r) => [r.code, r.city_code]));
  const seq: (string | null)[] = posts.map((x) => (x.place ? cityOf.get(x.place.code) ?? null : null));
  const lastOurs = posts.indexOf(ours[ours.length - 1]!);
  // the rule must hold while other cities still have posts: up to where the busy city's run begins
  const firstTail = seq.findIndex((c, i) => i > 0 && c === cities[0]!.city && seq.slice(i + 1, lastOurs + 1).every((x) => x === cities[0]!.city || !cities.some((cc) => cc.city === x)));
  const strict = seq.slice(0, firstTail > 0 ? firstTail : lastOurs + 1);
  assert.ok(strict.length >= 12);
  assert.ok(windowsOk(strict, (x) => x, 4, 1), seq.join(' '));
});

test('trade feed and picks', async () => {
  const t = await testCity();
  const viewer = await app.person({ home_area: t.b1, trade: 'tutor' });
  const tutor = await app.person({ trade: 'tutor' }), rider = await app.person({ trade: 'rider' });
  const tp = await rawPost(tutor.id, t.b2, 'city', 1, 'tutor post');
  const rp = await rawPost(rider.id, t.b2, 'city', 1, 'rider post');
  const tr = await viewer.call('GET', '/feeds/trade');
  assert.deepEqual(tr.body.posts.map((x: { id: string }) => x.id), [tp]);
  assert.equal(tr.body.trade, 'tutor');
  assert.ok(tr.body.rule && tr.body.as_of);
  const asRider = await viewer.call('GET', '/feeds/trade?trade=rider');
  assert.deepEqual(asRider.body.posts.map((x: { id: string }) => x.id), [rp]);
  assert.equal((await viewer.call('GET', '/feeds/trade?trade=pilot')).status, 400);

  // picks: last week's posts with thanks from the most different people
  const lastWeek = manilaWeek(new Date(Date.now() - 7 * 86400_000));
  const givers = [await app.person(), await app.person(), await app.person()];
  for (const g of givers) await app.db.query('INSERT INTO salamats (giver_id, receiver_id, post_id, week) VALUES ($1, $2, $3, $4)', [g.id, tutor.id, tp, lastWeek]);
  await app.db.query('INSERT INTO salamats (giver_id, receiver_id, post_id, week) VALUES ($1, $2, $3, $4)', [givers[0]!.id, rider.id, rp, lastWeek]);
  const picks = await app.call('GET', '/feeds/picks');
  assert.equal(picks.body.week, lastWeek);
  assert.ok(picks.body.as_of);
  const ids = picks.body.posts.map((x: { id: string }) => x.id);
  assert.ok(ids.indexOf(tp) >= 0 && ids.indexOf(tp) < ids.indexOf(rp), 'more distinct givers first');
});
