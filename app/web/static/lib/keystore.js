// The message identity kept in this browser's IndexedDB: a non-extractable ECDH private CryptoKey
// (structured-cloned, so the raw key can never be read back out) and its public JWK.
// One identity per person per browser, stored under the person's id.
import { generateIdentity, publicJwk } from './e2e.js';
import { patch } from './api.js';

const DB = 'community-keys', STORE = 'identity';

function db() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error || new Error('IndexedDB is not available'));
  });
}

function tx(mode, fn) {
  return db().then((d) => new Promise((ok, fail) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); ok(req && req.result); };
    t.onerror = () => { d.close(); fail(t.error); };
  }));
}

export const loadIdentity = (userId) => tx('readonly', (s) => s.get(userId));
const saveIdentity = (userId, idn) => tx('readwrite', (s) => s.put(idn, userId));

const sameKey = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;

/**
 * The identity for the signed-in person, made on first use. Publishes the public key when the server
 * does not have this browser's key yet. Returns { privateKey, publicJwk, fresh }.
 */
export async function ensureIdentity(me) {
  let idn = await loadIdentity(me.id);
  let fresh = false;
  if (!idn || !idn.privateKey) {
    idn = await generateIdentity();
    await saveIdentity(me.id, idn);
    fresh = true;
  }
  const published = me.dm_public_key ? (typeof me.dm_public_key === 'string' ? JSON.parse(me.dm_public_key) : me.dm_public_key) : null;
  if (!sameKey(published, idn.publicJwk)) {
    const r = await patch('/me', { dm_public_key: publicJwk(idn.publicJwk) });
    if (r && r.user) Object.assign(me, r.user);
  }
  return { ...idn, fresh };
}
