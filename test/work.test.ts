// Work and credentials, end to end over HTTP. Issuer keys are generated here, at test run time, and
// never written anywhere. Every person and place is a labelled test fixture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { setTrustedIssuers } from '../app/modules/work/credentials.ts';
import { gigScore, nearSignal, trustSignal, freshSignal, GIG_WEIGHTS } from '../app/modules/work/weights.ts';
import { seedTestAreas, startApp, type Person, type TestApp } from './helpers.ts';

const ISSUER = 'https://issuer.test.invalid';
const ISSUER_P256 = 'https://issuer-p256.test.invalid';
const UNTRUSTED = 'https://untrusted.test.invalid';

const ed = generateKeyPairSync('ed25519');
const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rogue = generateKeyPairSync('ed25519');

let app: TestApp;
before(async () => {
  app = await startApp();
  await seedTestAreas(app.db);
  setTrustedIssuers({
    [ISSUER]: ed.publicKey.export({ format: 'jwk' }),
    [ISSUER_P256]: p256.publicKey.export({ format: 'jwk' }),
  });
});
after(async () => { setTrustedIssuers(null); await app.close(); });

// Written independently of the server code, from docs/credentials.md.
function canonical(v: unknown): string {
  const sortKeys = (x: unknown): unknown => Array.isArray(x) ? x.map(sortKeys)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(sortKeys(v));
}

function issue(opts: { handle: string; type?: string; summary?: string; issuer?: string; key?: KeyObject; alg?: 'EdDSA' | 'ES256';
  expires?: Date; issued?: Date; asOf?: Date }): Record<string, unknown> {
  const now = Date.now();
  const vc: Record<string, unknown> = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', opts.type ?? 'DeliveryRecord'],
    issuer: opts.issuer ?? ISSUER,
    issuanceDate: (opts.issued ?? new Date(now - 60_000)).toISOString(),
    expirationDate: (opts.expires ?? new Date(now + 30 * 86400_000)).toISOString(),
    credentialSubject: {
      id: `community:@${opts.handle}`,
      summary: opts.summary ?? 'Test fixture: 12 deliveries, 100% on time',
      asOf: (opts.asOf ?? new Date(now - 3600_000)).toISOString(),
    },
  };
  const alg = opts.alg ?? 'EdDSA';
  const h64 = Buffer.from(JSON.stringify({ alg })).toString('base64url');
  const input = Buffer.from(`${h64}.${Buffer.from(canonical(vc)).toString('base64url')}`);
  const sig = alg === 'EdDSA'
    ? sign(null, input, opts.key ?? ed.privateKey)
    : sign('sha256', input, { key: opts.key ?? p256.privateKey, dsaEncoding: 'ieee-p1363' });
  return { ...vc, proof: { type: 'DetachedJws', created: new Date(now).toISOString(), jws: `${h64}..${sig.toString('base64url')}` } };
}

async function idChecked(p: Person): Promise<void> {
  const r = await p.call('POST', '/me/credentials', { vc: issue({ handle: p.handle, type: 'IdentityCheck', summary: 'Test fixture: ID checked' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
}

const gigBody = (over: Record<string, unknown> = {}) => ({
  title: 'Test gig: deliver two boxes', body: 'Test fixture gig. Two boxes across town, before noon.',
  pay_amount: 350, pay_unit: 'fixed', when_text: 'Tomorrow morning', paid_how: 'Cash on completion', skills: ['rider'],
  area_code: 'T-BRGY1', ...over,
});

test('credentials: a VC from a trusted issuer is accepted, listed, shown on the profile and makes the ID check', async () => {
  const p = await app.person();
  const r = await p.call('POST', '/me/credentials', { vc: issue({ handle: p.handle }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.credential.type, 'DeliveryRecord');
  assert.equal(r.body.credential.issuer, ISSUER);
  assert.equal(r.body.credential.verified, true);
  assert.equal(r.body.credential.summary, 'Test fixture: 12 deliveries, 100% on time');
  const list = await p.call('GET', '/me/credentials');
  assert.equal(list.body.credentials.length, 1);
  assert.ok(list.body.as_of);
  const prof = await app.call('GET', `/people/${p.handle}`);
  assert.equal(prof.body.person.credentials.length, 1);
  assert.equal(prof.body.person.id_checked, false);

  // re-issued: same issuer and type replaces the old one and keeps its id
  const again = await p.call('POST', '/me/credentials', { vc: issue({ handle: p.handle, summary: 'Test fixture: 13 deliveries' }) });
  assert.equal(again.body.credential.id, r.body.credential.id);
  assert.equal(again.body.credential.summary, 'Test fixture: 13 deliveries');

  // ES256 issuer works too
  const es = await p.call('POST', '/me/credentials', { vc: issue({ handle: p.handle, issuer: ISSUER_P256, alg: 'ES256', type: 'IdentityCheck' }) });
  assert.equal(es.status, 201, JSON.stringify(es.body));
  assert.equal((await app.call('GET', `/people/${p.handle}`)).body.person.id_checked, true);

  // hide, then delete
  const hid = await p.call('PATCH', `/me/credentials/${r.body.credential.id}`, { shown: false });
  assert.equal(hid.body.credential.shown, false);
  assert.equal((await app.call('GET', `/people/${p.handle}`)).body.person.credentials.length, 1);
  const other = await app.person();
  assert.equal((await other.call('DELETE', `/me/credentials/${r.body.credential.id}`)).status, 404, 'not someone else\'s');
  assert.equal((await p.call('DELETE', `/me/credentials/${r.body.credential.id}`)).status, 204);
  assert.equal((await p.call('GET', '/me/credentials')).body.credentials.length, 1);
});

test('credentials: tampered, wrong subject, untrusted, expired, future and malformed are refused', async () => {
  const p = await app.person();
  const tampered = issue({ handle: p.handle });
  (tampered.credentialSubject as Record<string, unknown>).summary = 'Test fixture: 9,999 deliveries';
  const cases: [string, unknown, string][] = [
    ['tampered claim', tampered, 'bad_signature'],
    ['wrong subject', issue({ handle: 'someone.else' }), 'wrong_subject'],
    ['untrusted issuer', issue({ handle: p.handle, issuer: UNTRUSTED, key: rogue.privateKey }), 'untrusted_issuer'],
    ['trusted id, wrong key', issue({ handle: p.handle, key: rogue.privateKey }), 'bad_signature'],
    ['expired', issue({ handle: p.handle, expires: new Date(Date.now() - 1000) }), 'expired'],
    ['issued in the future', issue({ handle: p.handle, issued: new Date(Date.now() + 86400_000) }), 'not_yet_valid'],
    ['wrong alg for issuer', issue({ handle: p.handle, alg: 'ES256' }), 'bad_alg'],
    ['summary too long', issue({ handle: p.handle, summary: 'x'.repeat(121) }), 'bad_summary'],
    ['no proof', (() => { const v = issue({ handle: p.handle }); delete v.proof; return v; })(), 'bad_proof'],
    ['not an object', 'a string', 'vc_shape'],
  ];
  for (const [name, vc, code] of cases) {
    const r = await p.call('POST', '/me/credentials', { vc });
    assert.equal(r.status, 400, name);
    assert.equal(r.body.error.code, code, name);
  }
  assert.equal((await p.call('GET', '/me/credentials')).body.credentials.length, 0);
});

test('gigs: post needs the ID check; the whole flow from post to rating', async () => {
  const poster = await app.person({ home_area: 'T-BRGY1' });
  const worker = await app.person({ trade: 'rider', home_area: 'T-BRGY2' });
  const stranger = await app.person();

  const noId = await poster.call('POST', '/gigs', gigBody());
  assert.equal(noId.status, 403);
  assert.equal(noId.body.error.code, 'id_check');
  await idChecked(poster);
  const made = await poster.call('POST', '/gigs', gigBody());
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const gig = made.body.gig;
  assert.equal(gig.paid_how, 'Cash on completion');
  assert.equal(gig.status, 'open');
  assert.equal(gig.place.code, 'T-BRGY1');
  assert.equal(gig.poster.id_checked, true);
  assert.equal(gig.distance_hint, 'In your barangay');
  assert.equal((await poster.call('POST', '/gigs', gigBody({ pay_amount: 0 }))).status, 400);
  assert.equal((await poster.call('POST', '/gigs', gigBody({ paid_how: '' }))).status, 400);

  // lists
  const newest = await app.call('GET', '/gigs?tab=newest');
  assert.ok(newest.body.as_of);
  assert.ok(newest.body.gigs.some((g: any) => g.id === gig.id));
  const forYou = await worker.call('GET', '/gigs?tab=for_you');
  assert.equal(forYou.status, 200);
  assert.ok(forYou.body.rule.includes('score'));
  assert.deepEqual(forYou.body.weights, { ...GIG_WEIGHTS });
  const mine = forYou.body.gigs.find((g: any) => g.id === gig.id);
  assert.equal(mine.signals.trade, 1);
  assert.equal(mine.signals.near, 0.5);
  assert.equal(mine.distance_hint, 'In your city');
  assert.equal((await app.call('GET', '/gigs?tab=for_you')).status, 401);
  assert.ok((await poster.call('GET', '/gigs?tab=mine')).body.gigs.some((g: any) => g.id === gig.id));
  assert.equal((await app.call('GET', '/gigs?min_pay=1000')).body.gigs.some((g: any) => g.id === gig.id), false);
  assert.ok((await app.call('GET', '/gigs?trade=rider&level=city&code=T-CITY')).body.gigs.some((g: any) => g.id === gig.id));
  assert.equal((await app.call('GET', '/gigs?level=city&code=T-CITY2')).body.gigs.some((g: any) => g.id === gig.id), false);

  // save
  assert.equal((await worker.call('POST', `/gigs/${gig.id}/save`)).status, 204);
  const saved = await worker.call('GET', '/gigs?tab=saved');
  assert.equal(saved.body.gigs[0].id, gig.id);
  assert.equal(saved.body.gigs[0].saved, true);
  assert.equal((await worker.call('DELETE', `/gigs/${gig.id}/save`)).status, 204);
  assert.equal((await worker.call('GET', '/gigs?tab=saved')).body.gigs.length, 0);

  // apply with a credential of my own; not with someone else's
  const cred = await worker.call('POST', '/me/credentials', { vc: issue({ handle: worker.handle }) });
  const posterCred = (await poster.call('GET', '/me/credentials')).body.credentials[0].id;
  assert.equal((await poster.call('POST', `/gigs/${gig.id}/applications`, { note: 'me' })).body.error.code, 'own_gig');
  assert.equal((await worker.call('POST', `/gigs/${gig.id}/applications`, { note: 'x', credential_ids: [posterCred] })).body.error.code, 'credential');
  const ap = await worker.call('POST', `/gigs/${gig.id}/applications`, { note: 'Test fixture: I can do it', credential_ids: [cred.body.credential.id] });
  assert.equal(ap.status, 201, JSON.stringify(ap.body));
  assert.equal((await worker.call('POST', `/gigs/${gig.id}/applications`, { note: 'again' })).status, 409);
  const other = await app.person();
  const ap2 = await other.call('POST', `/gigs/${gig.id}/applications`, { note: 'Test fixture: me too' });
  assert.equal(ap2.status, 201);

  // only the poster sees applications and picks
  assert.equal((await stranger.call('GET', `/gigs/${gig.id}/applications`)).status, 403);
  assert.equal((await worker.call('GET', `/gigs/${gig.id}/applications`)).status, 403);
  const apps = await poster.call('GET', `/gigs/${gig.id}/applications`);
  assert.equal(apps.body.applications.length, 2);
  const wa = apps.body.applications.find((a: any) => a.person.handle === worker.handle);
  assert.equal(wa.credentials.length, 1);
  assert.equal(wa.credentials[0].summary, 'Test fixture: 12 deliveries, 100% on time');
  assert.equal((await worker.call('POST', `/applications/${ap.body.application.id}/pick`)).status, 403);
  assert.equal((await stranger.call('POST', `/applications/${ap.body.application.id}/pick`)).status, 403);

  // rating before anything is done: refused
  assert.equal((await worker.call('POST', `/gigs/${gig.id}/ratings`, { on_time: 5, quality: 5, easy: 5, again: 5 })).status, 403);

  assert.equal((await poster.call('POST', `/applications/${ap.body.application.id}/pick`)).status, 204);
  const view = await worker.call('GET', `/gigs/${gig.id}`);
  assert.equal(view.body.gig.status, 'filled');
  assert.equal(view.body.my_application.status, 'picked');
  assert.ok(view.body.poster.trust.as_of);
  assert.equal((await poster.call('POST', `/applications/${ap2.body.application.id}/pick`)).status, 409, 'filled: no second pick');
  const notes = await app.db.query(`SELECT kind FROM notifications WHERE user_id = $1`, [worker.id]);
  assert.ok(notes.some((n: any) => n.kind === 'picked'));

  // done: only the poster or the picked person; ratings only after both
  assert.equal((await other.call('POST', `/applications/${ap.body.application.id}/done`)).status, 403);
  assert.equal((await poster.call('POST', `/applications/${ap2.body.application.id}/done`)).status, 409);
  assert.equal((await worker.call('POST', `/applications/${ap.body.application.id}/done`)).status, 204);
  const early = await worker.call('POST', `/gigs/${gig.id}/ratings`, { on_time: 5, quality: 5, easy: 5, again: 5 });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'not_done');
  assert.equal((await poster.call('POST', `/applications/${ap.body.application.id}/done`)).status, 204);

  // both directions, once each; the second applicant cannot rate
  assert.equal((await worker.call('POST', `/gigs/${gig.id}/ratings`, { on_time: 6, quality: 5, easy: 5, again: 5 })).status, 400);
  assert.equal((await worker.call('POST', `/gigs/${gig.id}/ratings`, { on_time: 5, quality: 4, easy: 5, again: 5 })).status, 201);
  assert.equal((await worker.call('POST', `/gigs/${gig.id}/ratings`, { on_time: 1, quality: 1, easy: 1, again: 1 })).status, 409);
  assert.equal((await poster.call('POST', `/gigs/${gig.id}/ratings`, { on_time: 4, quality: 5, easy: 5, again: 5 })).status, 201);
  assert.equal((await other.call('POST', `/gigs/${gig.id}/ratings`, { on_time: 1, quality: 1, easy: 1, again: 1 })).status, 403);

  const pw = await app.call('GET', `/people/${poster.handle}/work`);
  assert.equal(pw.body.ratings.count, 1);
  assert.equal(pw.body.ratings.quality, 4);
  assert.equal(pw.body.gigs_posted, 1);
  assert.equal(pw.body.paid_on_time_share, 1);
  assert.ok(pw.body.as_of);
  const ww = await app.call('GET', `/people/${worker.handle}/work`);
  assert.equal(ww.body.gigs_done, 1);
  assert.equal(ww.body.ratings.on_time, 4);
  assert.equal(ww.body.paid_on_time_share, null);
  assert.equal((await app.call('GET', '/people/no.such.person/work')).status, 404);

  // status: poster only
  assert.equal((await worker.call('PATCH', `/gigs/${gig.id}`, { status: 'closed' })).status, 403);
  const closed = await poster.call('PATCH', `/gigs/${gig.id}`, { status: 'closed' });
  assert.equal(closed.body.gig.status, 'closed');
  assert.equal((await app.call('GET', '/gigs')).body.gigs.some((g: any) => g.id === gig.id), false, 'closed gigs leave Newest');
  assert.equal((await stranger.call('POST', `/gigs/${gig.id}/applications`, { note: 'late' })).status, 409);
});

test('for you ranking: pure, published weights', () => {
  const v = { barangay_code: 'B1', city_code: 'C1', region_code: 'R1' };
  assert.equal(nearSignal(v, { barangay_code: 'B1', city_code: 'C1', region_code: 'R1' }), 1);
  assert.equal(nearSignal(v, { barangay_code: 'B2', city_code: 'C1', region_code: 'R1' }), 0.5);
  assert.equal(nearSignal(v, { barangay_code: null, city_code: 'C2', region_code: 'R1' }), 0.25);
  assert.equal(nearSignal(null, v), 0);
  assert.equal(trustSignal(0, null), 0);
  assert.equal(trustSignal(3, 5), 0.5);
  const now = new Date('2026-10-19T00:00:00Z');
  assert.equal(freshSignal(now, now), 1);
  assert.equal(freshSignal(new Date('2026-10-18T00:00:00Z'), now), 0.5);
  assert.equal(gigScore({ near: 1, trade: 1, trust: 1, fresh: 1 }), GIG_WEIGHTS.near + GIG_WEIGHTS.trade + GIG_WEIGHTS.trust + GIG_WEIGHTS.fresh);
});
