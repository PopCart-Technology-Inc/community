// End-to-end encryption for messages, with WebCrypto only (decision 0001, point 4).
// The algorithm is described in docs/e2e-client.md; keep the two in step.
//
//   identity      ECDH P-256 key pair per browser; the private key is non-extractable and never leaves it
//   DM key        ECDH(my private, their public) -> 256 bits -> HKDF-SHA-256(salt "dm:<conversation id>",
//                 info "popcart-community/dm/v1") -> AES-GCM-256
//   DM message    { v: 1, iv, ct }  iv = 12 random bytes, ct = AES-GCM(JSON {"t": text}); standard base64
//   Space message { v: 1, iv, ct, epk, keys: { <user id>: base64(wiv || wct) } }: a random AES-GCM-256 key K
//                 encrypts the message; K is wrapped for every member under
//                 HKDF(ECDH(ephemeral private, member public), salt "space:<channel id>",
//                 info "popcart-community/space-key/v1"); epk is the ephemeral public JWK.
//
// No DOM here and nothing runs at import, so Node tests can use it with globalThis.crypto.subtle.
import { b64ToBytes, bytesToB64, concatBytes, fromUtf8, utf8 } from './b64.js';

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
export const DM_INFO = 'popcart-community/dm/v1';
export const SPACE_INFO = 'popcart-community/space-key/v1';
const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('This browser cannot encrypt messages (WebCrypto is missing)');
  return s;
};
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Only the public parts of a P-256 JWK, in a fixed shape. */
export function publicJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new TypeError('not a P-256 public key');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** A new identity: a non-extractable private key and its public JWK (to publish via PATCH /me). */
export async function generateIdentity() {
  const kp = await subtle().generateKey(ECDH, false, ['deriveBits']);
  const jwk = await subtle().exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, publicJwk: publicJwk(jwk) };
}

const importPublic = (jwk) => subtle().importKey('jwk', publicJwk(jwk), ECDH, false, []);

async function hkdfAesKey(privateKey, theirJwk, salt, info) {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: await importPublic(theirJwk) }, privateKey, 256);
  const base = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(salt), info: utf8(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** The AES key two people share for one conversation. Both sides derive the same key. */
export function deriveDmKey(myPrivateKey, theirPublicJwk, conversationId) {
  return hkdfAesKey(myPrivateKey, theirPublicJwk, 'dm:' + conversationId, DM_INFO);
}

/** Encrypt a message payload ({ t: text }) under a conversation key. */
export async function seal(key, payload) {
  const iv = random(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, utf8(JSON.stringify(payload)));
  return { v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

/** Decrypt a { v, iv, ct } envelope. Throws if it was changed or the key is wrong. */
export async function open(key, sealed) {
  checkEnvelope(sealed);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64ToBytes(sealed.iv) }, key, b64ToBytes(sealed.ct));
  return JSON.parse(fromUtf8(pt));
}

export function checkEnvelope(sealed) {
  if (!sealed || sealed.v !== 1 || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') throw new TypeError('not a v1 envelope');
  if (b64ToBytes(sealed.iv).length !== 12) throw new TypeError('iv must be 12 bytes');
}

/**
 * Encrypt one message for every member of a private Space channel.
 * @param {object} payload       the message ({ t: text })
 * @param {{ id: string, jwk: object }[]} recipients  members with a published key (include yourself)
 * @param {string} channelId
 */
export async function sealForMembers(payload, recipients, channelId) {
  const k = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = new Uint8Array(await subtle().exportKey('raw', k));
  const body = await seal(k, payload);
  const eph = await subtle().generateKey(ECDH, false, ['deriveBits']);
  const epk = publicJwk(await subtle().exportKey('jwk', eph.publicKey));
  const keys = {};
  for (const r of recipients) {
    const wk = await hkdfAesKey(eph.privateKey, r.jwk, 'space:' + channelId, SPACE_INFO);
    const wiv = random(12);
    const wct = await subtle().encrypt({ name: 'AES-GCM', iv: wiv }, wk, raw);
    keys[r.id] = bytesToB64(concatBytes(wiv, wct));
  }
  raw.fill(0);
  return { ...body, epk, keys };
}

/** Decrypt a Space message addressed to me. Throws when there is no key for me. */
export async function openForMember(sealed, myId, myPrivateKey, channelId) {
  checkEnvelope(sealed);
  const wrapped = sealed.keys && sealed.keys[myId];
  if (typeof wrapped !== 'string' || !sealed.epk) throw new Error('This message was not encrypted for you');
  const w = b64ToBytes(wrapped);
  const wk = await hkdfAesKey(myPrivateKey, sealed.epk, 'space:' + channelId, SPACE_INFO);
  const raw = await subtle().decrypt({ name: 'AES-GCM', iv: w.subarray(0, 12) }, wk, w.subarray(12));
  const k = await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  return open(k, sealed);
}
