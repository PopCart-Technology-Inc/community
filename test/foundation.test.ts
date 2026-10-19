import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { manilaWeek } from '../app/modules/shared.ts';
import { createInvite, TERMS_VERSION } from '../app/modules/accounts/routes.ts';
import { startApp, type TestApp } from './helpers.ts';

let app: TestApp;
before(async () => { app = await startApp(); });
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

test('invites: only staff create them; a used or wrong code is refused', async () => {
  const member = await app.person();
  assert.equal((await member.call('POST', '/accounts/invites', {})).status, 403);
  const staff = await app.person({ role: 'staff' });
  const made = await staff.call('POST', '/accounts/invites', { note: 'tester' });
  assert.equal(made.status, 201);
  assert.match(made.body.url, /\/join\?code=[A-Z0-9]{12}$/);
  assert.equal((await app.call('POST', '/accounts/invite/check', { code: made.body.code })).status, 200);
  assert.equal((await app.call('POST', '/accounts/invite/check', { code: 'WRONGCODE123' })).status, 404);
});

test('joining needs the unticked box ticked, 18+, the current terms, a free username', async () => {
  const code = await createInvite(app.db, { days: 1 });
  const good = { code, handle: 'new.person', first_name: 'Ana', trade: 'creator', agree: true, adult: true, terms_version: TERMS_VERSION };
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
