// Base64 helpers with no dependencies. Standard base64 is used for encrypted message fields (iv, ct);
// base64url (no padding) is what WebAuthn uses. Works in browsers and in Node (atob/btoa are global).

/** @param {ArrayBuffer|ArrayBufferView} input */
export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('expected bytes');
}

/** Bytes to standard base64 (with padding). */
export function bytesToB64(input) {
  const b = toBytes(input);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
  return btoa(s);
}

/** Standard base64 (padding optional) to bytes. Throws on characters outside the alphabet. */
export function b64ToBytes(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(str)) throw new TypeError('not base64');
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes to base64url without padding. */
export function bytesToB64url(input) {
  return bytesToB64(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (padding optional) to bytes. */
export function b64urlToBytes(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(str)) throw new TypeError('not base64url');
  const s = str.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  return b64ToBytes(s + '='.repeat((4 - (s.length % 4)) % 4));
}

/** base64url to a fresh ArrayBuffer (what WebAuthn wants). */
export function b64urlToBuffer(str) {
  const b = b64urlToBytes(str);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

export const utf8 = (s) => new TextEncoder().encode(s);
export const fromUtf8 = (b) => new TextDecoder().decode(toBytes(b));

/** Join byte arrays. */
export function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + toBytes(p).length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { const b = toBytes(p); out.set(b, o); o += b.length; }
  return out;
}
