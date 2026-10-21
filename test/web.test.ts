// The web app: pure helpers (base64url, WebAuthn conversion, the E2E envelope, router matching,
// Places levels, formatting) run in Node, plus checks on the served shell, its CSP nonces, and that
// no brand art or inline styles/handlers are in app/web.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startApp, type TestApp } from './helpers.ts';

const WEB = join(import.meta.dirname, '..', 'app', 'web');
const load = (rel: string): Promise<any> => import(pathToFileURL(join(WEB, 'static', rel)).href);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

let app: TestApp;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('base64 and base64url round trips, known values, bad input refused', async () => {
  const b = await load('lib/b64.js');
  const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x10]);
  assert.equal(b.bytesToB64(bytes), '+/8AEA==');
  assert.equal(b.bytesToB64url(bytes), '-_8AEA');
  assert.deepEqual([...b.b64urlToBytes('-_8AEA')], [...bytes]);
  assert.deepEqual([...b.b64urlToBytes('-_8AEA==')], [...bytes]);
  assert.deepEqual([...b.b64ToBytes('+/8AEA==')], [...bytes]);
  const rnd = crypto.getRandomValues(new Uint8Array(1000));
  assert.deepEqual([...b.b64urlToBytes(b.bytesToB64url(rnd))], [...rnd]);
  assert.deepEqual([...b.b64ToBytes(b.bytesToB64(rnd))], [...rnd]);
  const buf = b.b64urlToBuffer('AQID');
  assert.ok(buf instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(buf)], [1, 2, 3]);
  assert.throws(() => b.b64urlToBytes('a+b'));
  assert.throws(() => b.b64ToBytes('a_b'));
  assert.equal(b.fromUtf8(b.utf8('Salamat po 🙏')), 'Salamat po 🙏');
});

test('WebAuthn options and credentials convert to and from JSON', async () => {
  const w = await load('lib/webauthn.js');
  const b = await load('lib/b64.js');
  const opts = w.creationOptionsFromJSON({
    challenge: 'AQID', rp: { name: 'Community', id: 'localhost' }, user: { id: 'BAUG', name: 'ana', displayName: 'Ana' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [{ id: 'BwgJ', type: 'public-key' }],
  });
  assert.deepEqual([...new Uint8Array(opts.challenge)], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(opts.user.id)], [4, 5, 6]);
  assert.deepEqual([...new Uint8Array(opts.excludeCredentials[0].id)], [7, 8, 9]);
  assert.equal(opts.rp.id, 'localhost');
  const req = w.requestOptionsFromJSON({ challenge: 'AQID', rpId: 'localhost' });
  assert.ok(req.challenge instanceof ArrayBuffer);
  assert.equal(req.allowCredentials, undefined, 'discoverable login: no allow list added');

  const ab = (a: number[]) => new Uint8Array(a).buffer;
  const reg = w.credentialToJSON({
    id: 'Cgs', rawId: ab([10, 11]), type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: ab([1]), attestationObject: ab([2, 3]), getTransports: () => ['internal'], getPublicKeyAlgorithm: () => -7, getPublicKey: () => ab([4]), getAuthenticatorData: () => ab([5]) },
    getClientExtensionResults: () => ({}),
  });
  assert.deepEqual(reg, {
    id: 'Cgs', rawId: 'Cgs', type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
    response: { clientDataJSON: 'AQ', attestationObject: 'AgM', transports: ['internal'], publicKeyAlgorithm: -7, publicKey: 'BA', authenticatorData: 'BQ' },
  });
  const auth = w.credentialToJSON({ id: 'Cgs', rawId: ab([10, 11]), type: 'public-key', response: { clientDataJSON: ab([1]), authenticatorData: ab([2]), signature: ab([3]), userHandle: ab([4]) } });
  assert.deepEqual(auth.response, { clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw', userHandle: 'BA' });
  assert.equal(b.bytesToB64url(new Uint8Array([10, 11])), auth.rawId);
});

test('E2E: a DM sealed by one person opens for the other, and nobody else', async () => {
  const e = await load('lib/e2e.js');
  const ana = await e.generateIdentity();
  const ben = await e.generateIdentity();
  const eve = await e.generateIdentity();
  assert.deepEqual(Object.keys(ana.publicJwk).sort(), ['crv', 'kty', 'x', 'y'], 'only the public parts are published');
  assert.equal(ana.privateKey.extractable, false, 'the private key cannot be exported');

  const kAna = await e.deriveDmKey(ana.privateKey, ben.publicJwk, 'conv-1');
  const kBen = await e.deriveDmKey(ben.privateKey, ana.publicJwk, 'conv-1');
  const sealed = await e.seal(kAna, { t: 'Free on Saturday? 🔥' });
  assert.equal(sealed.v, 1);
  assert.match(sealed.iv, /^[A-Za-z0-9+/]+=*$/, 'standard base64');
  assert.match(sealed.ct, /^[A-Za-z0-9+/]+=*$/);
  assert.doesNotMatch(sealed.ct, /Saturday/);
  assert.deepEqual(await e.open(kBen, sealed), { t: 'Free on Saturday? 🔥' });
  assert.deepEqual(await e.open(kAna, sealed), { t: 'Free on Saturday? 🔥' }, 'the sender can read their own message');

  const kEve = await e.deriveDmKey(eve.privateKey, ana.publicJwk, 'conv-1');
  await assert.rejects(e.open(kEve, sealed), 'a third person cannot read it');
  const kOther = await e.deriveDmKey(ben.privateKey, ana.publicJwk, 'conv-2');
  await assert.rejects(e.open(kOther, sealed), 'keys are per conversation');
  const tampered = { ...sealed, ct: sealed.ct.slice(0, -4) + (sealed.ct.endsWith('AAA=') ? 'BBB=' : 'AAA=') };
  await assert.rejects(e.open(kBen, tampered), 'a changed message is refused');
  assert.throws(() => e.publicJwk({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b' }));
});

test('E2E: a private Space message opens for every member and no one else', async () => {
  const e = await load('lib/e2e.js');
  const people = await Promise.all([1, 2, 3].map(() => e.generateIdentity()));
  const outsider = await e.generateIdentity();
  const recipients = people.map((p: any, i: number) => ({ id: 'u' + i, jwk: p.publicJwk }));
  const sealed = await e.sealForMembers({ t: 'Kape Saturday 7am' }, recipients, 'chan-9');
  assert.equal(sealed.v, 1);
  assert.deepEqual(Object.keys(sealed.keys).sort(), ['u0', 'u1', 'u2']);
  assert.deepEqual(Object.keys(sealed.epk).sort(), ['crv', 'kty', 'x', 'y']);
  for (let i = 0; i < 3; i++) assert.deepEqual(await e.openForMember(sealed, 'u' + i, people[i].privateKey, 'chan-9'), { t: 'Kape Saturday 7am' });
  await assert.rejects(e.openForMember(sealed, 'u3', outsider.privateKey, 'chan-9'), 'no key for a non-member');
  await assert.rejects(e.openForMember({ ...sealed, keys: { u3: sealed.keys.u0 } }, 'u3', outsider.privateKey, 'chan-9'), 'a copied key does not open');
  await assert.rejects(e.openForMember(sealed, 'u0', people[0].privateKey, 'chan-other'), 'bound to the channel');
});

test('router: every screen path matches, params decode, unknown paths do not', async () => {
  const r = await load('lib/router.js');
  const routes = r.compile(r.ROUTES);
  const m = (p: string) => r.match(routes, p);
  assert.deepEqual(m('/'), { name: 'home', params: {} });
  assert.deepEqual(m('/places'), { name: 'places', params: {} });
  assert.deepEqual(m('/places/city/1380700000'), { name: 'placesAt', params: { level: 'city', code: '1380700000' } });
  assert.deepEqual(m('/s/pasig-riders/c/abc-123'), { name: 'channel', params: { slug: 'pasig-riders', channel: 'abc-123' } });
  assert.deepEqual(m('/s/pasig-riders/'), { name: 'space', params: { slug: 'pasig-riders' } });
  assert.deepEqual(m('/jun.rides'), { name: 'profile', params: { handle: 'jun.rides' } });
  assert.deepEqual(m('/jun.rides/'), { name: 'profile', params: { handle: 'jun.rides' } });
  assert.deepEqual(m('/a%20b'), { name: 'profile', params: { handle: 'a b' } });
  assert.deepEqual(m('/u/jun.rides'), { name: 'oldProfile', params: { handle: 'jun.rides' } }, 'old profile links still match');
  assert.equal(r.ROUTES.at(-1)[0], 'profile', 'the profile catch-all comes last');
  assert.deepEqual(m('/gigs/new'), { name: 'gigNew', params: {} });
  assert.deepEqual(m('/gigs/42/apply'), { name: 'apply', params: { id: '42' } });
  assert.deepEqual(m('/gigs/42/applicants'), { name: 'applicants', params: { id: '42' } });
  assert.deepEqual(m('/inbox/7?x=1'), { name: 'dm', params: { id: '7' } });
  assert.deepEqual(m('/me/settings'), { name: 'settings', params: {} });
  assert.equal(m('/nope/here'), null);
  assert.equal(m('/s/a/b/c'), null);
  assert.equal(m('/%E0%A4%A'), null, 'bad encoding is no match, not a crash');
  for (const p of ['/join', '/login', '/p/1', '/compose', '/explore', '/activity', '/spaces', '/inbox', '/work', '/me/data', '/me/proof', '/transparency', '/mod']) assert.notEqual(m(p)?.name, 'profile', p);
  const f = await load('lib/format.js');
  assert.equal(f.profilePath('maria.santos'), '/maria.santos');
  assert.equal(f.profilePath('a/b'), '/a%2Fb');
  assert.equal(r.build('/s/:slug/c/:channel', { slug: 'a b', channel: 'x/y' }), '/s/a%20b/c/x%2Fy');

  const appJs = readFileSync(join(WEB, 'static', 'app.js'), 'utf8');
  const screens = /const SCREENS = \{([\s\S]*?)\};/.exec(appJs)?.[1] ?? '';
  for (const [name] of r.ROUTES) assert.match(screens, new RegExp('\\b' + name + '\\b'), 'route ' + name + ' has a screen');
});

test('old profile links: /u/<username> is a permanent redirect to /<username>, never off the site', async () => {
  const r = await fetch(app.base + '/u/Jun.Rides?from=share', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/jun.rides?from=share');
  for (const p of ['/u//evil.example', '/u/%2F%2Fevil.example', '/u/\evil.example', '/u/a/b']) {
    const x = await fetch(app.base + p, { redirect: 'manual' });
    if (x.status === 301) assert.match(x.headers.get('location') || '', /^\/[a-z0-9._]+$/, p);
  }
  const prof = await fetch(app.base + '/jun.rides');
  assert.equal(prof.status, 200, 'a profile path serves the app');
  assert.match(prof.headers.get('content-type') || '', /text\/html/);
});

test('Places: the code to ask for at each zoom level', async () => {
  const pl = await load('lib/places.js');
  const chain = [{ code: 'B1', level: 'barangay' }, { code: 'C1', level: 'city' }, { code: 'P1', level: 'province' }, { code: 'R1', level: 'region' }, { code: 'PH', level: 'country' }];
  assert.equal(pl.codeAtLevel(chain, 'barangay'), 'B1');
  assert.equal(pl.codeAtLevel(chain, 'city'), 'C1');
  assert.equal(pl.codeAtLevel(chain, 'region'), 'R1');
  assert.equal(pl.codeAtLevel(chain, 'country'), 'PH');
  assert.equal(pl.codeAtLevel(chain, 'world'), 'WORLD');
  assert.equal(pl.codeAtLevel(chain.slice(1), 'barangay'), null, 'finer than the focus: the person picks');
  assert.deepEqual(pl.LEVELS.map((l: any) => l.k), ['barangay', 'city', 'region', 'country', 'world']);
  assert.equal(pl.DEFAULT_LEVEL, 'city');
});

test('formatting and photo sizing', async () => {
  const f = await load('lib/format.js');
  const now = Date.parse('2026-10-19T10:00:00Z');
  assert.equal(f.timeAgo('2026-10-19T09:59:30Z', now), 'now');
  assert.equal(f.timeAgo('2026-10-19T09:48:00Z', now), '12m');
  assert.equal(f.timeAgo('2026-10-19T07:00:00Z', now), '3h');
  assert.equal(f.timeAgo('2026-10-17T10:00:00Z', now), '2d');
  assert.equal(f.timeAgo('garbage', now), '');
  assert.match(f.asOf('2026-10-19T09:41:00Z', now), /^as of /);
  assert.match(f.pay(600, 'PHP', 'night').amount, /600/);
  assert.equal(f.pay(600, 'PHP', 'night').unit, 'a night');
  assert.equal(f.count(1240), '1.2k');
  assert.ok(f.HANDLE_RE.test('jun.rides') && !f.HANDLE_RE.test('Bad Name'));
  const m = await load('lib/media.js');
  assert.deepEqual(m.fitWithin(4000, 3000), { w: 1600, h: 1200 });
  assert.deepEqual(m.fitWithin(800, 600), { w: 800, h: 600 }, 'never upscaled');
  assert.equal(m.QUALITY, 0.85);
});

test('the shell: every script, style and stylesheet carries this request\'s nonce; no inline handlers or styles', async () => {
  for (const path of ['/', '/places/city/T-CITY', '/s/x/c/y', '/me/settings']) {
    const r = await fetch(app.base + path);
    assert.equal(r.status, 200, path);
    const html = await r.text();
    const csp = r.headers.get('content-security-policy') || '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
    assert.ok(nonce.length >= 16, 'a nonce per request');
    assert.doesNotMatch(html, /__NONCE__|__BRAND__/);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers');
    assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style attributes');
    const tags = [...html.matchAll(/<(script|style)\b[^>]*>/gi), ...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)].map((x) => x[0]);
    assert.ok(tags.length >= 3, 'the module script, the stylesheet link and the style block');
    for (const t of tags) assert.ok(t.includes(`nonce="${nonce}"`), 'nonce on ' + t);
    assert.match(html, /data-brand="0"/, 'no brand pack in tests');
  }
});

test('static files are served, the service worker caches only files that exist, and no API', async () => {
  const js = await fetch(app.base + '/static/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
  const css = await fetch(app.base + '/static/app.css');
  assert.match(css.headers.get('content-type') || '', /text\/css/);
  // the app's code is revalidated on every load, so a deploy is never hours late
  for (const p of ['/static/app.js', '/static/app.css', '/sw.js', '/manifest.webmanifest']) {
    const r = await fetch(app.base + p);
    await r.arrayBuffer();
    assert.equal(r.headers.get('cache-control'), 'no-cache', p);
    const tag = r.headers.get('etag') || '';
    assert.match(tag, /^"[\w-]{22}"$/, p + ' has an ETag');
    const again = await fetch(app.base + p, { headers: { 'If-None-Match': tag } });
    assert.equal(again.status, 304, p + ' unchanged: 304');
    assert.equal((await again.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(app.base + p, { headers: { 'If-None-Match': '"other"' } })).status, 200);
  }
  const man = await fetch(app.base + '/manifest.webmanifest');
  const mj = await man.json();
  assert.equal(mj.name, 'PopCart Community');
  for (const i of mj.icons || []) assert.match(i.src, /^data:image\/svg\+xml,/, 'no brand icon files');
  const sw = await (await fetch(app.base + '/sw.js')).text();
  const list = JSON.parse('[' + (/const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '').replace(/'/g, '"').replace(/,\s*$/, '') + ']') as string[];
  assert.ok(list.length > 10);
  for (const p of list) {
    assert.ok(p.startsWith('/static/') || p === '/manifest.webmanifest', p);
    assert.equal((await fetch(app.base + p)).status, 200, p + ' exists');
  }
  const staticFiles = walk(join(WEB, 'static')).filter((f) => f.endsWith('.js') || f.endsWith('.css')).map((f) => '/static/' + relative(join(WEB, 'static'), f).replace(/\\/g, '/'));
  for (const f of staticFiles) assert.ok(list.includes(f), f + ' is in the service worker list');
  assert.doesNotMatch(sw, /['"]\/api\//, 'the service worker never lists API paths');
});

test('app/web holds no brand art, fonts, inline styles or HTML injection', () => {
  for (const f of walk(WEB)) {
    const ext = extname(f).toLowerCase();
    assert.ok(!['.ttf', '.otf', '.woff', '.woff2', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico'].includes(ext), 'no font or image files: ' + f);
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /<symbol\b/i, 'no SVG symbols (brand art comes from the optional pack): ' + f);
    if (ext === '.js') {
      assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/, 'DOM built without HTML strings: ' + f);
      assert.doesNotMatch(src, /style="|\son[a-z]+="/i, 'no style or handler attributes in markup strings: ' + f);
    }
  }
});

test('promises on screen are ones we keep: never sold, ads labelled; no "no ads" or "no tracking" (decision 0007)', () => {
  const root = join(import.meta.dirname, '..', 'app', 'web');
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|html)$/.test(f)) files.push(p); } };
  walk(root);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /no ads|show you ads|walang ads|no tracking|walang tracking/i, 'withdrawn promise in ' + relative(root, f));
  }
  const join_ = readFileSync(join(root, 'static', 'screens', 'join.js'), 'utf8');
  assert.match(join_, /We never sell your data\. Any ad is clearly labelled\./);
});
