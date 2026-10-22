// Usernames (decision 0009): the shape rule, reserved names, look-alikes, and that the client, the
// server, the database and the router agree on them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HANDLE_RE, RESERVED, handleKey, handleProblem, isReserved } from '../app/modules/accounts/handles.ts';
import { inviteByEmail, TERMS_VERSION } from '../app/modules/accounts/routes.ts';
import { devOutbox } from '../app/mail/send.ts';
import { limits, RateLimiter } from '../app/http/security.ts';
import { startApp, type TestApp } from './helpers.ts';

const load = (rel: string): Promise<any> => import(pathToFileURL(join(import.meta.dirname, '..', 'app', 'web', 'static', rel)).href);

let app: TestApp;
before(async () => { app = await startApp(); limits.auth = new RateLimiter(1000, 60_000); });
after(async () => { await app.close(); });

test('the shape rule', () => {
  for (const ok of ['ana', 'maria.santos', 'jun_rides', 'a1b', 'x'.repeat(30), 'r.i.d.e.r']) assert.ok(HANDLE_RE.test(ok), ok);
  for (const no of ['ab', 'x'.repeat(31), '.ana', 'ana.', '_ana', 'ana_', 'a..b', 'Ana', 'ana-b', 'ana b', 'añа', '']) assert.ok(!HANDLE_RE.test(no), no);
});

test('reserved names and their look-alikes are refused; ordinary names are not', async () => {
  for (const r of ['admin', 'adm1n', 'a.d.m.i.n', 'adrnin', 'admln', 'overseer', '0verseer', 'ov3rs33r', 'staff', 'mod', 'moderator', 'support',
    'security', 'popcart', 'pop_cart', 'community', 'sw.js', 'manifest.webmanifest', 'robots.txt', 'api', 'static', 'media', 'brand', 'me', 'transparency']) {
    assert.ok(isReserved(r), r);
  }
  // A staff word as any part of a name, the brand anywhere, and the shape of a deleted account's name.
  for (const r of ['admin.popcart', 'popcart_official', 'official.popcart', 'staff.popcart', 'support.team', 'overseer1', 'popcartphl',
    'theoverseer', 'kim.moderator', 'deleted.abcdef12', 'jun_admin', 'mod.jun', 's3curity.ph']) {
    assert.ok(isReserved(r), r);
  }
  // Review of #22: a letter after the word must not fold it away (rn -> m), and a digit splits parts too.
  for (const r of ['overseernews', 'theoverseernews', 'moderatorn', 'administratorn', 'popcartnews', 'admin2jun', 'jun2admin', 'admin4u',
    'support24x7', 'mod1jun',
    // Second review of #22: digits as letters and as breaks in one name, and mixed folds.
    'st4ff1', 'm0d1', 'adm1n2', 'h3lpd3sk2', 'n0reply2', 'd3leted9', 'verifi3d1', 'sysadm1n2', 'm0ds2', 'adm1n2jun', 'jun2adm1n',
    's3curity24x7', 'supp0rt24x7', 'rnoderatorn', 'rnoderatornews', 'adrninistratorn', 'adrninistratornews',
    // Third review: a dot or underscore inside the word.
    'adm.in2', 'a.dmin2', 'ad.min.jun', 's_taff2', 'st.aff_ph', 'mo.d2', 'sup.port24x7', 'a.d.m.i.n.2']) {
    assert.ok(isReserved(r), r);
  }
  for (const ok of ['maria.santos', 'admiral', 'adminah', 'staffing.pro', 'jun.rides', 'moderna', 'lia.cruz', 'modesto', 'supporter.of.jun', 'jun2rides', 'ma1a.santos', 'carnival', 'vernon']) assert.equal(await handleProblem(ok), null, ok);
  assert.equal(await handleProblem('adm1n'), 'reserved');
  assert.equal(await handleProblem('a..b'), 'shape');
});

test('every screen path of the web app is a reserved name, so no profile can hide a screen', async () => {
  const r = await load('lib/router.js');
  for (const [, path] of r.ROUTES) {
    const first = String(path).split('/')[1];
    if (first && !first.startsWith(':')) assert.ok(isReserved(first), `/${first} must be reserved`);
  }
});

test('the client rule is the server rule', async () => {
  const f = await load('lib/format.js');
  for (const s of ['ana', 'a..b', '.ana', 'ana_', 'maria.santos', 'x'.repeat(31), 'ab', 'a_b.c']) assert.equal(f.HANDLE_RE.test(s), HANDLE_RE.test(s), s);
});

test('the database look-alike key matches handleKey()', async () => {
  for (const h of ['maria.santos', 'm4ria_s4nt0s', 'r1d3r.7_5', 'plain', 'adrnin', 'vvelder.2689', 'lola_l']) {
    const row = await app.db.one<{ k: string }>(`SELECT replace(replace(translate($1, '0123456789l._', 'oizeasgtbgi'), 'rn', 'm'), 'vv', 'w') AS k`, [h]);
    assert.equal(row!.k, handleKey(h), h);
  }
  const p = await app.person({ handle: 'kim.welds' });
  const row = await app.db.one<{ handle_key: string }>('SELECT handle_key FROM users WHERE id = $1', [p.id]);
  assert.equal(row!.handle_key, 'kimweids');
});

const codeIn = (to: string) => /\b(\d{6})\b/.exec([...devOutbox].reverse().find((m) => m.to === to)?.subject || '')?.[1] || '';

test('joining: reserved names and look-alikes of existing people are refused with a message to show', async () => {
  await inviteByEmail(app.db, app.config, { email: 'handles@example.com', days: 1 });
  await app.call('POST', '/accounts/join/start', { email: 'handles@example.com' });
  const { ticket } = (await app.call('POST', '/accounts/join/verify', { email: 'handles@example.com', code: codeIn('handles@example.com') })).body;
  const good = { ticket, handle: 'new.welder', first_name: 'Kim', trade: 'other', agree: true, adult: true, terms_version: TERMS_VERSION };
  for (const h of ['admin', 'adm1n', '0verseer', 'sw.js', 'transparency']) {
    const r = await app.call('POST', '/accounts/register/options', { ...good, handle: h });
    assert.equal(r.status, 409, h);
    assert.equal(r.body.error.code, 'handle_reserved', h);
    assert.match(r.body.error.message, /reserved/);
  }
  await app.person({ handle: 'maria.santos' });
  for (const h of ['mariasantos', 'maria_santos', 'm4ria.s4ntos']) assert.equal((await app.call('POST', '/accounts/register/options', { ...good, handle: h })).body.error.code, 'handle_taken', h);
  assert.equal((await app.call('POST', '/accounts/register/options', { ...good, handle: 'a..b' })).status, 400);
  assert.equal((await app.call('POST', '/accounts/register/options', { ...good, handle: 'New.Welder' })).status, 200, 'capitals are lowered, not refused');
});

test('a reserved name that nobody holds looks exactly like a name nobody has (older accounts keep theirs: npm run handles:check lists them)', async () => {
  const a = await app.call('GET', '/people/admin');
  const b = await app.call('GET', '/people/nobody.has.this');
  assert.equal(a.status, 404);
  assert.deepEqual(a.body, b.body);
});

test('the list has no duplicates', () => {
  assert.equal(new Set(RESERVED).size, RESERVED.length);
});
