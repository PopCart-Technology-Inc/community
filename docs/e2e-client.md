# End-to-end encryption in the web app

How the browser encrypts direct messages and private Space messages (decision [0001](decisions/0001-hold-keys-not-data.md), point 4). The server stores only the envelopes below and checks their shape and size; it can never read them. The code is `app/web/static/lib/e2e.js` (algorithm) and `app/web/static/lib/keystore.js` (key storage). If `docs/e2e.md` (the server side) and this file ever disagree, fix one of them in the same pull request.

Everything uses WebCrypto only. No library.

## Identity key

- On first use of messages, the browser makes an **ECDH P-256** key pair: `generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable: false, ['deriveBits'])`.
- The **private key is non-extractable** and is stored as a `CryptoKey` in IndexedDB (database `community-keys`, store `identity`, key = the person's user id). The raw key can never be read back out, not even by the app.
- The **public key** is published as a JWK with only `{ kty: "EC", crv: "P-256", x, y }` via `PATCH /me { dm_public_key }`.
- A new device (or cleared browser storage) makes a new key pair and publishes it. Messages sealed for the old key cannot be read on the new device, and the app says so plainly.

## Direct messages

```
bits  = ECDH(my private key, their public key)                  256 bits
key   = HKDF-SHA-256(bits, salt = UTF-8("dm:" + conversation id),
                     info = UTF-8("popcart-community/dm/v1"))    -> AES-GCM, 256-bit
iv    = 12 random bytes
ct    = AES-GCM-encrypt(key, iv, UTF-8(JSON.stringify({ "t": "<message text>" })))
send    { "sealed": { "v": 1, "iv": base64(iv), "ct": base64(ct) } }
```

- Both people derive the same key, so the sender can also read their own messages.
- `iv` and `ct` are **standard base64 with padding** (RFC 4648 section 4), not base64url. `ct` includes the 16-byte GCM tag.
- The key is per conversation (the conversation id is the HKDF salt).
- The plaintext is a JSON object so fields can be added later (for example media ids). Readers must ignore unknown fields.

## Private Space messages

One random key per message, wrapped for every member:

```
K     = random AES-GCM-256 key
iv,ct = as above, encrypting {"t": text} under K
eph   = a fresh ECDH P-256 key pair for this message (private part never leaves memory)
for each member m (including the sender):
  wk_m  = HKDF-SHA-256(ECDH(eph private, m's public key),
                       salt = UTF-8("space:" + channel id),
                       info = UTF-8("popcart-community/space-key/v1"))   -> AES-GCM-256
  wiv_m = 12 random bytes
  keys[m.user_id] = base64(wiv_m || AES-GCM-encrypt(wk_m, wiv_m, raw K))
send  { "sealed": { "v": 1, "iv", "ct", "epk": <eph public JWK>, "keys": { "<user id>": "<base64>" } } }
```

A member opens it with `ECDH(own private key, epk)`, unwraps `K`, then decrypts `ct`. Members without a published key cannot be included; the sender is told how many.

The client needs each member's public key. It reads `dm_public_key` from the members list (`GET /spaces/:slug/members`, on `person` or next to it).

## Reporting

Moderators cannot read messages. When someone reports a conversation, their own browser decrypts it and they tick which messages to reveal; only those go in `POST /reports { revealed: [{ id, text, created_at }] }`.

## Not covered yet

- Forward secrecy and key rotation: one long-lived identity key per device. A move to MLS (RFC 9420) is a later decision.
- Several devices per person: the latest device's key is the one published.
