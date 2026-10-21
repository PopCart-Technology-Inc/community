// The Overseer and Admin panels' API (decision 0009, points 10-15), on the test staff host (no gate on
// this machine). Two people for the big ones, roles and scopes, switches, people, and the log. Test data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { limits, RateLimiter } from '../app/http/security.ts';
import { liftSuspensions } from '../app/modules/staff/panel.ts';
import { startApp, type Person, type TestApp } from './helpers.ts';

let app: TestApp;
before(async () => { app = await startApp(); limits.auth = new RateLimiter(1000, 60_000); limits.write = new RateLimiter(1000, 60_000); });
after(async () => { await app.close(); });

const log = async (subject?: string) => (await app.db.query<{ text: string; kind: string }>(
  `SELECT text, kind FROM staff_actions ${subject ? 'WHERE subject_handle = $1' : ''} ORDER BY at`, subject ? [subject] : [])).map((e) => e.text);

/** Two Overseers, so two-person requests can be decided. */
async function overseers(): Promise<[Person, Person]> {
  return [await app.person({ role: 'staff' }), await app.person({ role: 'staff' })];
}

test('overview: live numbers with their time, and what needs you, by scope', async () => {
  const [a] = await overseers();
  const mod = await app.person({ staffRole: 'Moderator' });
  const o = await a.staff('GET', '/staff/overview');
  assert.equal(o.status, 200);
  assert.ok(o.body.as_of);
  assert.equal(o.body.people.series.length, 8);
  assert.equal(o.body.people.series.at(-1), o.body.people.total, 'the last point is now');
  assert.equal(o.body.reports.series.length, 7);
  assert.equal(o.body.joining.invite_only, true);
  assert.deepEqual(o.body.switches, { launched: false, read_only: false });
  assert.ok(Array.isArray(o.body.latest));
  const m = await mod.staff('GET', '/staff/overview');
  assert.equal(m.body.staff, undefined, 'a Moderator sees no staff numbers');
  assert.equal(m.body.latest, undefined, 'or the log');
  assert.ok(m.body.reports, 'but sees reports');
});

test('two people: the asker cannot approve; a second Overseer approves and the change is made', async () => {
  const [a, b] = await overseers();
  const target = await app.person();
  const ask = await a.staff('POST', '/staff/members', { handle: target.handle, role: 'Overseer' });
  assert.equal(ask.status, 202, JSON.stringify(ask.body));
  const id = ask.body.approval.id;
  assert.ok(Date.parse(ask.body.approval.expires_at) > Date.now() + 71 * 3600_000);
  assert.equal((await a.staff('POST', '/staff/members', { handle: target.handle, role: 'Overseer' })).status, 409, 'one waiting request per thing');
  assert.equal((await app.db.one('SELECT 1 FROM staff_members WHERE user_id = $1', [target.id])), null, 'nothing changes yet');

  const mine = (await a.staff('GET', '/staff/approvals')).body.approvals.find((x: any) => x.id === id);
  assert.equal(mine.can_decide, false);
  assert.equal(mine.mine, true);
  assert.equal((await a.staff('POST', `/staff/approvals/${id}/approve`)).status, 403, 'not by the asker');
  const theirs = (await b.staff('GET', '/staff/approvals')).body.approvals.find((x: any) => x.id === id);
  assert.equal(theirs.can_decide, true);
  assert.equal((await b.staff('POST', `/staff/approvals/${id}/approve`)).status, 204);
  assert.equal((await app.db.one<{ role: string }>('SELECT role FROM staff_members WHERE user_id = $1', [target.id]))!.role, 'Overseer');
  assert.equal((await b.staff('POST', `/staff/approvals/${id}/approve`)).status, 409, 'once');
  const done = (await a.staff('GET', '/staff/approvals?status=done')).body.approvals.find((x: any) => x.id === id);
  assert.equal(done.status, 'approved');
  assert.equal(done.decided_by_handle, b.handle);
  const texts = await log();
  assert.ok(texts.includes(`asked: Make @${target.handle} an Overseer`));
  assert.ok(texts.includes(`approved: Make @${target.handle} an Overseer`));
});

test('two people: decline needs a reason; withdraw is the asker\'s; 72 hours and it expires', async () => {
  const [a, b] = await overseers();
  const t1 = await app.person(), t2 = await app.person(), t3 = await app.person();
  const r1 = (await a.staff('POST', '/staff/members', { handle: t1.handle, role: 'Overseer' })).body.approval.id;
  assert.equal((await b.staff('POST', `/staff/approvals/${r1}/decline`, { reason: '' })).status, 400);
  assert.equal((await b.staff('POST', `/staff/approvals/${r1}/decline`, { reason: 'Not yet: one more month as Moderator' })).status, 204);
  assert.equal(await app.db.one('SELECT 1 FROM staff_members WHERE user_id = $1', [t1.id]), null);

  const r2 = (await a.staff('POST', '/staff/members', { handle: t2.handle, role: 'Overseer' })).body.approval.id;
  assert.equal((await b.staff('POST', `/staff/approvals/${r2}/withdraw`)).status, 403);
  assert.equal((await a.staff('POST', `/staff/approvals/${r2}/withdraw`)).status, 204);
  assert.equal((await b.staff('POST', `/staff/approvals/${r2}/approve`)).status, 409);

  const r3 = (await a.staff('POST', '/staff/members', { handle: t3.handle, role: 'Overseer' })).body.approval.id;
  await app.db.query(`UPDATE staff_approvals SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r3]);
  const late = await b.staff('POST', `/staff/approvals/${r3}/approve`);
  assert.equal(late.status, 409);
  assert.match(late.body.error.message, /expired/);
  assert.equal(await app.db.one('SELECT 1 FROM staff_members WHERE user_id = $1', [t3.id]), null, 'nothing happened');
  assert.equal((await app.db.one<{ status: string }>('SELECT status FROM staff_approvals WHERE id = $1', [r3]))!.status, 'expired');
  // Asking again after it expired is fine.
  assert.equal((await a.staff('POST', '/staff/members', { handle: t3.handle, role: 'Overseer' })).status, 202);
});

test('removing an Overseer takes two people, never the one removed, and keeps at least one (review of #26)', async () => {
  await app.db.query(`DELETE FROM staff_members WHERE role = 'Overseer'`);
  await app.db.query(`DELETE FROM staff_approvals`);
  const solo = await app.person({ role: 'staff' });
  const r = await solo.staff('DELETE', `/staff/members/${solo.handle}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'last_overseer');
  // Two Overseers: the one it is about can't decide, so the panel sends it to the server's command line.
  const other = await app.person({ role: 'staff' });
  const two = await solo.staff('DELETE', `/staff/members/${other.handle}`);
  assert.equal(two.status, 409);
  assert.equal(two.body.error.code, 'no_second');
  // Asking to step down yourself is fine: the other one decides.
  const self = await solo.staff('DELETE', `/staff/members/${solo.handle}`);
  assert.equal(self.status, 202);
  assert.equal((await solo.staff('POST', `/staff/approvals/${self.body.approval.id}/withdraw`)).status, 204);
  // Three: the third decides; the one being removed can't, and their own waiting requests end with them.
  const third = await app.person({ role: 'staff' });
  const ask = await solo.staff('DELETE', `/staff/members/${other.handle}`);
  assert.equal(ask.status, 202);
  const newcomer = await app.person();
  const theirs = await other.staff('POST', '/staff/members', { handle: newcomer.handle, role: 'Overseer' });
  assert.equal(theirs.status, 202);
  const veto = await other.staff('POST', `/staff/approvals/${ask.body.approval.id}/decline`, { reason: 'Not me, please' });
  assert.equal(veto.status, 403);
  assert.equal(veto.body.error.code, 'about_you');
  assert.ok(!(await other.staff('GET', '/staff/approvals')).body.approvals.find((a: any) => a.id === ask.body.approval.id).can_decide);
  assert.equal((await third.staff('POST', `/staff/approvals/${ask.body.approval.id}/approve`)).status, 204);
  assert.equal(await app.db.one('SELECT 1 FROM staff_members WHERE user_id = $1', [other.id]), null);
  assert.equal((await other.staff('GET', '/staff/overview')).status, 401, 'their staff session ended');
  assert.equal((await app.db.one<{ status: string }>('SELECT status FROM staff_approvals WHERE id = $1', [theirs.body.approval.id]))!.status, 'withdrawn', 'their own request ended with them');
});

test('a request whose asker can no longer act is not decided (review of #26)', async () => {
  const [a, b] = await overseers();
  const target = await app.person();
  const ask = await a.staff('POST', '/staff/members', { handle: target.handle, role: 'Overseer' });
  assert.equal(ask.status, 202);
  await app.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [a.id]);
  const d = await b.staff('POST', `/staff/approvals/${ask.body.approval.id}/approve`);
  assert.equal(d.status, 409);
  assert.equal(d.body.error.code, 'asker_gone');
  await app.db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [a.id]);
});

test('staff: give, change, renew and take a role; logged with the person', async () => {
  const [a] = await overseers();
  const p = await app.person();
  const g = await a.staff('POST', '/staff/members', { handle: '@' + p.handle, role: 'Moderator', days: 30 });
  assert.equal(g.status, 201);
  assert.ok(Date.parse(g.body.ends_at) > Date.now() + 29 * 86400_000);
  assert.equal((await a.staff('POST', '/staff/members', { handle: p.handle, role: 'Nope' })).status, 400);
  assert.equal((await a.staff('POST', '/staff/members', { handle: p.handle, role: 'Support', days: 0 })).status, 400);
  assert.equal((await a.staff('POST', '/staff/members', { handle: p.handle, role: 'Support', days: 60 })).status, 201);
  assert.equal((await a.staff('POST', `/staff/members/${p.handle}/renew`, { days: 30 })).status, 200);
  const list = await a.staff('GET', '/staff/members');
  const row = list.body.staff.find((s: any) => s.handle === p.handle);
  assert.equal(row.role, 'Support');
  assert.ok(list.body.roles.includes('Developer'));
  assert.equal((await a.staff('DELETE', `/staff/members/${p.handle}`)).status, 204);
  assert.deepEqual(await log(p.handle), ['gave the Moderator role for 30 days', 'changed the role from Moderator to Support for 60 days', 'renewed the role for 30 days', 'took away the Support role']);
  const mod = await app.person({ staffRole: 'Moderator' });
  assert.equal((await mod.staff('GET', '/staff/members')).status, 403, 'staff.manage is Overseer only');
});

test('staff invites: a role and its days, never Overseer; listed without the address; cancel', async () => {
  const [a] = await overseers();
  assert.equal((await a.staff('POST', '/staff/invites', { email: 'new.mod@example.com', role: 'Overseer' })).status, 400);
  const r = await a.staff('POST', '/staff/invites', { email: 'New.Mod@example.com', role: 'Moderator', days: 45 });
  assert.equal(r.status, 201);
  const row = await app.db.one<{ staff_role: string; staff_days: number; role: string }>(`SELECT role, staff_role, staff_days FROM invites WHERE staff_role = 'Moderator'`);
  assert.deepEqual({ ...row }, { role: 'staff', staff_role: 'Moderator', staff_days: 45 });
  const list = await a.staff('GET', '/staff/members');
  const inv = list.body.invites.find((i: any) => i.role === 'Moderator');
  assert.ok(inv);
  assert.equal(inv.days, 45);
  assert.doesNotMatch(JSON.stringify(list.body), /new\.mod/i, 'the address is never shown');
  assert.ok((await log()).includes('invited an address ending in @example.com as Moderator for 45 days'));
  assert.equal((await a.staff('DELETE', `/staff/roles/Moderator`)).status, 409, 'a role an invite gives cannot be deleted');
  assert.equal((await a.staff('DELETE', `/staff/invites/${inv.id}`)).status, 204);
  assert.equal((await a.staff('DELETE', `/staff/invites/${inv.id}`)).status, 404);
});

test('roles: make, edit, delete; only role scopes; the Overseer role is locked', async () => {
  const [a] = await overseers();
  const g = await a.staff('GET', '/staff/roles');
  assert.equal(g.body.roles[0].name, 'Overseer');
  assert.equal(g.body.roles[0].locked, true);
  assert.equal(g.body.groups.length, 3);
  assert.equal((await a.staff('POST', '/staff/roles', { name: 'lowercase', scopes: [] })).status, 400);
  assert.equal((await a.staff('POST', '/staff/roles', { name: 'Auditor', scopes: ['audit.read'] })).status, 400, 'Overseer-only scopes are never given to a role');
  assert.equal((await a.staff('POST', '/staff/roles', { name: 'Auditor', scopes: ['made.up'] })).status, 400);
  assert.equal((await a.staff('POST', '/staff/roles', { name: 'Trust Team', scopes: ['reports.review', 'people.lookup'] })).status, 201);
  assert.equal((await a.staff('POST', '/staff/roles', { name: 'trust team', scopes: [] })).status, 400);
  assert.equal((await a.staff('POST', '/staff/roles', { name: 'Overseer', scopes: [] })).status, 409);
  assert.equal((await a.staff('PUT', '/staff/roles/Trust%20Team', { scopes: ['reports.review', 'accounts.suspend'] })).status, 200);
  assert.equal((await a.staff('PUT', '/staff/roles/Overseer', { scopes: [] })).status, 403);
  assert.ok((await log()).includes('changed the role Trust Team: +accounts.suspend -people.lookup'));
  const holder = await app.person({ staffRole: 'Trust Team' });
  assert.equal((await a.staff('DELETE', '/staff/roles/Trust%20Team')).status, 409, 'held');
  await app.db.query('DELETE FROM staff_members WHERE user_id = $1', [holder.id]);
  assert.equal((await a.staff('DELETE', '/staff/roles/Trust%20Team')).status, 204);
  assert.equal((await a.staff('DELETE', '/staff/roles/Overseer')).status, 403);
});

test('switches: read-only mode at once; launching takes two people; joining stays invite-only', async () => {
  const [a, b] = await overseers();
  const member = await app.person();
  const sw = await a.staff('GET', '/staff/switches');
  assert.equal(sw.body.invite_only.locked, true);
  assert.equal((await a.staff('POST', '/staff/switches/read_only', { on: true })).status, 400, 'a note says why');
  assert.equal((await a.staff('POST', '/staff/switches/read_only', { on: true, note: 'database move' })).status, 204);
  const w = await member.call('POST', '/posts', { body: 'blocked while read-only (test fixture)' });
  assert.equal(w.status, 503);
  assert.equal(w.body.error.code, 'read_only');
  assert.equal((await member.call('GET', '/me')).status, 200, 'reading works');
  assert.notEqual((await member.call('POST', '/reports', { target_kind: 'user', target_id: a.id, reason: 'other' })).status, 503, 'reporting works');
  assert.equal((await a.staff('POST', '/staff/switches/read_only', { on: false, note: 'done' })).status, 204);
  assert.equal((await member.call('POST', '/posts', { body: 'works again (test fixture)' })).status, 201);

  const ask = await a.staff('POST', '/staff/switches/launched', { on: true, note: 'privacy review passed' });
  assert.equal(ask.status, 202);
  assert.equal((await app.call('GET', '/transparency')).body.launched, false);
  assert.ok((await a.staff('GET', '/staff/switches')).body.waiting.includes('switch:launched'));
  assert.equal((await b.staff('POST', `/staff/approvals/${ask.body.approval.id}/approve`)).status, 204);
  assert.equal((await app.call('GET', '/transparency')).body.launched, true);
  await app.db.query(`UPDATE platform_switches SET is_on = false WHERE key = 'launched'`);
  const dev = await app.person({ staffRole: 'Developer' });
  assert.equal((await dev.staff('POST', '/staff/switches/read_only', { on: true, note: 'nope' })).status, 403);
});

test('feature switches: staging by a Developer; production on takes two Overseers, off takes one', async () => {
  const [a, b] = await overseers();
  const dev = await app.person({ staffRole: 'Developer' });
  assert.equal((await dev.staff('POST', '/staff/features', { id: 'Bad Id', name: 'x' })).status, 400);
  assert.equal((await dev.staff('POST', '/staff/features', { id: 'places.world', name: 'Places: World' })).status, 201);
  assert.equal((await dev.staff('POST', '/staff/features', { id: 'places.world', name: 'again' })).status, 409);
  assert.equal((await a.staff('POST', '/staff/features/places.world/production', { on: true })).status, 409, 'staging first');
  assert.equal((await dev.staff('POST', '/staff/features/places.world/staging', { on: true })).status, 204);
  assert.equal((await dev.staff('POST', '/staff/features/places.world/production', { on: true })).status, 403, 'production is Overseer only');
  const ask = await a.staff('POST', '/staff/features/places.world/production', { on: true });
  assert.equal(ask.status, 202);
  assert.equal((await b.staff('POST', `/staff/approvals/${ask.body.approval.id}/approve`)).status, 204);
  assert.equal((await app.db.one<{ production: boolean }>(`SELECT production FROM feature_switches WHERE id = 'places.world'`))!.production, true);
  assert.equal((await dev.staff('DELETE', '/staff/features/places.world')).status, 409, 'off in production first');
  assert.equal((await a.staff('POST', '/staff/features/places.world/production', { on: false })).status, 204, 'one Overseer can switch off');
  assert.equal((await dev.staff('DELETE', '/staff/features/places.world')).status, 204);
});

test('vault: honestly empty until the vault is built', async () => {
  const [a] = await overseers();
  const v = await a.staff('GET', '/staff/vault');
  assert.deepEqual(v.body.requests, []);
  assert.equal(v.body.built, false);
  assert.equal((await (await app.person({ staffRole: 'Support' })).staff('GET', '/staff/vault')).status, 403);
});

test('people: look up, suspend for up to 7 days (lifted on its own), lift early; the person sees it', async () => {
  const mod = await app.person({ staffRole: 'Moderator' }), support = await app.person({ staffRole: 'Support' });
  const p = await app.person({ handle: 'lookup.example' });
  const s = await support.staff('GET', '/staff/people?q=lookup.ex');
  assert.deepEqual(s.body.people.map((x: any) => x.handle), ['lookup.example']);
  assert.deepEqual((await support.staff('GET', '/staff/people?q=l00kupexample')).body.people.map((x: any) => x.handle), ['lookup.example'], 'look-alikes find the name');
  const d = await support.staff('GET', '/staff/people/lookup.example');
  assert.equal(d.body.person.status, 'active');
  assert.equal((await support.staff('POST', '/staff/people/lookup.example/suspend', { days: 7, reason: 'spam' })).status, 403, 'Support cannot suspend');
  assert.equal((await mod.staff('POST', '/staff/people/lookup.example/suspend', { days: 8, reason: 'spam' })).status, 400);
  assert.equal((await mod.staff('POST', '/staff/people/lookup.example/suspend', { days: 7, reason: 'Spam links in every Space' })).status, 204);
  assert.equal((await p.call('GET', '/me')).body.user, null, 'signed out');
  const act = (await app.db.one<{ action: string }>(`SELECT action FROM mod_actions WHERE subject_id = $1`, [p.id]))!;
  assert.equal(act.action, 'suspend', 'appealable like any suspension');
  assert.equal((await mod.staff('POST', '/staff/people/lookup.example/suspend', { days: 1, reason: 'again' })).status, 409);
  // The end date passes: the next read lifts it.
  await app.db.query(`UPDATE users SET suspended_until = now() - interval '1 second' WHERE id = $1`, [p.id]);
  assert.equal((await support.staff('GET', '/staff/people/lookup.example')).body.person.status, 'active');
  await mod.staff('POST', '/staff/people/lookup.example/suspend', { days: 3, reason: 'Spam again' });
  assert.equal((await mod.staff('POST', '/staff/people/lookup.example/unsuspend', { reason: 'Reviewed: a mistake' })).status, 204);
  // What staff did shows in the person's own record log, without naming staff.
  const rows = await app.db.query<{ text: string }>('SELECT text FROM staff_actions WHERE subject_id = $1 ORDER BY at', [p.id]);
  assert.ok(rows.some((r) => r.text === 'looked at the account'));
  assert.ok(rows.some((r) => r.text === 'suspended the account for 7 days: Spam links in every Space'));
  const mine = await (await signIn(p)).call('GET', '/me/record-log');
  assert.ok(mine.body.staff.some((e: any) => e.text === 'lifted the suspension: Reviewed: a mistake'));
  assert.doesNotMatch(JSON.stringify(mine.body.staff), new RegExp(mod.handle), 'staff are not named');
  const over = await app.person({ role: 'staff' });
  assert.equal((await mod.staff('POST', `/staff/people/${over.handle}/suspend`, { days: 1, reason: 'test' })).status, 403, 'Overseers are not suspended');
});

/** A fresh member session for someone (suspension ended their sessions). */
async function signIn(p: Person): Promise<Person> {
  const again = await app.person();
  await app.db.query('UPDATE sessions SET user_id = $1 WHERE user_id = $2', [p.id, again.id]);
  return { ...p, call: again.call };
}

test('audit CSV: every entry, formulas defused, and the export is logged', async () => {
  const [a] = await overseers();
  await app.db.query(`INSERT INTO staff_actions (actor_handle, kind, text) VALUES ('system', 'audit', '=HYPERLINK("x")')`);
  const r = await a.staff('GET', '/staff/audit.csv');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /text\/csv/);
  assert.match(String(r.headers['content-disposition']), /attachment; filename="staff-audit-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.match(String(r.body), /^at,who,kind,text,subject\r\n/);
  assert.match(String(r.body), /"'=HYPERLINK\(""x""\)"/);
  assert.ok((await log()).some((t) => /^exported \d+ audit entries as CSV$/.test(t)));
});

test('health: version, database and migrations, for ops.health only', async () => {
  const dev = await app.person({ staffRole: 'Developer' }), mod = await app.person({ staffRole: 'Moderator' });
  const h = await dev.staff('GET', '/staff/health');
  assert.equal(h.status, 200);
  assert.match(h.body.version, /^\d+\.\d+\.\d+$/);
  assert.equal(h.body.db.ok, true);
  assert.match(h.body.migrations.last, /^\d{4}_/);
  assert.equal((await mod.staff('GET', '/staff/health')).status, 403);
});

test('a report can never suspend an Overseer, so one person cannot lock out the panel (review of #26)', async () => {
  const over = await app.person({ role: 'staff' }), mod = await app.person({ staffRole: 'Moderator' }), member = await app.person();
  const rep = await member.call('POST', '/reports', { target_kind: 'user', target_id: over.id, reason: 'harassment' });
  assert.equal(rep.status, 201);
  const d = await mod.staff('POST', `/staff/reports/${rep.body.report.id}/decide`, { action: 'remove', note: 'Trying to suspend an Overseer' });
  assert.equal(d.status, 403);
  assert.equal(d.body.error.code, 'overseer');
  assert.equal((await app.db.one<{ status: string }>('SELECT status FROM users WHERE id = $1', [over.id]))!.status, 'active');
  assert.equal((await over.staff('GET', '/staff/overview')).status, 200, 'the Overseer still has the panel');
});

test('a suspension from a report has no end date and replaces a timed one; lifting on appeal clears the date (review of #26)', async () => {
  const mod = await app.person({ staffRole: 'Moderator' }), other = await app.person({ staffRole: 'Moderator' }), p = await app.person(), member = await app.person();
  const rep = await member.call('POST', '/reports', { target_kind: 'user', target_id: p.id, reason: 'scam' });
  assert.equal(rep.status, 201);
  assert.equal((await mod.staff('POST', `/staff/people/${p.handle}/suspend`, { days: 2, reason: 'Scam posts, first time' })).status, 204);
  assert.equal((await mod.staff('POST', `/staff/reports/${rep.body.report.id}/decide`, { action: 'remove', note: 'Scam posts again' })).status, 204);
  const row = async () => (await app.db.one<{ status: string; suspended_until: string | null }>('SELECT status, suspended_until FROM users WHERE id = $1', [p.id]))!;
  assert.deepEqual(await row(), { status: 'suspended', suspended_until: null }, 'indefinite now');
  await liftSuspensions(app.db);
  assert.equal((await other.staff('GET', `/staff/people/${p.handle}`)).body.person.status, 'suspended', 'the lift job leaves it alone');
  // Overturned on appeal: active again, with no end date left behind for the lift job to act on later.
  const act = await app.db.one<{ id: string }>(`SELECT id FROM mod_actions WHERE subject_id = $1 AND action = 'suspend' AND report_id IS NOT NULL`, [p.id]);
  await app.db.query(`UPDATE mod_actions SET appealed_at = now(), appeal_note = 'It was not me (test fixture)' WHERE id = $1`, [act!.id]);
  assert.equal((await other.staff('POST', `/staff/appeals/${act!.id}/decide`, { decision: 'overturned', note: 'Reviewed again' })).status, 204);
  assert.deepEqual(await row(), { status: 'active', suspended_until: null });
});

// Two asks at the same moment are settled by the database (ON CONFLICT on the one-waiting index); the test
// database runs one transaction at a time, so this checks the answer, not the race.
test('asking again while a request waits is refused with 409, not an error (review of #26)', async () => {
  const [a] = await overseers(), target = await app.person();
  const both = await Promise.all([1, 2].map(() => a.staff('POST', '/staff/members', { handle: target.handle, role: 'Overseer' })));
  assert.deepEqual(both.map((r) => r.status).sort(), [202, 409]);
  assert.equal(both.find((r) => r.status === 409)!.body.error.code, 'already_asked');
});

test('a member invite never changes an open staff invite for the same address (review of #26)', async () => {
  const over = await app.person({ role: 'staff' }), support = await app.person({ staffRole: 'Support' });
  assert.equal((await over.staff('POST', '/staff/invites', { email: 'held.invite@example.com', role: 'Support', days: 30 })).status, 201);
  const m = await support.staff('POST', '/staff/member-invites', { email: 'Held.Invite@example.com' });
  assert.equal(m.status, 409);
  assert.equal(m.body.error.code, 'staff_invite_open');
  const rows = await app.db.query<{ role: string; staff_role: string }>(`SELECT role, staff_role FROM invites WHERE staff_role = 'Support' AND used_at IS NULL`);
  assert.deepEqual(rows.map((r) => [r.role, r.staff_role]), [['staff', 'Support']], 'the staff invite is untouched');
});
