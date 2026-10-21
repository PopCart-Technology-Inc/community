import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { manilaWeek } from '../app/modules/shared.ts';
import { inviteByEmail, TERMS_VERSION } from '../app/modules/accounts/routes.ts';
import { devOutbox } from '../app/mail/send.ts';
import { limits, RateLimiter } from '../app/http/security.ts';
import { startApp, type TestApp } from './helpers.ts';

let app: TestApp;
// Every test call comes from 127.0.0.1, so the per-address sign-in limit would trip: widen it here.
before(async () => { app = await startApp(); limits.auth = new RateLimiter(1000, 60_000); });
after(async () => { await app.close(); });

test('health, security headers, JSON errors', async () => {
  const r = await app.call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const nf = await app.call('GET', '/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, 'not_found');
});

test('web shell: nonce-only CSP, nonce on every script and style', async () => {
  const r = await fetch(app.base + '/places');
  const html = await r.text();
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /^default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
  assert.equal((html.match(/<script\b/g) || []).length, (html.match(new RegExp(`<script[^>]*nonce="${nonce.replace(/[+/=]/g, '\\$&')}"`, 'g')) || []).length);
  assert.doesNotMatch(html, /\son[a-z]+=|\sstyle="/i, 'no inline handlers or style attributes');
});

test('CSRF: a write from another origin is refused', async () => {
  const r = await fetch(app.base + '/api/accounts/login/options', { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  const none = await fetch(app.base + '/api/accounts/login/options', { method: 'POST' });
  assert.equal(none.status, 403, 'no Origin header: refused');
});

/** The last test email sent to an address (the dev outbox: no email service in tests). */
const lastMail = (to: string) => [...devOutbox].reverse().find((m) => m.to === to);
const codeIn = (to: string) => /\b(\d{6})\b/.exec(lastMail(to)?.subject || '')?.[1] || '';

/** Invite an address, ask for a code, check it: the join ticket. */
async function ticketFor(email: string): Promise<string> {
  await inviteByEmail(app.db, app.config, { email, days: 1 });
  assert.equal((await app.call('POST', '/accounts/join/start', { email })).status, 202);
  const v = await app.call('POST', '/accounts/join/verify', { email, code: codeIn(email) });
  assert.equal(v.status, 200);
  return v.body.ticket;
}

test('invites go to an email address: only staff send them, from the staff host, and no code or link comes back', async () => {
  const member = await app.person();
  assert.equal((await member.call('POST', '/accounts/invites', { email: 'a@example.com' })).status, 404, 'no invite API on the public host');
  const staff = await app.person({ role: 'staff' });
  assert.equal((await staff.call('POST', '/accounts/invites', { email: 'a@example.com' })).status, 404, 'not for staff either: invites are sent from the staff host');
  assert.equal((await staff.staff('POST', '/staff/member-invites', { email: 'not an email' })).status, 400);
  const made = await staff.staff('POST', '/staff/member-invites', { email: ' Invited.Person@Example.com ', note: 'tester' });
  assert.equal(made.status, 201);
  assert.deepEqual(Object.keys(made.body).sort(), ['expires_at', 'expires_in_days', 'sent']);
  const mail = lastMail('invited.person@example.com')!;
  assert.match(mail.subject, /invited/);
  assert.match(mail.text, /: http:\/\/localhost:8080\/join$/m);
  assert.doesNotMatch(mail.html + mail.text, /join\?/, 'the link carries no code');
  // the address itself is not stored anywhere
  const rows = await app.db.query<Record<string, unknown>>('SELECT * FROM invites');
  assert.doesNotMatch(JSON.stringify(rows), /invited\.person/i);
  // inviting again renews the same invite rather than adding one
  const n = (await app.db.query('SELECT 1 FROM invites WHERE email_hash IS NOT NULL')).length;
  await staff.staff('POST', '/staff/member-invites', { email: 'invited.person@example.com' });
  assert.equal((await app.db.query('SELECT 1 FROM invites WHERE email_hash IS NOT NULL')).length, n);
});

test('join code: sent only to an invited address, same reply either way; wrong tries run out; one use', async () => {
  const before = devOutbox.length;
  const stranger = await app.call('POST', '/accounts/join/start', { email: 'nobody@example.com' });
  assert.equal(stranger.status, 202);
  assert.equal(devOutbox.length, before, 'no email to an address without an invite');
  await inviteByEmail(app.db, app.config, { email: 'coder@example.com', days: 1 });
  const invited = await app.call('POST', '/accounts/join/start', { email: 'coder@example.com' });
  assert.deepEqual(invited.body, stranger.body);
  const code = codeIn('coder@example.com');
  assert.match(code, /^\d{6}$/);
  assert.match(lastMail('coder@example.com')!.html, new RegExp(`>${code}<`));
  // asking again at once sends nothing new (30 s between codes)
  const sent = devOutbox.length;
  await app.call('POST', '/accounts/join/start', { email: 'coder@example.com' });
  assert.equal(devOutbox.length, sent);
  const wrong = code === '000000' ? '111111' : '000000';
  const w = await app.call('POST', '/accounts/join/verify', { email: 'coder@example.com', code: wrong });
  assert.equal(w.body.error.code, 'code_invalid');
  assert.match(w.body.error.message, /4 tries left/);
  assert.equal((await app.call('POST', '/accounts/join/verify', { email: 'nobody@example.com', code })).body.error.code, 'code_expired');
  const ok = await app.call('POST', '/accounts/join/verify', { email: 'Coder@Example.com', code });
  assert.equal(ok.status, 200);
  assert.match(ok.body.ticket, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await app.call('POST', '/accounts/join/verify', { email: 'coder@example.com', code })).body.error.code, 'code_expired', 'a code works once');
  // five wrong tries end the code, even for the right one after
  await inviteByEmail(app.db, app.config, { email: 'tries@example.com', days: 1 });
  await app.call('POST', '/accounts/join/start', { email: 'tries@example.com' });
  const real = codeIn('tries@example.com');
  const bad = real === '000000' ? '111111' : '000000';
  for (let k = 0; k < 5; k++) await app.call('POST', '/accounts/join/verify', { email: 'tries@example.com', code: bad });
  assert.equal((await app.call('POST', '/accounts/join/verify', { email: 'tries@example.com', code: real })).body.error.code, 'code_expired');
});

test('joining needs the unticked box ticked, 18+, the current terms, a free username', async () => {
  const ticket = await ticketFor('ana@example.com');
  assert.equal((await app.call('POST', '/accounts/register/options', { ticket: 'made-up-ticket-0000000000' })).body.error.code, 'invite_invalid');
  const good = { ticket, handle: 'new.person', first_name: 'Ana', trade: 'creator', agree: true, adult: true, terms_version: TERMS_VERSION };
  assert.equal((await app.call('POST', '/accounts/register/options', { ...good, agree: false })).body.error.code, 'agree');
  assert.equal((await app.call('POST', '/accounts/register/options', { ...good, adult: false })).body.error.code, 'adult');
  assert.equal((await app.call('POST', '/accounts/register/options', { ...good, terms_version: '2020-01-01' })).status, 409);
  await app.person({ handle: 'taken.name' });
  assert.equal((await app.call('POST', '/accounts/register/options', { ...good, handle: 'taken.name' })).body.error.code, 'handle_taken');
  assert.equal((await app.call('POST', '/accounts/register/options', { ...good, handle: 'Bad Name!' })).status, 400);
  const ok = await app.call('POST', '/accounts/register/options', good);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.options.rp.id, 'localhost');
  assert.equal(ok.body.options.authenticatorSelection.residentKey, 'required');
  // a made-up passkey response is refused, and the challenge cannot be reused
  const v = await app.call('POST', '/accounts/register/verify', { challengeId: ok.body.challengeId, response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } });
  assert.equal(v.status, 400);
  assert.equal((await app.call('POST', '/accounts/register/verify', { challengeId: ok.body.challengeId, response: {} })).body.error.code, 'challenge');
});

test('/me: settings change, improvement switches start off, a private key is never accepted', async () => {
  const p = await app.person();
  const me = await p.call('GET', '/me');
  assert.equal(me.body.user.improve_usage, false);
  assert.equal(me.body.user.improve_surveys, false);
  const up = await p.call('PATCH', '/me', { bio: 'Rider sa Pasig', improve_usage: true });
  assert.equal(up.body.user.bio, 'Rider sa Pasig');
  assert.equal(up.body.user.improve_usage, true);
  const withPrivate = await p.call('PATCH', '/me', { dm_public_key: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'secret' } });
  assert.equal(withPrivate.status, 400);
  assert.equal((await app.call('GET', '/me')).body.user, null);
});

test('people: profile with live counts, follow and unfollow', async () => {
  const a = await app.person(), b = await app.person();
  assert.equal((await a.call('POST', `/people/${b.handle}/follow`)).status, 204);
  const prof = await a.call('GET', `/people/${b.handle}`);
  assert.equal(prof.body.person.followers, 1);
  assert.equal(prof.body.person.is_following, true);
  assert.ok(prof.body.person.as_of);
  assert.equal((await a.call('POST', `/people/${a.handle}/follow`)).status, 400);
  await a.call('DELETE', `/people/${b.handle}/follow`);
  assert.equal((await a.call('GET', `/people/${b.handle}`)).body.person.followers, 0);
});

test('salamat week resets on Monday in Manila', () => {
  assert.equal(manilaWeek(new Date('2026-10-18T15:59:00Z')), '2026-W42'); // Sun 23:59 PHT
  assert.equal(manilaWeek(new Date('2026-10-18T16:00:00Z')), '2026-W43'); // Mon 00:00 PHT
  assert.equal(manilaWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
});
