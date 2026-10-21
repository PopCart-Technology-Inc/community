// Open Books in the browser (decision 0009): check the whole ledger here, without trusting the server,
// and keep a trustee's signing key. A second copy of app/modules/books/ledger.ts, written separately on
// purpose; the tests check that the two agree. Pure apart from the key store, so tests can import it.
import { bytesToB64url, b64urlToBytes, utf8 } from './b64.js';

export const GENESIS = '0'.repeat(64);

/** Canonical JSON: object keys sorted at every level, no spaces, whole numbers only. */
export function canon(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('canon: only whole numbers');
    return String(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  throw new Error('canon: unsupported value');
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)));

export async function sha256hex(data) {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? utf8(data) : data));
}

export const keyId = async (jwk) => (await sha256hex(canon({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }))).slice(0, 16);

export const need = (b) => (b.party.kind === 'related_party' || b.amount > b.two_sig_over ? 2 : 1);
export const signedAmount = (b) => (b.kind === 'in' ? b.amount : -b.amount);
export const entryHash = (e) => sha256hex(canon({ seq: e.seq, prev: e.prev, sealed_at: e.sealed_at, body: e.body, sigs: e.sigs, conflicted: e.conflicted }));

export async function verifySig(jwk, body, sig) {
  if (typeof sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlToBytes(sig), utf8(canon(body)));
  } catch { return false; }
}

/** Merkle root over entry hashes: pairs of 32-byte values joined and hashed; an odd last one pairs with itself. */
export async function merkleRoot(hashes) {
  if (!hashes.length) return GENESIS;
  let level = hashes.map(unhex);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i], b = level[i + 1] || a;
      const joined = new Uint8Array(64); joined.set(a, 0); joined.set(b, 32);
      next.push(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)));
    }
    level = next;
  }
  return hex(level[0]);
}

/**
 * Check a downloaded ledger: links, hashes, signatures against keys live at sealing, the signing rules,
 * the balance never below zero, reversals and anchors. Returns { ok, entries, anchors, balance, problems }.
 */
export async function verifyLedger(file, onProgress) {
  const problems = [];
  const keys = new Map((file.keys || []).map((k) => [k.key_id, k]));
  const hashes = [], reversed = new Set(), bySeq = new Map();
  let prev = GENESIS, balance = 0;
  const entries = file.entries || [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], seq = i + 1;
    const p = (check, detail) => problems.push({ seq, check, detail });
    if (e.seq !== seq) p('order', `expected entry ${seq}, found ${e.seq}`);
    if (e.prev !== prev) p('link', 'does not point at the entry before it');
    const real = await entryHash(e);
    if (real !== e.hash) p('hash', 'its contents do not match its hash');
    hashes.push(real);
    prev = e.hash;
    const signers = new Set();
    for (const s of e.sigs || []) {
      const k = keys.get(s.key_id);
      if (!k) { p('signature', `unknown key ${s.key_id}`); continue; }
      const t = Date.parse(e.sealed_at);
      if (Date.parse(k.created_at) > t || (k.retired_at && Date.parse(k.retired_at) <= t)) p('signature', `key ${s.key_id} was not live when this was sealed`);
      if (await keyId(k.public_key) !== k.key_id) p('signature', `key ${s.key_id} does not match its id`);
      if (!(await verifySig(k.public_key, e.body, s.sig))) p('signature', `signature by @${k.handle} does not check`);
      if (k.handle === e.body.drafted_by) p('rule', `@${k.handle} signed their own draft`);
      if ((e.conflicted || []).includes(k.handle)) p('rule', `@${k.handle} signed despite a declared conflict`);
      if (signers.has(k.handle)) p('rule', `@${k.handle} signed twice`);
      signers.add(k.handle);
    }
    if (signers.size < need(e.body)) p('rule', `needs ${need(e.body)} signatures, has ${signers.size}`);
    if (e.body.reverses !== undefined) {
      const o = bySeq.get(e.body.reverses);
      if (!o) p('rule', `reverses entry ${e.body.reverses}, which is not before it`);
      else if (o.body.kind === e.body.kind || o.body.amount !== e.body.amount) p('rule', `does not exactly undo entry ${e.body.reverses}`);
      else if (reversed.has(e.body.reverses)) p('rule', `entry ${e.body.reverses} was already reversed`);
      reversed.add(e.body.reverses);
    }
    balance += signedAmount(e.body);
    if (balance < 0) p('balance', 'takes the balance below zero');
    bySeq.set(seq, e);
    if (onProgress) onProgress(seq, entries.length);
  }
  for (const a of file.anchors || []) {
    if (a.upto_seq < 1 || a.upto_seq > hashes.length) { problems.push({ anchor: a.id, check: 'anchor', detail: 'covers entries that do not exist' }); continue; }
    if (await merkleRoot(hashes.slice(0, a.upto_seq)) !== a.root) problems.push({ anchor: a.id, check: 'anchor', detail: `entries 1-${a.upto_seq} no longer match this anchor` });
  }
  return { ok: problems.length === 0, entries: entries.length, anchors: (file.anchors || []).length, balance, problems };
}

/* ---------- a trustee's signing key, kept in this browser ---------- */

/** A new ECDSA P-256 key pair. The private key is not extractable: it can sign, never be read out. */
export async function newSigningKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  return { privateKey: pair.privateKey, publicJwk, keyId: await keyId(publicJwk) };
}

export async function signBody(privateKey, body) {
  return bytesToB64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8(canon(body)))));
}

const DB = 'community-books-keys', STORE = 'signing';

function open() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error || new Error('IndexedDB is not available'));
  });
}

function tx(mode, fn) {
  return open().then((d) => new Promise((ok, fail) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); ok(req && req.result); };
    t.onerror = () => { d.close(); fail(t.error); };
  }));
}

/** This browser's signing key for a person: { privateKey, publicJwk, keyId } or undefined. */
export const loadSigningKey = (userId) => tx('readonly', (s) => s.get(userId));
export const saveSigningKey = (userId, k) => tx('readwrite', (s) => s.put(k, userId));

/** Hash a file in the browser. Receipts never leave the device: only this hash is stored. */
export async function hashFile(file) {
  return sha256hex(new Uint8Array(await file.arrayBuffer()));
}

/* ---------- money ---------- */

/** "12,345.50" or "12345.5" to centavos, or null when it is not an amount. */
export function toCentavos(text) {
  const s = String(text || '').replace(/[₱,\s]/g, '');
  if (!/^\d{1,10}(\.\d{0,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const c = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return c > 0 ? c : null;
}

/** Centavos to "₱12,345.50" (no decimals when whole, unless `exact`). */
export function peso(c, exact = false) {
  const neg = c < 0, a = Math.abs(Math.round(c));
  const whole = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = a % 100;
  return (neg ? '−' : '') + '₱' + whole + (exact || cents ? '.' + String(cents).padStart(2, '0') : '');
}

/** Short form for chart axes: ₱1.2M, ₱35k. */
export function pesoShort(c) {
  const p = Math.abs(c) / 100;
  const s = p >= 1e6 ? (p / 1e6).toFixed(p >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : p >= 1e3 ? (p / 1e3).toFixed(p >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(p));
  return (c < 0 ? '−' : '') + '₱' + s;
}
