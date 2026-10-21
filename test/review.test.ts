// Live site review roulette: end to end over HTTP. Every site and name here is a test fixture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, type TestApp } from './helpers.ts';
import { CONSENT_VERSION, CONSENTS, PER_ADDRESS, roundCode, siteUrl, sweepReviews } from '../app/modules/review/routes.ts';

let app: TestApp;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const all = Object.fromEntries(CONSENTS.map((k) => [k, true]));
const entry = (extra: Record<string, unknown> = {}) => ({
  url: 'https://fixture-site.example.com', name: 'Test Viewer', handle: 'tester', signature: 'Test Viewer Fixture',
  consents: all, consent_version: CONSENT_VERSION, ...extra,
});

/** A browser: GET /review gives it the `rv` device cookie, which it sends from then on. */
async function viewer() {
  const r = await app.call('GET', '/review');
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0] as string;
  assert.match(cookie, /^rv=[A-Za-z0-9_-]{43}$/);
  return { cookie, call: (m: string, path: string, body?: unknown) => app.call(m, path, body, cookie) };
}

test('site addresses: public http(s) sites only', () => {
  assert.equal(siteUrl('fixture-site.com'), 'https://fixture-site.com/');
  assert.equal(siteUrl('fixture-site.com:8080/x'), 'https://fixture-site.com:8080/x', 'a port is not a scheme');
  assert.equal(siteUrl('https://a.fixture.ph/path?x=1'), 'https://a.fixture.ph/path?x=1');
  for (const bad of ['javascript:alert(1)', 'ftp://files.fixture.com', ['https://user:pw', 'fixture.com'].join(String.fromCharCode(64)), 'http://localhost:3000', 'http://203.0.113.7',
    'http://[::1]/', 'https://printer.local', 'intranet', 'data:text/html,hi', 'https://x.example']) {
    assert.throws(() => siteUrl(bad), bad);
  }
  assert.equal(roundCode(new Date('2026-10-22T11:36:00Z')), 'live-202610221936', 'Manila time');
});

test('the entry button submits the form', () => {
  const js = readFileSync(join(import.meta.dirname, '..', 'app', 'web', 'static', 'screens', 'review.js'), 'utf8');
  assert.match(js, /btn\('Enter the roulette', \{[^}]*type: 'submit'/);
});

test('closed until a round is open; staff only for the host', async () => {
  const pub = await app.call('GET', '/review');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.round, null);
  assert.equal(pub.body.entered, false);
  assert.ok(pub.body.as_of);
  assert.match(pub.headers.get('set-cookie') || '', /HttpOnly; SameSite=Lax/);
  assert.equal((await app.call('POST', '/review/entries', entry())).status, 409, 'no round yet');
  const member = await app.person();
  assert.equal((await member.call('GET', '/review/host')).status, 403);
  assert.equal((await member.call('POST', '/review/rounds')).status, 403);
  assert.equal((await app.call('POST', '/review/spin')).status, 401);
});

test('a round: open, one entry per device, staff check, then the draw', async () => {
  const staff = await app.person({ role: 'staff' });
  const made = await staff.call('POST', '/review/rounds');
  assert.equal(made.status, 201);
  assert.match(made.body.round.code, /^live-\d{12}/);
  assert.equal(made.body.round.accepting, false, 'a new round starts closed');
  const v1 = await viewer();
  assert.equal((await v1.call('POST', '/review/entries', entry())).status, 409, 'closed');

  assert.equal((await staff.call('PATCH', '/review/rounds/current', { accepting: true })).body.round.accepting, true);
  assert.equal((await app.call('GET', '/review')).body.round.accepting, true);

  assert.equal((await v1.call('POST', '/review/entries', entry({ consents: { ...all, data: false } }))).status, 400, 'every point');
  assert.equal((await v1.call('POST', '/review/entries', entry({ consent_version: '2000-01-01' }))).status, 409, 'old consent text');
  assert.equal((await v1.call('POST', '/review/entries', entry({ signature: '' }))).status, 400, 'signed');
  assert.equal((await v1.call('POST', '/review/entries', entry({ url: 'http://localhost' }))).status, 400);

  const ok = await v1.call('POST', '/review/entries', entry());
  assert.equal(ok.status, 201);
  assert.equal(ok.body.entry.handle, '@tester');
  assert.equal(ok.body.entry.url, 'https://fixture-site.example.com/');
  assert.equal((await v1.call('POST', '/review/entries', entry({ url: 'https://other.fixture.com' }))).status, 409, 'one entry per device');
  assert.equal((await v1.call('GET', '/review')).body.entered, true);
  const v2 = await viewer();
  assert.equal((await v2.call('GET', '/review')).body.entered, false, 'same address, another device: not entered');
  assert.equal((await v2.call('POST', '/review/entries', entry({ name: 'Second Fixture', url: 'https://two.fixture.com' }))).status, 201, 'a shared address still lets others in');
  const row = await app.db.one<{ ip_hash: Buffer; device_hash: Buffer; signature: string }>(`SELECT ip_hash, device_hash, signature FROM review_entries WHERE name = 'Test Viewer'`);
  assert.equal(row!.signature, 'Test Viewer Fixture');
  assert.equal(Buffer.from(row!.ip_hash).length, 32, 'the address is only a keyed hash');
  assert.ok(!Buffer.from(row!.device_hash).toString('latin1').includes(v1.cookie.slice(3)), 'the device code is only a keyed hash');

  // new entries wait for a staff check: not in the draw, not counted as in
  let host = await staff.call('GET', '/review/host');
  assert.deepEqual(host.body.counts, { in: 0, left: 0, to_check: 2 });
  assert.equal(host.body.entries[0].signature, undefined, 'the host screen is shown on stream: no signatures');
  assert.equal(host.body.entries[0].ip_hash, undefined);
  assert.equal((await staff.call('POST', '/review/spin')).status, 409, 'nothing let in yet');
  for (const e of host.body.entries) await staff.call('PATCH', '/review/entries/' + e.id, { status: 'waiting' });
  host = await staff.call('GET', '/review/host');
  assert.deepEqual(host.body.counts, { in: 2, left: 2, to_check: 0 });

  const spin = await staff.call('POST', '/review/spin');
  assert.equal(spin.status, 200);
  assert.equal(spin.body.pool.length, 2);
  assert.ok(spin.body.pool.some((p: { id: string }) => p.id === spin.body.picked));
  assert.equal(spin.body.counts.left, 1);
  assert.equal((await staff.call('POST', '/review/spin')).status, 409, 'finish the current pick first');
  const other = host.body.entries.find((e: { id: string }) => e.id !== spin.body.picked);
  await assert.rejects(app.db.query(`UPDATE review_entries SET status = 'picked' WHERE id = $1`, [other.id]), 'the database holds one pick per round');

  for (const bad of ['picked', 'pending']) assert.equal((await staff.call('PATCH', '/review/entries/' + spin.body.picked, { status: bad })).status, 400, bad);
  const done = await staff.call('PATCH', '/review/entries/' + spin.body.picked, { status: 'reviewed' });
  assert.equal(done.body.entries.find((e: { id: string }) => e.id === spin.body.picked).status, 'reviewed');
  const last = await staff.call('POST', '/review/spin');
  assert.equal(last.body.pool.length, 1);
  await staff.call('PATCH', '/review/entries/' + last.body.picked, { status: 'skipped' });
  assert.equal((await staff.call('POST', '/review/spin')).status, 409, 'nothing left');

  assert.equal((await staff.call('DELETE', '/review/entries/' + last.body.picked)).status, 204, 'withdrawn');
  assert.equal((await staff.call('GET', '/review/host')).body.counts.in, 1);

  // a new round: empty and closed, the old round's hashes are gone, and the device may enter again
  const next = await staff.call('POST', '/review/rounds');
  assert.deepEqual(next.body.counts, { in: 0, left: 0, to_check: 0 });
  assert.notEqual(next.body.round.code, made.body.round.code);
  const left = await app.db.one<{ n: string }>('SELECT count(*) AS n FROM review_entries WHERE device_hash IS NOT NULL OR ip_hash IS NOT NULL');
  assert.equal(Number(left!.n), 0, 'hashes cleared');
  await staff.call('PATCH', '/review/rounds/current', { accepting: true });
  assert.equal((await v1.call('GET', '/review')).body.entered, false);
  assert.equal((await v1.call('POST', '/review/entries', entry())).status, 201);

  // one internet address: a loose cap per round
  for (let i = 1; i < PER_ADDRESS; i++) assert.equal((await (await viewer()).call('POST', '/review/entries', entry({ name: 'Fixture ' + i }))).status, 201);
  assert.equal((await (await viewer()).call('POST', '/review/entries', entry({ name: 'One too many' }))).status, 429);
});

test('entries older than 90 days are deleted', async () => {
  await app.db.query(`UPDATE review_entries SET created_at = now() - interval '91 days'`);
  assert.ok((await sweepReviews(app.db)) > 0);
  assert.equal(Number((await app.db.one<{ n: string }>('SELECT count(*) AS n FROM review_entries'))!.n), 0);
});
