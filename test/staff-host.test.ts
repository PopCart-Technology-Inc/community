// The staff host (decision 0009, points 7-12): only reachable through the gate, its own passkeys and
// sessions, the idle lock, and the append-only audit log. A software passkey and a locally signed Access
// token stand in for the browser and Cloudflare; everything else is the real server. Test-only data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { request } from 'node:http';
import { loadConfig, staffConfigProblem } from '../app/config.ts';
import { AccessVerifier } from '../app/http/access.ts';
import { limits, RateLimiter } from '../app/http/security.ts';
import { emailHash } from '../app/modules/accounts/routes.ts';
import { grantRole, revokeRole } from '../app/modules/staff/members.ts';
import { startApp, type Person, type TestApp } from './helpers.ts';

const TEAM = 'https://test-team.cloudflareaccess.com';
const AUD = 'test-audience';
const STAFF = 'http://staff.localhost:8081';
const RP = 'staff.localhost';

/* ---------- a stand-in for Cloudflare Access ---------- */

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid';
let certFetches = 0;
const access = new AccessVerifier(TEAM, AUD, async (url) => {
  certFetches++;
  assert.equal(url, TEAM + '/cdn-cgi/access/certs');
  return { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: KID }] };
});
const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function token(email: string, over: Record<string, unknown> = {}, key: KeyObject = rsa.privateKey, kid = KID): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64({ iss: TEAM, aud: [AUD], email, sub: 'sub-' + email, iat: now, nbf: now, exp: now + 600, ...over })}`;
  return body + '.' + createSign('sha256').update(body).sign(key).toString('base64url');
}

/* ---------- a software passkey (ES256, "none" attestation) ---------- */

function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => (n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24, n]) : Buffer.from([major << 5 | 25, n >> 8, n & 255]));
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

class SoftPasskey {
  readonly id = randomBytes(16);
  private key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private origin: string;
  private rpId: string;
  constructor(origin: string, rpId: string) { this.origin = origin; this.rpId = rpId; }
  private client(type: string, challenge: string) { return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false })); }
  create(options: { challenge: string }) {
    const jwk = this.key.publicKey.export({ format: 'jwk' });
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
    const len = Buffer.from([this.id.length >> 8, this.id.length & 255]);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.id, cose]);
    const att = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const id = this.id.toString('base64url');
    return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: this.client('webauthn.create', options.challenge).toString('base64url'), attestationObject: att.toString('base64url'), transports: ['internal'] } };
  }
  get(options: { challenge: string }) {
    const cd = this.client('webauthn.get', options.challenge);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
    const signature = sign('sha256', Buffer.concat([authData, sha(cd)]), this.key.privateKey);
    const id = this.id.toString('base64url');
    return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: cd.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') } };
  }
}

/* ---------- requests to the staff host (fetch can't set Host, so node:http) ---------- */

let app: TestApp;
interface Res { status: number; body: any; cookie: string | null; headers: Record<string, string | string[] | undefined> }
function staff(method: string, path: string, opts: { body?: unknown; cookie?: string; who?: string | null; tok?: string; origin?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { Host: new URL(STAFF).host, Origin: opts.origin ?? STAFF };
  const tok = opts.tok ?? (opts.who ? token(opts.who) : undefined);
  if (tok) headers['Cf-Access-Jwt-Assertion'] = tok;
  if (opts.cookie) headers.Cookie = opts.cookie;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload) headers['Content-Type'] = 'application/json';
  return new Promise((ok, bad) => {
    const r = request({ host: '127.0.0.1', port: app.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try { body = text ? JSON.parse(text) : null; } catch { /* a page */ }
        const set = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('__Host-staff='));
        ok({ status: res.statusCode || 0, body, cookie: set ? set.split(';')[0]! : null, headers: res.headers });
      });
    });
    r.on('error', bad);
    r.end(payload);
  });
}

const list = async (p: Person, email: string) => app.db.query('UPDATE staff_members SET email_hash = $1 WHERE user_id = $2', [emailHash(app.config, email), p.id]);

/** Set up a staff passkey for `p` through the public site's code and the staff host. Returns the session cookie. */
async function enroll(p: Person, email: string, key = new SoftPasskey(STAFF, RP)): Promise<{ cookie: string; key: SoftPasskey }> {
  const c = await p.call('POST', '/me/staff-code');
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const o = await staff('POST', '/api/staff/enroll/options', { who: email, body: { code: c.body.code.toLowerCase().replace(/(.{4})/, '$1-') } });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.options.rp.id, RP);
  assert.equal(o.body.options.authenticatorSelection.userVerification, 'required');
  const v = await staff('POST', '/api/staff/enroll/verify', { who: email, body: { challengeId: o.body.challengeId, response: key.create(o.body.options), code: c.body.code } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.ok(v.cookie, 'a staff session cookie');
  return { cookie: v.cookie!, key };
}

before(async () => {
  app = await startApp({ env: { STAFF_ORIGIN: STAFF, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, deps: { access } });
  limits.auth = new RateLimiter(1000, 60_000);
});
after(async () => { await app.close(); });

test('config: a public staff host needs https, its own host and the gate; this machine may run without it', () => {
  const c = (env: Record<string, string>) => staffConfigProblem(loadConfig({ COMMUNITY_ORIGIN: 'https://community.example', ...env }));
  assert.equal(c({}), null, 'no staff host: nothing to check');
  assert.equal(c({ STAFF_ORIGIN: 'http://localhost:8081' }), null, 'this machine, gate off');
  assert.match(c({ STAFF_ORIGIN: 'https://community.example' })!, /different host/);
  assert.match(c({ STAFF_ORIGIN: 'https://staff.example/panel' })!, /origin only/);
  assert.match(c({ STAFF_ORIGIN: 'http://staff.example', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD })!, /https/);
  assert.match(c({ STAFF_ORIGIN: 'https://staff.example' })!, /ACCESS_TEAM_DOMAIN/);
  assert.equal(c({ STAFF_ORIGIN: 'https://staff.example', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }), null);
  const gate = { STAFF_ORIGIN: 'https://staff.example', ACCESS_AUD: AUD };
  assert.match(c({ ...gate, ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com' })!, /ACCESS_TEAM_DOMAIN/, 'no scheme');
  assert.match(c({ ...gate, ACCESS_TEAM_DOMAIN: 'http://test-team.cloudflareaccess.com' })!, /https origin/);
  assert.match(c({ ...gate, ACCESS_TEAM_DOMAIN: TEAM, STAFF_RP_ID: 'other.example' })!, /STAFF_RP_ID/, 'a domain the staff host is not under');
  assert.match(c({ ...gate, ACCESS_TEAM_DOMAIN: TEAM, STAFF_RP_ID: 'example' })!, /COMMUNITY_ORIGIN/, 'a domain that covers the public site too');
});

test('the gate token: only a fresh token signed by the team, for this app, with an address', async () => {
  const v = (t: string | undefined) => access.verify(t);
  assert.deepEqual(await v(token('Staff@Example.com')), { email: 'staff@example.com', sub: 'sub-Staff@Example.com' });
  assert.equal(await v(undefined), null);
  assert.equal(await v('not.a.token'), null);
  assert.equal(await v(token('a@example.com', { aud: ['another-app'] })), null, 'another Access app');
  assert.equal(await v(token('a@example.com', { iss: 'https://other.cloudflareaccess.com' })), null, 'another team');
  assert.equal(await v(token('a@example.com', { exp: Math.floor(Date.now() / 1000) - 3600 })), null, 'expired');
  assert.equal(await v(token('a@example.com', { nbf: Math.floor(Date.now() / 1000) + 3600 })), null, 'not yet valid');
  assert.equal(await v(token('a@example.com', { email: undefined })), null, 'no address');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.equal(await v(token('a@example.com', {}, other)), null, 'signed by someone else');
  const t = token('a@example.com');
  const [h, , s] = t.split('.');
  assert.equal(await v(`${h}.${b64({ iss: TEAM, aud: [AUD], email: 'boss@example.com', exp: 9e9 })}.${s}`), null, 'claims changed after signing');
  const alg = `${b64({ alg: 'none', kid: KID })}.${t.split('.')[1]}.`;
  assert.equal(await v(alg), null, 'alg none');
  assert.equal(await v(`${b64({ alg: 'none', kid: KID })}.${t.split('.')[1]}.${s}`), null, 'alg none, with a signature attached');
  // HS256 "signed" with the public key as the secret: the classic algorithm-confusion attack.
  const hsBody = `${b64({ alg: 'HS256', kid: KID })}.${t.split('.')[1]}`;
  const hsSig = createHmac('sha256', rsa.publicKey.export({ format: 'pem', type: 'spki' })).update(hsBody).digest('base64url');
  assert.equal(await v(`${hsBody}.${hsSig}`), null, 'HS256 with the public key as secret');
  // An unknown key id fetches the certs again, but at most once a minute.
  const before = certFetches;
  await v(token('a@example.com', {}, rsa.privateKey, 'unknown-1'));
  await v(token('a@example.com', {}, rsa.privateKey, 'unknown-2'));
  assert.ok(certFetches - before <= 1, 'unknown key ids cannot hammer the certs endpoint');
});

test('the gate token: a certs endpoint that is down is asked at most once a minute, by one request at a time', async () => {
  let calls = 0;
  const down = new AccessVerifier(TEAM, AUD, async () => { calls++; await new Promise((ok) => setTimeout(ok, 20)); throw new Error('down'); });
  const all = await Promise.all(Array.from({ length: 10 }, () => down.verify(token('a@example.com'))));
  assert.deepEqual(all, Array(10).fill(null), 'fails closed');
  assert.equal(calls, 1, 'ten requests at once share one fetch');
  for (let i = 0; i < 5; i++) assert.equal(await down.verify(token('a@example.com')), null);
  assert.equal(calls, 1, 'no refetch within a minute of a failure');
});

test('without the gate, the staff host is a plain 404: page, files and API', async () => {
  for (const path of ['/', '/anything', '/staff-ui/staff.js', '/static/app.js', '/api/staff/session']) {
    const r = await staff('GET', path);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(JSON.stringify(r.body), /staff/i, 'nothing says what is here: ' + path);
    assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
  }
  assert.equal((await staff('GET', '/', { tok: token('a@example.com', { aud: ['another-app'] }) })).status, 404);
});

test('through the gate: the staff page and its files, never the member app', async () => {
  const page = await staff('GET', '/', { who: 'anyone@example.com' });
  assert.equal(page.status, 200);
  assert.match(String(page.body), /<title>Community staff<\/title>/);
  assert.match(String(page.body), /src="\/staff-ui\/staff\.js"/);
  assert.match(String(page.headers['content-security-policy']), /script-src 'nonce-/);
  assert.equal((await staff('GET', '/staff-ui/staff.js', { who: 'anyone@example.com' })).status, 200);
  assert.equal((await staff('GET', '/static/lib/dom.js', { who: 'anyone@example.com' })).status, 200);
  for (const path of ['/sw.js', '/manifest.webmanifest', '/media/x', '/brand/sprite.svg', '/staff-ui/nope.js']) {
    assert.equal((await staff('GET', path, { who: 'anyone@example.com' })).status, 404, path);
  }
  const api = await staff('GET', '/api/me', { who: 'anyone@example.com' });
  assert.equal(api.status, 404, 'the member API is not on the staff host');
});

test('the public host has no staff API and never serves the staff page', async () => {
  for (const p of ['/staff/session', '/staff/audit', '/staff/login/options']) assert.equal((await app.call('GET', p)).status, 404, p);
  assert.equal((await app.call('POST', '/staff/login/options')).status, 404);
  const r = await fetch(app.base + '/staff-ui/staff.js');
  assert.equal(r.status, 200, 'unknown paths get the member app shell');
  assert.doesNotMatch(await r.text(), /staff passkey/i);
});

test('session status: tells the gate address apart from the staff list', async () => {
  const s = await staff('GET', '/api/staff/session', { who: 'stranger@example.com' });
  assert.equal(s.status, 200);
  assert.deepEqual({ ...s.body, public_origin: undefined }, { user: null, idle_minutes: 15, gate: 'access', listed: false, enrolled: null, public_origin: undefined });
  assert.equal(s.body.public_origin, app.config.origin);
  const p = await app.person({ role: 'staff' });
  await list(p, 'listed@example.com');
  const l = await staff('GET', '/api/staff/session', { who: 'Listed@Example.com' });
  assert.equal(l.body.listed, true);
  assert.equal(l.body.enrolled, false);
});

test('setup codes: staff only, made on the public site, one use, for the address the gate let in', async () => {
  const member = await app.person();
  assert.equal((await member.call('POST', '/me/staff-code')).status, 403);
  assert.equal((await app.call('POST', '/me/staff-code')).status, 401);
  const mod = await app.person({ staffRole: 'Moderator' });
  await list(mod, 'mod1@example.com');
  const c = await mod.call('POST', '/me/staff-code');
  assert.equal(c.status, 201);
  assert.match(c.body.code, /^[A-HJ-NP-Z2-9]{8}$/, 'no 0/O or 1/I');
  assert.equal(c.body.expires_minutes, 10);
  // Someone else passing the gate can't use it.
  const other = await staff('POST', '/api/staff/enroll/options', { who: 'someone-else@example.com', body: { code: c.body.code } });
  assert.equal(other.status, 403);
  assert.equal(other.body.error.code, 'not_listed');
  assert.equal((await staff('POST', '/api/staff/enroll/options', { who: 'mod1@example.com', body: { code: 'ABCDEFGH' } })).body.error.code, 'code_invalid');
  assert.equal((await staff('POST', '/api/staff/enroll/options', { who: 'mod1@example.com', body: { code: '12' } })).status, 400);
  // A new code cancels the old one.
  const c2 = await mod.call('POST', '/me/staff-code');
  assert.equal((await staff('POST', '/api/staff/enroll/options', { who: 'mod1@example.com', body: { code: c.body.code } })).body.error.code, 'code_invalid');
  // Wrong origin is refused before anything else.
  const x = await staff('POST', '/api/staff/enroll/options', { who: 'mod1@example.com', body: { code: c2.body.code }, origin: app.config.origin });
  assert.equal(x.status, 403);
  assert.equal(x.body.error.code, 'bad_origin');
});

test('enroll and sign in with a staff passkey; lock; sign in again; the log has it all', async () => {
  const over = await app.person({ role: 'staff' });
  await list(over, 'over@example.com');
  const { cookie, key } = await enroll(over, 'over@example.com');
  const s = await staff('GET', '/api/staff/session', { who: 'over@example.com', cookie });
  assert.equal(s.body.user.handle, over.handle);
  assert.equal(s.body.user.role, 'Overseer');
  assert.ok(s.body.user.scopes.includes('audit.read'));
  assert.ok(Date.parse(s.body.user.idle_ends_at) > Date.now() + 14 * 60_000);
  assert.equal(s.body.enrolled, true);

  // The cookie is the staff host's own: __Host-, Secure, HttpOnly, SameSite=Strict, no Domain.
  const login = await staff('POST', '/api/staff/login/options', { who: 'over@example.com' });
  assert.equal(login.body.options.rpId, RP);
  assert.equal(login.body.options.userVerification, 'required');
  const v = await staff('POST', '/api/staff/login/verify', { who: 'over@example.com', body: { challengeId: login.body.challengeId, response: key.get(login.body.options) } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const set = String(([] as string[]).concat(v.headers['set-cookie'] || []).find((c) => c.startsWith('__Host-staff=')));
  for (const a of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=43200']) assert.ok(set.includes(a), a);
  assert.doesNotMatch(set, /Domain=/i);

  // The same challenge can't be used twice.
  const again = await staff('POST', '/api/staff/login/verify', { who: 'over@example.com', body: { challengeId: login.body.challengeId, response: key.get(login.body.options) } });
  assert.equal(again.status, 400);

  // A member session cookie means nothing here.
  assert.equal((await staff('GET', '/api/staff/session', { who: 'over@example.com', cookie: over.cookie })).body.user, null);

  // Lock ends the session.
  const lock = await staff('POST', '/api/staff/lock', { who: 'over@example.com', cookie: v.cookie!, body: { why: 'button' } });
  assert.equal(lock.status, 204);
  assert.equal((await staff('GET', '/api/staff/session', { who: 'over@example.com', cookie: v.cookie! })).body.user, null);

  const log = await staff('GET', '/api/staff/audit?who=' + over.handle, { who: 'over@example.com', cookie });
  assert.equal(log.status, 200);
  const texts = log.body.entries.map((e: { text: string }) => e.text);
  for (const t of ['asked for a staff passkey setup code', 'set up a staff passkey', 'opened the staff panel with a passkey', 'locked the panel']) assert.ok(texts.includes(t), t);
  assert.ok(log.body.as_of);
  const q = await staff('GET', '/api/staff/audit?q=' + encodeURIComponent('100%_'), { who: 'over@example.com', cookie });
  assert.equal(q.body.entries.length, 0, '% and _ are matched literally');
  assert.equal((await staff('GET', '/api/staff/audit?kind=nope', { who: 'over@example.com', cookie })).status, 400);
});

test('a staff session only counts with the gate address that set it up', async () => {
  const over = await app.person({ role: 'staff' });
  await list(over, 'over2@example.com');
  const { cookie, key } = await enroll(over, 'over2@example.com');
  assert.equal((await staff('GET', '/api/staff/session', { who: 'other@example.com', cookie })).body.user, null, 'cookie with another address');
  const login = await staff('POST', '/api/staff/login/options', { who: 'other@example.com' });
  const v = await staff('POST', '/api/staff/login/verify', { who: 'other@example.com', body: { challengeId: login.body.challengeId, response: key.get(login.body.options) } });
  assert.equal(v.status, 401, 'the passkey with another address');
});

test('the idle lock and the role: 15 quiet minutes, or losing the role, ends the session', async () => {
  const over = await app.person({ role: 'staff' });
  await list(over, 'over3@example.com');
  const { cookie } = await enroll(over, 'over3@example.com');
  // Reading the status doesn't count as activity.
  const s1 = await staff('GET', '/api/staff/session', { who: 'over3@example.com', cookie });
  await app.db.query(`UPDATE staff_sessions SET last_seen_at = now() - interval '16 minutes' WHERE user_id = $1`, [over.id]);
  assert.ok(s1.body.user);
  assert.equal((await staff('GET', '/api/staff/session', { who: 'over3@example.com', cookie })).body.user, null, 'idle 16 minutes');
  assert.equal((await staff('GET', '/api/staff/audit', { who: 'over3@example.com', cookie })).status, 401);
  await app.db.query(`UPDATE staff_sessions SET last_seen_at = now(), expires_at = now() - interval '1 second' WHERE user_id = $1`, [over.id]);
  assert.equal((await staff('GET', '/api/staff/session', { who: 'over3@example.com', cookie })).body.user, null, 'past 12 hours');

  const mod = await app.person({ staffRole: 'Moderator' });
  await list(mod, 'mod2@example.com');
  const m = await enroll(mod, 'mod2@example.com');
  const a = await staff('GET', '/api/staff/audit', { who: 'mod2@example.com', cookie: m.cookie });
  assert.equal(a.status, 403, 'a Moderator does not read the audit log');
  assert.equal(a.body.error.code, 'no_scope');
  await revokeRole(app.db, mod.handle);
  assert.equal((await staff('GET', '/api/staff/session', { who: 'mod2@example.com', cookie: m.cookie })).body.user, null);
  assert.equal((await app.db.query('SELECT 1 FROM staff_passkeys WHERE user_id = $1', [mod.id])).length, 0, 'staff passkeys go with the role');
  // The gate address went with the role: a new role without it isn't on the list.
  await grantRole(app.db, { handle: mod.handle, role: 'Support' });
  assert.equal((await staff('GET', '/api/staff/session', { who: 'mod2@example.com' })).body.listed, false);
  // With the address again, they set up a new passkey.
  await grantRole(app.db, { handle: mod.handle, role: 'Support', emailHash: emailHash(app.config, 'mod2@example.com') });
  const back = await staff('GET', '/api/staff/session', { who: 'mod2@example.com' });
  assert.equal(back.body.listed, true);
  assert.equal(back.body.enrolled, false);
});

test('the audit log is append-only: no update, delete or truncate, Overseers included', async () => {
  await app.db.query(`INSERT INTO staff_actions (actor_handle, kind, text) VALUES ('system', 'audit', 'test entry')`);
  await assert.rejects(app.db.query(`UPDATE staff_actions SET text = 'changed'`), /append-only/);
  await assert.rejects(app.db.query('DELETE FROM staff_actions'), /append-only/);
  await assert.rejects(app.db.query('TRUNCATE staff_actions'), /append-only/);
  await assert.rejects(app.db.query(`INSERT INTO staff_actions (actor_handle, kind, text) VALUES ('system', 'Bad Kind', 'x')`));
});
