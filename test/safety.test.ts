// Safety, your data, and media: end to end over HTTP. Fixture rows are inserted directly where the
// owning module (posts, spaces, messages) is built elsewhere; every name here is a test fixture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, type Person, type TestApp } from './helpers.ts';

let app: TestApp;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

async function post(author: Person, body = 'A test post', spaceId: string | null = null): Promise<string> {
  const r = await app.db.one<{ id: string }>('INSERT INTO posts (author_id, body, space_id) VALUES ($1, $2, $3) RETURNING id', [author.id, body, spaceId]);
  return r!.id;
}

async function space(owner: Person, slug: string, visibility = 'public'): Promise<string> {
  const s = await app.db.one<{ id: string }>(
    `INSERT INTO spaces (slug, name, kind, visibility, created_by) VALUES ($1, $2, 'crew', $3, $4) RETURNING id`, [slug, `Space ${slug}`, visibility, owner.id]);
  await app.db.query(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')`, [s!.id, owner.id]);
  return s!.id;
}

const join_ = (spaceId: string, p: Person, role = 'member') =>
  app.db.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [spaceId, p.id, role]);

const report = (p: Person, target_kind: string, target_id: string, reason = 'scam', extra: Record<string, unknown> = {}) =>
  p.call('POST', '/reports', { target_kind, target_id, reason, ...extra });

const deletedAt = async (id: string) => (await app.db.one<{ deleted_at: string | null }>('SELECT deleted_at FROM posts WHERE id = $1', [id]))!.deleted_at;

test('reports: the target must exist, never yourself, never twice', async () => {
  const a = await app.person(), b = await app.person();
  const p = await post(b);
  assert.equal((await report(a, 'post', '00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await report(a, 'post', 'not-an-id')).status, 400);
  assert.equal((await report(a, 'nonsense', p)).status, 400);
  assert.equal((await report(b, 'post', p)).status, 400, 'not your own post');
  assert.equal((await report(a, 'user', a.id)).status, 400, 'not yourself');
  const ok = await report(a, 'post', p, 'scam', { note: 'asks for a deposit first' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.report.status, 'open');
  assert.equal((await report(a, 'post', p, 'harassment')).status, 409);
  assert.equal((await report(a, 'post', p, 'other', { revealed: [{ text: 'x' }] })).status, 400, 'revealed is for DMs');
  assert.equal(await deletedAt(p), null, 'an ordinary report does not hide anything');
});

test('reports: a private Space post cannot be reported by someone outside it', async () => {
  const owner = await app.person(), outsider = await app.person();
  const s = await space(owner, 'private-crew-one', 'private');
  const p = await post(owner, 'members only', s);
  const member = await app.person();
  await join_(s, member);
  assert.equal((await report(outsider, 'post', p)).status, 404);
  assert.equal((await report(member, 'post', p)).status, 201);
});

test('child_safety: hidden at once, staff only', async () => {
  const author = await app.person(), reporter = await app.person(), mod = await app.person(), staff = await app.person({ role: 'staff' });
  const s = await space(mod, 'cs-space');
  const p = await post(author, 'to be hidden', s);
  const r = await report(reporter, 'post', p, 'child_safety');
  assert.equal(r.status, 201);
  assert.equal(r.body.report.goes_to, 'staff');
  assert.notEqual(await deletedAt(p), null, 'hidden immediately');
  const modQueue = await mod.call('GET', '/mod/reports?space=cs-space');
  assert.equal(modQueue.status, 200);
  assert.equal(modQueue.body.reports.length, 0, 'the Space moderator never sees child_safety');
  assert.equal((await mod.call('POST', `/mod/reports/${r.body.report.id}/decide`, { action: 'keep' })).status, 404);
  const staffQueue = await staff.staff('GET', '/staff/reports');
  const seen = staffQueue.body.reports.find((x: any) => x.id === r.body.report.id);
  assert.ok(seen, 'staff see it');
  assert.equal(seen.reporter.id, reporter.id);
  assert.equal(seen.target.body, 'to be hidden');
  // staff keep it: the hide is undone
  assert.equal((await staff.staff('POST', `/staff/reports/${r.body.report.id}/decide`, { action: 'keep', note: 'not a violation' })).status, 204);
  assert.equal(await deletedAt(p), null);
});

test('child_safety escalation does not tip off the author', async () => {
  const author = await app.person(), reporter = await app.person(), staff = await app.person({ role: 'staff' });
  const p = await post(author, 'escalate me');
  const r = await report(reporter, 'post', p, 'child_safety');
  assert.equal((await staff.staff('POST', `/staff/reports/${r.body.report.id}/decide`, { action: 'escalate', note: 'routed to the authorities' })).status, 204);
  const n = await app.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [author.id]);
  assert.equal(n!.n, 0);
  assert.equal((await author.call('GET', '/me/mod-actions')).body.actions.length, 0);
  assert.notEqual(await deletedAt(p), null, 'still hidden');
});

test('moderation: a Space moderator sees only their own Space', async () => {
  const ownerA = await app.person(), ownerB = await app.person(), modA = await app.person(), member = await app.person();
  const reporter = await app.person(), author = await app.person();
  const sa = await space(ownerA, 'space-alpha'), sb = await space(ownerB, 'space-beta');
  await join_(sa, modA, 'moderator');
  await join_(sa, member);
  const pa = await post(author, 'in alpha', sa), pb = await post(author, 'in beta', sb), pNone = await post(author, 'no space');
  const ra = await report(reporter, 'post', pa), rb = await report(reporter, 'post', pb), rn = await report(reporter, 'post', pNone);
  assert.equal(ra.body.report.goes_to, 'space_moderators');
  assert.equal(rn.body.report.goes_to, 'staff');

  const q = await modA.call('GET', '/mod/reports');
  assert.equal(q.status, 200);
  assert.deepEqual(q.body.reports.map((x: any) => x.id), [ra.body.report.id]);
  assert.equal(q.body.reports[0].reporter, null, 'reporters are hidden from Space moderators');
  assert.ok(q.body.as_of);
  assert.equal((await modA.call('GET', '/mod/reports?space=space-beta')).status, 403);
  assert.equal((await member.call('GET', '/mod/reports')).status, 403);
  assert.equal((await modA.call('POST', `/mod/reports/${rb.body.report.id}/decide`, { action: 'keep' })).status, 403);
  assert.equal((await modA.call('POST', `/mod/reports/${rn.body.report.id}/decide`, { action: 'keep' })).status, 404);
  const ownerQ = await ownerA.call('GET', '/mod/reports?space=space-alpha');
  assert.deepEqual(ownerQ.body.reports.map((x: any) => x.id), [ra.body.report.id], 'the owner moderates too');
});

test('decide: remove hides the post, logs the action and tells the author', async () => {
  const owner = await app.person(), author = await app.person(), reporter = await app.person(), reporter2 = await app.person();
  const s = await space(owner, 'decide-space');
  const p = await post(author, 'a scam offer', s);
  const r = await report(reporter, 'post', p);
  const r2 = await report(reporter2, 'post', p);
  assert.equal((await owner.call('POST', `/mod/reports/${r.body.report.id}/decide`, { action: 'remove' })).status, 400, 'a removal needs a reason');
  assert.equal((await owner.call('POST', `/mod/reports/${r.body.report.id}/decide`, { action: 'ban', note: 'x' })).status, 400);
  assert.equal((await owner.call('POST', `/mod/reports/${r.body.report.id}/decide`, { action: 'remove', note: 'Scam: asks for money first' })).status, 204);
  assert.notEqual(await deletedAt(p), null);
  assert.equal((await owner.call('POST', `/mod/reports/${r.body.report.id}/decide`, { action: 'keep' })).status, 409);
  const sibling = await app.db.one<{ status: string }>('SELECT status FROM reports WHERE id = $1', [r2.body.report.id]);
  assert.equal(sibling!.status, 'removed', 'the other open report of the same post is closed too');
  const act = await app.db.one<{ id: string; actor_id: string; action: string; reason: string }>('SELECT id, actor_id, action, reason FROM mod_actions WHERE target_id = $1', [p]);
  assert.equal(act!.actor_id, owner.id);
  assert.equal(act!.action, 'remove');
  const note = await app.db.one<{ kind: string; ref_id: string }>('SELECT kind, ref_id FROM notifications WHERE user_id = $1', [author.id]);
  assert.equal(note!.kind, 'mod_action');
  assert.equal(note!.ref_id, act!.id);
  const mine = await author.call('GET', '/me/mod-actions');
  assert.equal(mine.body.actions.length, 1);
  assert.equal(mine.body.actions[0].reason, 'Scam: asks for money first');
  assert.equal(mine.body.actions[0].can_appeal, true);
});

test('a moderator cannot decide a report about their own content', async () => {
  const owner = await app.person(), reporter = await app.person();
  const s = await space(owner, 'own-content-space');
  const p = await post(owner, 'my own post', s);
  const r = await report(reporter, 'post', p);
  assert.equal((await owner.call('GET', '/mod/reports')).body.reports.length, 0);
  assert.equal((await owner.call('POST', `/mod/reports/${r.body.report.id}/decide`, { action: 'keep' })).status, 403);
});

test('appeals: once each, decided by a different staff member only', async () => {
  const author = await app.person(), reporter = await app.person();
  const staffA = await app.person({ role: 'staff' }), staffB = await app.person({ role: 'staff' }), member = await app.person();
  const p = await post(author, 'appeal me');
  const r = await report(reporter, 'post', p, 'harassment');
  assert.equal((await staffA.staff('POST', `/staff/reports/${r.body.report.id}/decide`, { action: 'remove', note: 'Harassment' })).status, 204);
  const actionId = (await author.call('GET', '/me/mod-actions')).body.actions[0].id;
  assert.equal((await reporter.call('POST', `/me/mod-actions/${actionId}/appeal`, { note: 'not mine' })).status, 404);
  assert.equal((await author.call('POST', `/me/mod-actions/${actionId}/appeal`, { note: 'It was a joke between friends' })).status, 204);
  assert.equal((await author.call('POST', `/me/mod-actions/${actionId}/appeal`, { note: 'again please' })).status, 409);

  const list = await staffA.staff('GET', '/staff/appeals');
  const mineInList = list.body.appeals.find((x: any) => x.id === actionId);
  assert.equal(mineInList.can_decide, false);
  assert.equal((await member.call('POST', `/mod/appeals/${actionId}/decide`, { decision: 'overturned', note: 'ok then' })).status, 404, 'no appeals API on the public host');
  assert.equal((await staffA.staff('POST', `/staff/appeals/${actionId}/decide`, { decision: 'overturned', note: 'ok then' })).status, 403);
  assert.equal((await staffB.staff('POST', `/staff/appeals/${actionId}/decide`, { decision: 'overturned', note: 'Context shows a joke' })).status, 204);
  assert.equal((await staffB.staff('POST', `/staff/appeals/${actionId}/decide`, { decision: 'upheld', note: 'changed my mind' })).status, 409);
  assert.equal(await deletedAt(p), null, 'overturned: the post is back');
  const after_ = (await author.call('GET', '/me/mod-actions')).body.actions;
  const original = after_.find((x: any) => x.id === actionId);
  assert.equal(original.appeal_decision, 'overturned');
  assert.equal(original.can_appeal, false);
  assert.ok(after_.some((x: any) => x.action === 'restore'));
});

test('a keep decision cannot be appealed', async () => {
  const author = await app.person(), reporter = await app.person(), staff = await app.person({ role: 'staff' });
  const p = await post(author, 'fine post');
  const r = await report(reporter, 'post', p);
  await staff.staff('POST', `/staff/reports/${r.body.report.id}/decide`, { action: 'keep' });
  const a = (await author.call('GET', '/me/mod-actions')).body.actions[0];
  assert.equal(a.can_appeal, false);
  assert.equal((await author.call('POST', `/me/mod-actions/${a.id}/appeal`, { note: 'why?' })).status, 400);
});

test('DMs: only a participant can report, and only staff see what was revealed', async () => {
  const a = await app.person(), b = await app.person(), c = await app.person(), staff = await app.person({ role: 'staff' });
  const [ua, ub] = [a.id, b.id].sort();
  const conv = await app.db.one<{ id: string }>('INSERT INTO conversations (user_a, user_b, accepted) VALUES ($1, $2, true) RETURNING id', [ua, ub]);
  const dm = await app.db.one<{ id: string }>(`INSERT INTO dm_messages (conversation_id, sender_id, sealed) VALUES ($1, $2, '{"v":1,"iv":"aaaa","ct":"bbbb"}') RETURNING id`, [conv!.id, b.id]);
  assert.equal((await report(c, 'dm', dm!.id, 'harassment')).status, 404);
  const r = await report(a, 'dm', dm!.id, 'harassment', { revealed: [{ text: 'a threatening message (test fixture)' }] });
  assert.equal(r.status, 201);
  const q = await staff.staff('GET', '/staff/reports');
  const seen = q.body.reports.find((x: any) => x.id === r.body.report.id);
  assert.equal(seen.revealed[0].text, 'a threatening message (test fixture)');
  assert.equal(seen.target.sealed, true);
});

test('/me/data: plain words, live counts, the vault honestly empty', async () => {
  const a = await app.person(), b = await app.person();
  await post(a, 'one'); await post(a, 'two');
  await a.call('POST', `/people/${b.handle}/follow`);
  const d = await a.call('GET', '/me/data');
  assert.equal(d.status, 200);
  const by = Object.fromEntries(d.body.holds.map((h: any) => [h.key, h]));
  assert.equal(by.posts.count, 2);
  assert.equal(by.following.count, 1);
  assert.equal(by.sessions.count, 1);
  assert.equal(by.passkeys.count, 0);
  for (const k of ['replies', 'salamats_given', 'salamats_received', 'spaces', 'dm_messages', 'gigs', 'applications', 'ratings_given', 'credentials']) assert.ok(k in by, k);
  for (const h of d.body.holds) { assert.equal(typeof h.what, 'string'); assert.equal(typeof h.count, 'number'); }
  assert.equal(d.body.sealed.what, 'Kept in the sealed vault: none yet');
  assert.ok(d.body.as_of);
  await post(a, 'three');
  assert.equal(Object.fromEntries((await a.call('GET', '/me/data')).body.holds.map((h: any) => [h.key, h.count])).posts, 3, 'live, not cached');
  assert.equal((await app.call('GET', '/me/data')).status, 401);
});

test('/me/export: a download of my own rows only', async () => {
  const a = await app.person(), b = await app.person();
  await post(a, 'my exported post');
  const bPost = await post(b, 'someone else wrote this');
  await app.db.query(`INSERT INTO salamats (giver_id, receiver_id, post_id, week) VALUES ($1, $2, $3, '2026-W43')`, [a.id, b.id, bPost]);
  const aPost = await post(a, 'thanked post');
  await app.db.query(`INSERT INTO salamats (giver_id, receiver_id, post_id, week) VALUES ($1, $2, $3, '2026-W43')`, [b.id, a.id, aPost]);
  const [ua, ub] = [a.id, b.id].sort();
  const conv = await app.db.one<{ id: string }>('INSERT INTO conversations (user_a, user_b, accepted) VALUES ($1, $2, true) RETURNING id', [ua, ub]);
  await app.db.query(`INSERT INTO dm_messages (conversation_id, sender_id, sealed) VALUES ($1, $2, '{"v":1,"iv":"iv01","ct":"ct01"}')`, [conv!.id, b.id]);
  const other = await app.person(), third = await app.person();
  const [uo, ut] = [other.id, third.id].sort();
  const c2 = await app.db.one<{ id: string }>('INSERT INTO conversations (user_a, user_b) VALUES ($1, $2) RETURNING id', [uo, ut]);
  await app.db.query(`INSERT INTO dm_messages (conversation_id, sender_id, sealed) VALUES ($1, $2, '{"v":1,"iv":"iv02","ct":"not-yours"}')`, [c2!.id, other.id]);

  const r = await fetch(app.base + '/api/me/export', { headers: { Cookie: a.cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') || '', /^attachment; filename="popcart-community-.+\.json"$/);
  const text = await r.text();
  const data = JSON.parse(text);
  assert.equal(data.profile.id, a.id);
  assert.deepEqual(data.posts.map((p: any) => p.body).sort(), ['my exported post', 'thanked post']);
  assert.ok(!text.includes('someone else wrote this'), 'never other people\'s posts');
  assert.ok(!text.includes('not-yours'), 'never other people\'s conversations');
  assert.equal(data.dm_messages.length, 1);
  assert.deepEqual(data.dm_messages[0].sealed, { v: 1, iv: 'iv01', ct: 'ct01' }, 'DMs exported as the sealed envelopes');
  assert.equal(data.dm_messages[0].sent_by_me, false);
  assert.equal(data.salamats_received.length, 1);
  assert.ok(!('giver_id' in data.salamats_received[0]), 'who thanked you is theirs to export');
  assert.equal(data.sessions.length, 1);
  assert.ok(!('id_hash' in data.sessions[0]));
  assert.ok(!text.includes(b.id), 'the other person appears only by their public handle');
  assert.deepEqual(data.sealed_vault.held, []);
});

test('DELETE /me: content removed, profile scrubbed, sessions ended', async () => {
  const a = await app.person({ first_name: 'Tobedeleted' }), b = await app.person();
  await app.db.query(`UPDATE users SET bio = 'a bio to scrub' WHERE id = $1`, [a.id]);
  const p = await post(a, 'goodbye post');
  await a.call('POST', `/people/${b.handle}/follow`);
  await b.call('POST', `/people/${a.handle}/follow`);
  const png = pngBytes(2, 2);
  const up = await upload(a, png, 'image/png');
  assert.equal(up.status, 201);
  const file = join(app.config.mediaDir, up.body.media.id);
  assert.ok(existsSync(file));

  assert.equal((await a.call('DELETE', '/me', { confirm: 'yes' })).status, 400);
  const del = await a.call('DELETE', '/me', { confirm: 'DELETE' });
  assert.equal(del.status, 204);
  assert.match(del.headers.get('set-cookie') || '', /Max-Age=0/);
  const u = await app.db.one<{ status: string; handle: string; first_name: string; bio: string }>('SELECT status, handle, first_name, bio FROM users WHERE id = $1', [a.id]);
  assert.equal(u!.status, 'deleted');
  assert.match(u!.handle, /^deleted\.[0-9a-f]{8}$/);
  assert.equal(u!.first_name, 'Deleted');
  assert.equal(u!.bio, '');
  assert.notEqual(await deletedAt(p), null);
  const counts = await app.db.one<{ s: number; f: number; m: number }>(
    `SELECT (SELECT count(*)::int FROM sessions WHERE user_id = $1) AS s,
            (SELECT count(*)::int FROM follows WHERE follower_id = $1 OR followee_id = $1) AS f,
            (SELECT count(*)::int FROM media WHERE owner_id = $1) AS m`, [a.id]);
  assert.deepEqual(counts, { s: 0, f: 0, m: 0 });
  assert.ok(!existsSync(file), 'the uploaded file is gone');
  assert.equal((await a.call('GET', '/me')).body.user, null, 'the old cookie no longer works');
  assert.equal((await app.call('GET', `/people/${a.handle}`)).status, 404);
});

test('/me/record-log: empty, and says why', async () => {
  const a = await app.person();
  const r = await a.call('GET', '/me/record-log');
  assert.deepEqual(r.body.openings, []);
  assert.ok(r.body.as_of);
  assert.match(r.body.note, /not built yet/);
});

test('/transparency: live counts from the tables, never invented, not launched', async () => {
  const live = async () => (await app.db.one<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM legal_requests) AS legal_requests,
            (SELECT count(*)::int FROM legal_requests WHERE outcome = 'produced') AS produced,
            (SELECT count(*)::int FROM legal_requests WHERE outcome = 'refused') AS refused,
            (SELECT count(*)::int FROM mod_actions WHERE action = 'remove' AND target_kind = 'post') AS posts_removed,
            (SELECT count(*)::int FROM reports) AS reports`))!;
  const t = await app.call('GET', '/transparency');
  assert.equal(t.status, 200);
  assert.equal(t.body.launched, false);
  assert.ok(!Number.isNaN(Date.parse(t.body.as_of)));
  assert.deepEqual(t.body.counts, await live());
  await app.db.query(`INSERT INTO legal_requests (received_at, basis, outcome) VALUES (now(), 'court_order', 'refused')`);
  const t2 = await app.call('GET', '/transparency');
  assert.equal(t2.body.counts.legal_requests, t.body.counts.legal_requests + 1);
  assert.equal(t2.body.counts.refused, t.body.counts.refused + 1);
  assert.deepEqual(t2.body.counts, await live());
});

// ---- media ----

function pngBytes(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return new Uint8Array(b);
}

function jpegBytes(w: number, h: number): Uint8Array {
  return new Uint8Array(Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]), Buffer.alloc(9),
    Buffer.from([0xff, 0xd9]),
  ]));
}

function webpBytes(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return new Uint8Array(b);
}

async function upload(p: Person, bytes: Uint8Array, type: string) {
  const r = await fetch(app.base + '/api/media', { method: 'POST', headers: { Origin: app.config.origin, Cookie: p.cookie, 'Content-Type': type }, body: bytes as unknown as BodyInit });
  return { status: r.status, body: await r.json() as any };
}

test('media: typed by magic bytes, sized from the header', async () => {
  const p = await app.person();
  const png = await upload(p, pngBytes(640, 480), 'image/png');
  assert.equal(png.status, 201);
  assert.deepEqual({ ...png.body.media, id: undefined }, { id: undefined, mime: 'image/png', bytes: 33, width: 640, height: 480 });
  const disguised = await upload(p, jpegBytes(1200, 800), 'image/png');
  assert.equal(disguised.status, 201);
  assert.equal(disguised.body.media.mime, 'image/jpeg', 'a JPEG sent as PNG is typed by its bytes');
  assert.equal(disguised.body.media.width, 1200);
  assert.equal(disguised.body.media.height, 800);
  const webp = await upload(p, webpBytes(300, 200), 'image/webp');
  assert.equal(webp.body.media.mime, 'image/webp');
  assert.equal(webp.body.media.width, 300);
  const row = await app.db.one<{ sha256: string }>('SELECT sha256 FROM media WHERE id = $1', [png.body.media.id]);
  assert.match(row!.sha256, /^[0-9a-f]{64}$/);
  const served = await fetch(`${app.base}/media/${disguised.body.media.id}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
});

test('media: random bytes, empty and too large are refused', async () => {
  const p = await app.person();
  const random = new Uint8Array(256).map((_, i) => (i * 37 + 11) & 255);
  assert.equal((await upload(p, random, 'image/png')).status, 400);
  assert.equal((await upload(p, new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml')).status, 400);
  assert.equal((await upload(p, pngBytes(0, 0), 'image/png')).status, 400, 'a zero-size image is refused');
  assert.equal((await upload(p, new Uint8Array(0), 'image/png')).status, 400);
  const big = new Uint8Array(4_000_001);
  big.set(pngBytes(10, 10));
  assert.equal((await upload(p, big, 'image/png')).status, 413);
  assert.equal((await app.call('POST', '/media', pngBytes(1, 1))).status, 401);
});

test('media: only the owner can delete', async () => {
  const owner = await app.person(), other = await app.person();
  const up = await upload(owner, pngBytes(4, 4), 'image/png');
  const id = up.body.media.id;
  assert.equal((await other.call('DELETE', `/media/${id}`)).status, 403);
  assert.equal((await owner.call('DELETE', `/media/${id}`)).status, 204);
  assert.equal((await owner.call('DELETE', `/media/${id}`)).status, 404);
  assert.equal((await fetch(`${app.base}/media/${id}`)).status, 404);
  assert.ok(!existsSync(join(app.config.mediaDir, id)));
});
