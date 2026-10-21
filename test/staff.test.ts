// Staff roles and scopes (decision 0009): the server checks scopes, never role names; roles end; there
// is always an Overseer; members never see staff tools.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_SCOPES, OVERSEER, ROLE_SCOPES, scopesOf } from '../app/http/scopes.ts';
import { grantRole, listStaff, renewRole, revokeRole } from '../app/modules/staff/members.ts';
import { inviteByEmail } from '../app/modules/accounts/routes.ts';
import { startApp, type TestApp } from './helpers.ts';

let app: TestApp;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('scopes: Overseer holds every scope; other roles only known ones; members none', () => {
  assert.deepEqual(scopesOf(OVERSEER, []), [...ALL_SCOPES]);
  assert.deepEqual(scopesOf('Support', ['people.lookup', 'staff.manage', 'made.up']), ['people.lookup'], 'Overseer-only and unknown scopes never come from a row');
  assert.deepEqual(scopesOf(null, ['reports.review']), []);
  assert.equal(new Set(ROLE_SCOPES).size, ROLE_SCOPES.length);
});

test('the seeded roles only use scopes the code knows', async () => {
  const rows = await app.db.query<{ name: string; scopes: string[] }>('SELECT name, scopes FROM staff_roles');
  assert.deepEqual(rows.map((r) => r.name).sort(), ['Developer', 'Moderator', 'Overseer', 'Support']);
  for (const r of rows) for (const s of r.scopes) assert.ok((ROLE_SCOPES as readonly string[]).includes(s), `${r.name}: ${s}`);
});

test('/me tells the person their role and scopes; members get none', async () => {
  const member = await app.person(), mod = await app.person({ staffRole: 'Moderator' }), over = await app.person({ role: 'staff' });
  const m = (await member.call('GET', '/me')).body.user;
  assert.equal(m.staff, null);
  assert.equal(m.role, 'member');
  const md = (await mod.call('GET', '/me')).body.user;
  assert.equal(md.staff.role, 'Moderator');
  assert.deepEqual(md.staff.scopes.sort(), ['accounts.suspend', 'people.lookup', 'reports.child_safety', 'reports.review']);
  assert.equal(md.role, 'staff');
  assert.equal((await over.call('GET', '/me')).body.user.staff.scopes.length, ALL_SCOPES.length);
});

test('scopes decide, not the word "staff": a Developer cannot see reports or invite; Support can invite', async () => {
  const dev = await app.person({ staffRole: 'Developer' }), support = await app.person({ staffRole: 'Support' }), mod = await app.person({ staffRole: 'Moderator' });
  assert.equal((await dev.call('GET', '/mod/reports')).status, 403);
  assert.equal((await dev.call('POST', '/accounts/invites', { email: 'x@example.com' })).status, 403);
  assert.equal((await mod.call('POST', '/accounts/invites', { email: 'x@example.com' })).status, 403);
  assert.equal((await support.call('POST', '/accounts/invites', { email: 'sent@example.com' })).status, 201);
  assert.equal((await mod.call('GET', '/mod/reports')).status, 200);
  assert.equal((await dev.call('GET', '/mod/appeals')).status, 403);
  assert.equal((await mod.call('GET', '/mod/appeals')).status, 200);
});

test('a role that has ended gives nothing', async () => {
  const gone = await app.person({ staffRole: 'Moderator', staffEnds: new Date(Date.now() - 1000) });
  assert.equal((await gone.call('GET', '/mod/reports')).status, 403);
  assert.equal((await gone.call('GET', '/me')).body.user.staff, null);
});

test('without reports.child_safety, child-safety reports stay out of view', async () => {
  await app.db.query(`INSERT INTO staff_roles (name, scopes) VALUES ('Reviewer', '{reports.review}')`);
  const reviewer = await app.person({ staffRole: 'Reviewer' }), author = await app.person(), reporter = await app.person();
  const post = await author.call('POST', '/posts', { body: 'Something to report (test fixture)' });
  const rep = await reporter.call('POST', '/reports', { target_kind: 'post', target_id: post.body.post.id, reason: 'child_safety' });
  assert.equal(rep.status, 201);
  const seen = (await reviewer.call('GET', '/mod/reports')).body.reports.map((r: any) => r.id);
  assert.ok(!seen.includes(rep.body.report.id));
  assert.equal((await reviewer.call('POST', `/mod/reports/${rep.body.report.id}/decide`, { action: 'keep' })).status, 404);
});

test('granting, renewing and revoking roles; there is always an Overseer', async () => {
  await app.db.query('DELETE FROM staff_members');
  const a = await app.person(), b = await app.person();
  assert.equal((await grantRole(app.db, { handle: a.handle, role: OVERSEER })).ends_at, null, 'Overseers have no end date');
  const g = await grantRole(app.db, { handle: '@' + b.handle, role: 'Support', days: 30 });
  assert.ok(g.ends_at && Date.parse(g.ends_at) > Date.now() + 29 * 86400_000);
  const r = await renewRole(app.db, { handle: b.handle, days: 90 });
  assert.ok(Date.parse(r.ends_at) > Date.parse(g.ends_at!) + 89 * 86400_000, 'renewing adds to the current end');
  await assert.rejects(revokeRole(app.db, a.handle), /at least one Overseer/);
  await assert.rejects(grantRole(app.db, { handle: a.handle, role: 'Support' }), /at least one Overseer/);
  await assert.rejects(grantRole(app.db, { handle: b.handle, role: 'Nope' }), /no role named/);
  await assert.rejects(grantRole(app.db, { handle: 'nobody.here', role: 'Support' }), /No one has/);
  assert.deepEqual((await listStaff(app.db)).map((s) => [s.handle, s.role]), [[a.handle, OVERSEER], [b.handle, 'Support']]);
  await grantRole(app.db, { handle: b.handle, role: OVERSEER });
  assert.equal((await revokeRole(app.db, a.handle)).role, OVERSEER, 'with a second Overseer, one can go');
});

test('a deleted or suspended Overseer does not count as the one left; deleting an account ends its role', async () => {
  await app.db.query('DELETE FROM staff_members');
  const a = await app.person(), b = await app.person({ role: 'staff' });
  await grantRole(app.db, { handle: a.handle, role: OVERSEER });
  await app.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [b.id]);
  await assert.rejects(revokeRole(app.db, a.handle), /at least one Overseer/, 'a suspended Overseer is not one who can act');
  await app.db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [b.id]);
  assert.equal((await b.call('DELETE', '/me', { confirm: 'DELETE' })).status, 204);
  assert.equal(await app.db.one('SELECT 1 FROM staff_members WHERE user_id = $1', [b.id]), null, 'the deleted account holds no role');
  await assert.rejects(revokeRole(app.db, a.handle), /at least one Overseer/);
});

test('renewing needs a whole number of days from 1 to 366', async () => {
  const s = await app.person({ staffRole: 'Support' });
  for (const days of [-100, 0, 1.5, Number.NaN, 400]) await assert.rejects(renewRole(app.db, { handle: s.handle, days }), /days: must be/, String(days));
});

test('migration 0009 made every old staff account an Overseer and dropped the flag', () => {
  const sql = readFileSync(join(import.meta.dirname, '..', 'app', 'db', 'migrations', '0009_staff_roles.sql'), 'utf8');
  assert.match(sql, /INSERT INTO staff_members \(user_id, role\) SELECT id, 'Overseer' FROM users WHERE role = 'staff' AND status <> 'deleted'/);
  assert.match(sql, /ALTER TABLE users DROP COLUMN role/);
});

test('a report can never suspend an Overseer: one person must not lock out the top role (review of #24)', async () => {
  const over = await app.person({ role: 'staff' }), mod = await app.person({ staffRole: 'Moderator' }), member = await app.person();
  const rep = await member.call('POST', '/reports', { target_kind: 'user', target_id: over.id, reason: 'harassment' });
  assert.equal(rep.status, 201);
  const d = await mod.call('POST', `/mod/reports/${rep.body.report.id}/decide`, { action: 'remove', note: 'Trying to suspend an Overseer' });
  assert.equal(d.status, 403);
  assert.equal(d.body.error.code, 'overseer');
  assert.equal((await app.db.one<{ status: string }>('SELECT status FROM users WHERE id = $1', [over.id]))!.status, 'active');
});

test('the last Overseer who can act cannot delete their account; with another one, they can (review of #24)', async () => {
  await app.db.query('DELETE FROM staff_members');
  const a = await app.person({ role: 'staff' }), b = await app.person({ role: 'staff' });
  await app.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [b.id]);
  const no = await a.call('DELETE', '/me', { confirm: 'DELETE' });
  assert.equal(no.status, 409);
  assert.equal(no.body.error.code, 'last_overseer');
  assert.equal((await app.db.one<{ status: string }>('SELECT status FROM users WHERE id = $1', [a.id]))!.status, 'active', 'nothing was deleted');
  await app.db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [b.id]);
  assert.equal((await a.call('DELETE', '/me', { confirm: 'DELETE' })).status, 204);
});

test('a suspended Overseer can be removed while another Overseer can act (review of #24)', async () => {
  await app.db.query('DELETE FROM staff_members');
  const a = await app.person({ role: 'staff' }), b = await app.person({ role: 'staff' });
  await app.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [b.id]);
  assert.equal((await revokeRole(app.db, b.handle)).role, OVERSEER);
  await assert.rejects(revokeRole(app.db, a.handle), /at least one Overseer/);
});

test('appeals of child-safety decisions stay with reports.child_safety (review of #24)', async () => {
  await app.db.query(`INSERT INTO staff_roles (name, scopes) VALUES ('Appeals', '{reports.review}') ON CONFLICT DO NOTHING`);
  const reviewer = await app.person({ staffRole: 'Appeals' }), mod = await app.person({ staffRole: 'Moderator' }), author = await app.person(), reporter = await app.person();
  const post = await author.call('POST', '/posts', { body: 'Reported for child safety (test fixture)' });
  const rep = await reporter.call('POST', '/reports', { target_kind: 'post', target_id: post.body.post.id, reason: 'child_safety' });
  assert.equal((await mod.call('POST', `/mod/reports/${rep.body.report.id}/decide`, { action: 'remove', note: 'Removed (test fixture)' })).status, 204);
  const act = (await author.call('GET', '/me/mod-actions')).body.actions[0];
  assert.equal((await author.call('POST', `/me/mod-actions/${act.id}/appeal`, { note: 'Please look again (test fixture)' })).status, 204);
  assert.ok(!(await reviewer.call('GET', '/mod/appeals')).body.appeals.some((x: any) => x.id === act.id), 'not listed');
  assert.equal((await reviewer.call('POST', `/mod/appeals/${act.id}/decide`, { decision: 'overturned', note: 'Trying anyway' })).status, 404);
  assert.ok((await mod.call('GET', '/mod/appeals')).body.appeals.some((x: any) => x.id === act.id), 'a Moderator sees it');
});

test('a member invite never renews an open staff invite; an expired one is cleared instead (review of #24)', async () => {
  const support = await app.person({ staffRole: 'Support' });
  await inviteByEmail(app.db, app.config, { email: 'held.staff@example.com', role: 'staff' });
  const m = await support.call('POST', '/accounts/invites', { email: 'Held.Staff@example.com' });
  assert.equal(m.status, 409);
  assert.equal(m.body.error.code, 'staff_invite_open');
  const before = await app.db.query<{ role: string }>(`SELECT role FROM invites WHERE role = 'staff' AND used_at IS NULL`);
  await app.db.query(`UPDATE invites SET expires_at = now() - interval '1 minute' WHERE role = 'staff' AND used_at IS NULL`);
  assert.equal((await support.call('POST', '/accounts/invites', { email: 'held.staff@example.com' })).status, 201);
  assert.equal((await app.db.query(`SELECT 1 FROM invites WHERE role = 'staff' AND used_at IS NULL`)).length, before.length - 1, 'the expired staff invite is gone');
});
