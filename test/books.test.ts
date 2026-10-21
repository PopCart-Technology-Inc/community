// Open Books (decision 0009) end to end over HTTP: trustees and keys, drafts, the signing rules,
// sealing, reversals, anchors and their proofs, the bank match, and the full check run both by the
// server and by the browser's separate copy of the maths. Every amount and name here is a test fixture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { merkleRoot, verifyLedger as serverVerify } from '../app/modules/books/ledger.ts';
import { OTS_MAGIC } from '../app/modules/books/routes.ts';
import { startApp, type Person, type TestApp } from './helpers.ts';

const lib: any = await import(pathToFileURL(join(import.meta.dirname, '..', 'app', 'web', 'static', 'lib', 'ledger.js')).href);

let app: TestApp;
let staff: Person, a: Person, b: Person, c: Person, member: Person;
const keys = new Map<string, { privateKey: CryptoKey; publicJwk: unknown; keyId: string }>();
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

before(async () => {
  app = await startApp();
  staff = await app.person({ role: 'staff', handle: 'test.staff' });
  [a, b, c] = [await app.person({ handle: 'test.trustee.a' }), await app.person({ handle: 'test.trustee.b' }), await app.person({ handle: 'test.trustee.c' })];
  member = await app.person({ handle: 'test.member' });
});
after(async () => { await app.close(); });

async function makeTrustee(p: Person) {
  assert.equal((await staff.call('POST', '/books/trustees', { handle: '@' + p.handle })).status, 201);
  const k = await lib.newSigningKey();
  const r = await p.call('PUT', '/books/key', { public_key: k.publicJwk });
  assert.equal(r.status, 201);
  assert.equal(r.body.key.key_id, k.keyId, 'server and browser agree on the key id');
  keys.set(p.id, k);
}

async function sign(p: Person, draftId: string) {
  const d = (await app.call('GET', '/books/drafts')).body.drafts.find((x: any) => x.id === draftId);
  const k = keys.get(p.id)!;
  return p.call('POST', `/books/drafts/${draftId}/sign`, { key_id: k.keyId, sig: await lib.signBody(k.privateKey, d.body) });
}

const draft = (p: Person, body: Record<string, unknown>) => p.call('POST', '/books/drafts', { date: today, description: 'Test entry', ...body });

test('empty books say so: zero everywhere, nothing made up, and the check passes', async () => {
  const r = await app.call('GET', '/books');
  assert.equal(r.status, 200);
  assert.equal(r.body.entries, 0);
  assert.equal(r.body.balance, 0);
  assert.equal(r.body.months.length, 12);
  assert.ok(r.body.months.every((m: any) => m.in === 0 && m.out === 0));
  assert.equal(r.body.rule.two_sig_over, 2000000, '₱20,000 to start');
  assert.ok(r.body.as_of);
  const v = await app.call('GET', '/books/verify');
  assert.equal(v.body.ok, true);
  assert.equal((await app.call('GET', '/books/ledger')).body.entries.length, 0);
});

test('trustees: staff appoint them in public; keys are public halves only', async () => {
  assert.equal((await member.call('POST', '/books/trustees', { handle: a.handle })).status, 403);
  assert.equal((await staff.call('POST', '/books/trustees', { handle: 'nobody.here' })).status, 404);
  assert.equal((await a.call('PUT', '/books/key', { public_key: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } })).status, 403, 'not a trustee yet');
  for (const p of [a, b, c]) await makeTrustee(p);
  assert.equal((await staff.call('POST', '/books/trustees', { handle: a.handle })).status, 409);
  const k = keys.get(a.id)!;
  assert.equal((await a.call('PUT', '/books/key', { public_key: { ...(k.publicJwk as object), d: 'secret' } })).status, 400, 'a private key is refused');
  assert.equal((await a.call('PUT', '/books/key', { public_key: k.publicJwk })).status, 409, 'a key is published once');
  const t = await app.call('GET', '/books/trustees');
  assert.equal(t.body.trustees.length, 3);
  assert.ok(t.body.trustees.every((x: any) => x.appointed_by === 'test.staff' && /^[0-9a-f]{16}$/.test(x.key_id)));
  const me = await a.call('GET', '/books/me');
  assert.equal(me.body.trustee, true);
  assert.equal(me.body.key.key_id, k.keyId);
  assert.equal((await member.call('GET', '/books/me')).body.can_draft, false);
});

let donation = 0, payment = 0;

test('drafts: who may draft, what is checked, and the balance never goes below zero', async () => {
  assert.equal((await draft(member, { kind: 'in', amount: 100, category: 'donations', party: { kind: 'donors' } })).status, 403);
  assert.equal((await app.call('POST', '/books/drafts', {})).status, 401);
  const bads: Record<string, unknown>[] = [
    { kind: 'out', amount: 100, category: 'hosting', party: { kind: 'donors' } },
    { kind: 'in', amount: 0, category: 'popcart', party: { kind: 'donors' } },
    { kind: 'in', amount: 1.5, category: 'popcart', party: { kind: 'donors' } },
    // while PopCart holds the fund, money in is from PopCart only (decision 0009, point 9)
    { kind: 'in', amount: 100, category: 'donations', party: { kind: 'donors' } },
    { kind: 'in', amount: 100, category: 'grants', party: { kind: 'company', name: 'Test Grant Fund' } },
    { kind: 'out', amount: 100, category: 'popcart', party: { kind: 'company', name: 'Test Hosting Co.' } },
    { kind: 'in', amount: 100, category: 'snacks', party: { kind: 'donors' } },
    { kind: 'out', amount: 100, category: 'builders', party: { kind: 'person_private', ref: 'Juan' } },
    { kind: 'out', amount: 100, category: 'builders', party: { kind: 'related_party', name: 'Test Related Co.' } },
    { kind: 'in', amount: 100, category: 'popcart', party: { kind: 'donors' }, date: '2099-01-01' },
    { kind: 'in', amount: 100, category: 'popcart', party: { kind: 'donors' }, evidence: [{ name: 'x', sha256: 'nothex' }] },
  ];
  for (const x of bads) assert.equal((await draft(staff, x)).status, 400, JSON.stringify(x));
  assert.equal((await draft(staff, { kind: 'out', amount: 100, category: 'hosting', party: { kind: 'company', name: 'Test Hosting Co.' } })).status, 409, 'nothing to pay with yet');

  const d = await draft(staff, { kind: 'in', amount: 1500000, category: 'popcart', party: { kind: 'company', name: 'Test Funder Co.' }, description: 'Test funding, week 1',
    evidence: [{ name: 'test-deposit-slip.pdf', sha256: 'a'.repeat(64) }] });
  assert.equal(d.status, 201);
  assert.equal(d.body.draft.needs, 1, 'up to the limit: one signature');
  assert.equal(d.body.draft.body.drafted_by, 'test.staff');
  donation = 1;
  const s = await sign(a, d.body.draft.id);
  assert.equal(s.status, 201);
  assert.equal(s.body.sealed.seq, 1);
  assert.equal((await app.call('GET', '/books')).body.balance, 1500000);
});

test('signing rules: never your own draft, never with a conflict, a bad signature is refused, big ones need two', async () => {
  const d = await draft(a, { kind: 'out', amount: 500000, category: 'hosting', party: { kind: 'company', name: 'Test Hosting Co.' }, assisted: true });
  assert.equal(d.status, 201);
  const id = d.body.draft.id;
  assert.equal((await sign(a, id)).status, 403, 'not your own draft');
  assert.equal((await member.call('POST', `/books/drafts/${id}/sign`, { key_id: 'x', sig: 'y' })).status, 403);
  const kb = keys.get(b.id)!;
  assert.equal((await b.call('POST', `/books/drafts/${id}/sign`, { key_id: kb.keyId, sig: await lib.signBody(kb.privateKey, { other: 'body' }) })).status, 400, 'a signature over something else');
  assert.equal((await b.call('POST', `/books/drafts/${id}/sign`, { key_id: keys.get(c.id)!.keyId, sig: 'x' })).status, 409, 'not your key');
  const s = await sign(b, id);
  assert.equal(s.status, 201);
  payment = s.body.sealed.seq;
  assert.equal(payment, 2);

  // over the limit: two signatures
  const big = await draft(staff, { kind: 'in', amount: 2500000, category: 'popcart', party: { kind: 'company', name: 'Test Funder Co.' } });
  assert.equal(big.body.draft.needs, 2);
  const first = await sign(a, big.body.draft.id);
  assert.equal(first.status, 200);
  assert.equal(first.body.draft.signatures.length, 1, 'still a draft after one');
  assert.equal((await sign(a, big.body.draft.id)).status, 409, 'not twice');
  assert.equal((await sign(b, big.body.draft.id)).status, 201);

  // a related party: two signatures, the reason in public, and a conflicted trustee cannot sign
  const rp = await draft(a, { kind: 'out', amount: 100000, category: 'builders', party: { kind: 'related_party', name: 'Test Related Co.' }, related_note: 'Two outside quotes were higher (test fixture).' });
  assert.equal(rp.body.draft.needs, 2);
  assert.equal((await b.call('POST', `/books/drafts/${rp.body.draft.id}/conflict`, { note: 'test: I know the owner' })).status, 200);
  assert.equal((await sign(b, rp.body.draft.id)).status, 403);
  assert.equal((await sign(c, rp.body.draft.id)).status, 200);
  assert.equal((await staff.call('POST', `/books/drafts/${rp.body.draft.id}/seal`)).status, 409, 'one signature is not enough');
  const drafts = (await app.call('GET', '/books/drafts')).body.drafts;
  assert.deepEqual(drafts.find((x: any) => x.id === rp.body.draft.id).conflicts, [{ handle: 'test.trustee.b', note: 'test: I know the owner' }], 'conflicts are public');
  assert.equal((await member.call('DELETE', `/books/drafts/${rp.body.draft.id}`)).status, 403);
  assert.equal((await a.call('DELETE', `/books/drafts/${rp.body.draft.id}`)).status, 204, 'the drafter can withdraw it');
});

test('corrections are reversing entries, never edits; the database refuses changes', async () => {
  const d = await draft(c, { reverses: payment, description: 'Test: invoice was for the wrong amount' });
  assert.equal(d.status, 201);
  assert.equal(d.body.draft.body.kind, 'in');
  assert.equal(d.body.draft.body.amount, 500000);
  assert.equal(d.body.draft.body.party.name, 'Test Hosting Co.');
  assert.equal((await sign(a, d.body.draft.id)).status, 201);
  assert.equal((await draft(c, { reverses: payment })).status, 409, 'reversed once only');
  const e = await app.call('GET', `/books/entries/${payment}`);
  assert.equal(e.body.entry.reversed_by, 4);
  assert.equal(e.body.recomputed_hash, e.body.entry.hash);
  const payees = (await app.call('GET', '/books/payees')).body;
  assert.equal(payees.paid.find((p: any) => p.name === 'Test Hosting Co.'), undefined, 'a reversed payment nets to nothing');
  assert.equal(payees.funders.find((p: any) => p.name === 'Test Funder Co.').amount, 4000000);
  await assert.rejects(app.db.query(`UPDATE books_entries SET entry = jsonb_set(entry, '{body,amount}', '1') WHERE seq = 1`), /append-only/);
  await assert.rejects(app.db.query('DELETE FROM books_entries WHERE seq = 1'), /append-only/);
  await assert.rejects(app.db.query('UPDATE books_rules SET two_sig_over = 0'), /append-only/);
});

test('anchors: a Merkle root of every entry, a proof attached once, and it covers that root', async () => {
  assert.equal((await member.call('POST', '/books/anchors')).status, 403);
  const r = await a.call('POST', '/books/anchors');
  assert.equal(r.status, 201);
  const led = (await app.call('GET', '/books/ledger')).body;
  assert.equal(r.body.anchor.root, merkleRoot(led.entries.map((e: any) => e.hash)));
  assert.equal(r.body.anchor.root, await lib.merkleRoot(led.entries.map((e: any) => e.hash)), 'the browser gets the same root');
  assert.equal((await a.call('POST', '/books/anchors')).status, 409, 'nothing new to anchor');
  const id = r.body.anchor.id;
  assert.equal((await app.call('GET', `/books/anchors/${id}/proof`)).status, 404);
  const wrong = Buffer.concat([OTS_MAGIC, Buffer.from([1, 8]), Buffer.alloc(32), Buffer.from([0xf0, 0x10])]);
  assert.equal((await a.call('PUT', `/books/anchors/${id}/proof`, { ots: wrong.toString('base64') })).status, 400, 'a proof of some other digest');
  const ots = Buffer.concat([OTS_MAGIC, Buffer.from([1, 8]), Buffer.from(r.body.anchor.root, 'hex'), Buffer.from([0xf0, 0x10, 1, 2, 3])]);
  assert.equal((await a.call('PUT', `/books/anchors/${id}/proof`, { ots: ots.toString('base64') })).status, 200);
  assert.equal((await a.call('PUT', `/books/anchors/${id}/proof`, { ots: ots.toString('base64') })).status, 409);
  const got = await fetch(app.base + `/api/books/anchors/${id}/proof`);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), ots);
  assert.equal((await app.call('GET', '/books')).body.anchor.stamped, true);
});

test('the full check passes on the server and in the browser, and catches any change', async () => {
  const v = await app.call('GET', '/books/verify');
  assert.equal(v.body.ok, true, JSON.stringify(v.body.problems));
  assert.equal(v.body.entries, 4);
  const file = (await app.call('GET', '/books/ledger')).body;
  assert.equal(file.format, 'popcart-community/open-books/v1');
  const mine = await lib.verifyLedger(file);
  assert.equal(mine.ok, true, JSON.stringify(mine.problems));
  assert.equal(mine.balance, (await app.call('GET', '/books')).body.balance);

  const tampered = structuredClone(file);
  tampered.entries[0].body.amount = 9900000;
  const t = await lib.verifyLedger(tampered);
  assert.equal(t.ok, false);
  assert.ok(t.problems.some((p: any) => p.seq === 1 && p.check === 'hash'));
  assert.ok(t.problems.some((p: any) => p.check === 'signature'), 'the signature no longer checks');
  assert.ok(t.problems.some((p: any) => p.check === 'anchor'), 'the anchor no longer matches');
  assert.equal((await serverVerify(tampered)).ok, false, 'the server copy agrees');

  const dropped = structuredClone(file);
  dropped.entries.splice(1, 1);
  assert.ok((await lib.verifyLedger(dropped)).problems.some((p: any) => p.check === 'link' || p.check === 'order'), 'a removed entry shows');
});

test('bank match: the ledger balance on the statement date, matched or not', async () => {
  const r = await b.call('POST', '/books/reconciliations', { statement_date: today, bank_balance: 4000000, statement_sha256: 'b'.repeat(64) });
  assert.equal(r.status, 201);
  assert.equal(r.body.reconciliation.ledger_balance, 4000000);
  assert.equal(r.body.reconciliation.matched, true);
  const off = await b.call('POST', '/books/reconciliations', { statement_date: today, bank_balance: 3999000 });
  assert.equal(off.body.reconciliation.matched, false);
  assert.equal((await member.call('POST', '/books/reconciliations', { statement_date: today, bank_balance: 1 })).status, 403);
  assert.equal((await app.call('GET', '/books/reconciliations')).body.reconciliations.length, 2);
});

test('rules and budgets: staff only, every change kept in public', async () => {
  assert.equal((await a.call('PUT', '/books/rule', { two_sig_over: 0 })).status, 403);
  assert.equal((await staff.call('PUT', '/books/rule', { two_sig_over: 1000000 })).status, 200);
  assert.equal((await app.call('GET', '/books')).body.rule.two_sig_over, 1000000);
  assert.equal((await app.call('GET', '/books/ledger')).body.rules.length, 2, 'the old rule stays published');
  const year = Number(today.slice(0, 4));
  assert.equal((await staff.call('POST', '/books/budgets', { year, category: 'hosting', amount: 6000000 })).status, 201);
  const bu = await staff.call('POST', '/books/budgets', { year, category: 'hosting', amount: 7000000 });
  assert.deepEqual(bu.body.budgets.items.map((x: any) => x.amount), [7000000]);
  assert.equal((await a.call('POST', '/books/budgets', { year, category: 'hosting', amount: 1 })).status, 403);
});

test('ending a trustee retires their key; their waiting signatures stop counting; old entries still check', async () => {
  const d = await draft(staff, { kind: 'out', amount: 1200000, category: 'builders', party: { kind: 'person_private', ref: 'C-0001' } });
  assert.equal(d.body.draft.needs, 2, 'over the new limit');
  await sign(c, d.body.draft.id);
  assert.equal((await member.call('DELETE', `/books/trustees/${c.handle}`)).status, 403);
  assert.equal((await staff.call('DELETE', `/books/trustees/${c.handle}`)).status, 204);
  assert.equal((await sign(c, d.body.draft.id)).status, 403);
  const left = (await app.call('GET', '/books/drafts')).body.drafts.find((x: any) => x.id === d.body.draft.id);
  assert.equal(left.signatures.length, 0);
  await sign(a, d.body.draft.id);
  assert.equal((await sign(b, d.body.draft.id)).status, 201);
  const v = await lib.verifyLedger((await app.call('GET', '/books/ledger')).body);
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  const paid = (await app.call('GET', '/books/payees')).body.paid;
  assert.deepEqual(paid.map((p: any) => [p.kind, p.name]), [['person_private', 'C-0001']], 'a private person shows by ID only');
  const t = (await app.call('GET', '/books/trustees')).body.trustees.find((x: any) => x.handle === c.handle);
  assert.ok(t.ended_at);
});

test('money helpers in the browser', () => {
  assert.equal(lib.toCentavos('12,345.5'), 1234550);
  assert.equal(lib.toCentavos('₱ 1,000'), 100000);
  assert.equal(lib.toCentavos('1.234'), null);
  assert.equal(lib.toCentavos('0'), null);
  assert.equal(lib.toCentavos('abc'), null);
  assert.equal(lib.peso(1234550), '₱12,345.50');
  assert.equal(lib.peso(100000), '₱1,000');
  assert.equal(lib.peso(-50), '−₱0.50');
  assert.equal(lib.pesoShort(150000000), '₱1.5M');
  assert.equal(lib.pesoShort(3500000), '₱35k');
});
