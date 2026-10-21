// Live site review roulette: end to end over HTTP. Every site and name here is a test fixture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type TestApp } from './helpers.ts';
import { CONSENT_VERSION, CONSENTS, roundCode, siteUrl } from '../app/modules/review/routes.ts';

let app: TestApp;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const all = Object.fromEntries(CONSENTS.map((k) => [k, true]));
const entry = (extra: Record<string, unknown> = {}) => ({
  url: 'https://fixture-site.example.com', name: 'Test Viewer', handle: 'tester', signature: 'Test Viewer Fixture',
  consents: all, consent_version: CONSENT_VERSION, ...extra,
});

test('site addresses: public http(s) sites only', () => {
  assert.equal(siteUrl('fixture-site.com'), 'https://fixture-site.com/');
  assert.equal(siteUrl('https://a.fixture.ph/path?x=1'), 'https://a.fixture.ph/path?x=1');
  for (const bad of ['javascript:alert(1)', 'ftp://files.fixture.com', ['https://user:pw', 'fixture.com'].join(String.fromCharCode(64)), 'http://localhost:3000', 'http://203.0.113.7',
    'http://[::1]/', 'https://printer.local', 'intranet', 'data:text/html,hi', 'https://x.example']) {
    assert.throws(() => siteUrl(bad), bad);
  }
  assert.equal(roundCode(new Date('2026-10-22T11:36:00Z')), 'live-202610221936', 'Manila time');
});

test('closed until a round is open; staff only for the host', async () => {
  const pub = await app.call('GET', '/review');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.round, null);
  assert.equal(pub.body.entered, false);
  assert.ok(pub.body.as_of);
  assert.equal((await app.call('POST', '/review/entries', entry())).status, 409, 'no round yet');
  const member = await app.person();
  assert.equal((await member.call('GET', '/review/host')).status, 403);
  assert.equal((await member.call('POST', '/review/rounds')).status, 403);
  assert.equal((await app.call('POST', '/review/spin')).status, 401);
});

test('a round: open, one entry per viewer, every consent point, then the draw', async () => {
  const staff = await app.person({ role: 'staff' });
  const made = await staff.call('POST', '/review/rounds');
  assert.equal(made.status, 201);
  assert.match(made.body.round.code, /^live-\d{12}/);
  assert.equal(made.body.round.accepting, false, 'a new round starts closed');
  assert.equal((await app.call('POST', '/review/entries', entry())).status, 409, 'closed');

  assert.equal((await staff.call('PATCH', '/review/rounds/current', { accepting: true })).body.round.accepting, true);
  assert.equal((await app.call('GET', '/review')).body.round.accepting, true);

  const missing = { ...all, data: false };
  assert.equal((await app.call('POST', '/review/entries', entry({ consents: missing }))).status, 400, 'every point');
  assert.equal((await app.call('POST', '/review/entries', entry({ consent_version: '2000-01-01' }))).status, 409, 'old consent text');
  assert.equal((await app.call('POST', '/review/entries', entry({ signature: '' }))).status, 400, 'signed');
  assert.equal((await app.call('POST', '/review/entries', entry({ url: 'http://localhost' }))).status, 400);

  const ok = await app.call('POST', '/review/entries', entry());
  assert.equal(ok.status, 201);
  assert.equal(ok.body.entry.handle, '@tester');
  assert.equal(ok.body.entry.url, 'https://fixture-site.example.com/');
  assert.equal((await app.call('POST', '/review/entries', entry({ url: 'https://other.fixture.com' }))).status, 409, 'one entry per viewer');
  assert.equal((await app.call('GET', '/review')).body.entered, true);
  const row = await app.db.one<{ ip_hash: Buffer; signature: string }>('SELECT ip_hash, signature FROM review_entries');
  assert.equal(row!.signature, 'Test Viewer Fixture');
  assert.equal(Buffer.from(row!.ip_hash).length, 32, 'the address is only a hash');
  assert.ok(!Buffer.from(row!.ip_hash).toString('latin1').includes('127.0.0.1'));

  // a second viewer (another address) is put in directly, as the test server has one address
  const round = await app.db.one<{ id: string }>('SELECT id FROM review_rounds ORDER BY created_at DESC LIMIT 1');
  await app.db.query(`INSERT INTO review_entries (round_id, url, name, signature, consent_version, ip_hash) VALUES ($1, 'https://two.fixture.com/', 'Second Fixture', 'Second Fixture', $2, '\\x01')`, [round!.id, CONSENT_VERSION]);

  const host = await staff.call('GET', '/review/host');
  assert.equal(host.status, 200);
  assert.deepEqual(host.body.counts, { in: 2, left: 2 });
  assert.equal(host.body.entries[0].signature, undefined, 'the host screen is shown on stream: no signatures');

  const spin = await staff.call('POST', '/review/spin');
  assert.equal(spin.status, 200);
  assert.equal(spin.body.pool.length, 2);
  assert.ok(spin.body.pool.some((p: { id: string }) => p.id === spin.body.picked));
  assert.equal(spin.body.counts.left, 1);
  assert.equal((await staff.call('POST', '/review/spin')).status, 409, 'finish the current pick first');

  assert.equal((await staff.call('PATCH', '/review/entries/' + spin.body.picked, { status: 'picked' })).status, 400, 'only the draw picks');
  const done = await staff.call('PATCH', '/review/entries/' + spin.body.picked, { status: 'reviewed' });
  assert.equal(done.body.entries.find((e: { id: string }) => e.id === spin.body.picked).status, 'reviewed');
  const last = await staff.call('POST', '/review/spin');
  assert.equal(last.body.pool.length, 1);
  await staff.call('PATCH', '/review/entries/' + last.body.picked, { status: 'skipped' });
  assert.equal((await staff.call('POST', '/review/spin')).status, 409, 'nothing left');

  assert.equal((await staff.call('DELETE', '/review/entries/' + last.body.picked)).status, 204, 'withdrawn');
  assert.equal((await staff.call('GET', '/review/host')).body.counts.in, 1);

  // a new round: empty and closed, and the same viewer may enter it once opened
  const next = await staff.call('POST', '/review/rounds');
  assert.deepEqual(next.body.counts, { in: 0, left: 0 });
  assert.notEqual(next.body.round.code, made.body.round.code);
  await staff.call('PATCH', '/review/rounds/current', { accepting: true });
  assert.equal((await app.call('GET', '/review')).body.entered, false);
  assert.equal((await app.call('POST', '/review/entries', entry())).status, 201);
});

test('entries older than 90 days are deleted', async () => {
  await app.db.query(`UPDATE review_entries SET created_at = now() - interval '91 days'`);
  const staff = await app.person({ role: 'staff' });
  await staff.call('GET', '/review/host');
  assert.equal(Number((await app.db.one<{ n: string }>('SELECT count(*) AS n FROM review_entries'))!.n), 0);
});
