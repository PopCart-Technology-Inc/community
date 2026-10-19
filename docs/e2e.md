# End-to-end encryption for messages

Decision [0001](decisions/0001-hold-keys-not-data.md), point 4: **private means end-to-end encrypted.** Direct messages and messages in private Spaces are encrypted in the browser. The server stores an envelope it cannot read and refuses plaintext (`400 sealed_only`). It only checks the envelope's shape and size (`checkSealed` in `app/modules/spaces/routes.ts`).

Everything here uses the browser's WebCrypto (`crypto.subtle`). No other crypto library is needed.

## Encoding

- **base64** below means standard base64 (RFC 4648 section 4, alphabet `A-Z a-z 0-9 + /`) **with** `=` padding. base64url, missing padding or whitespace are refused.
- Text is UTF-8.
- The plaintext of every message is the UTF-8 JSON `{"body": "<text>"}`. Later versions may add fields. Readers ignore fields they do not know.

## Your key pair

1. On first use, the browser makes an ECDH P-256 key pair:
   `crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits'])`. The private key is **not extractable**.
2. It keeps the `CryptoKeyPair` in IndexedDB. The private key never leaves the device.
3. It publishes the public key as a JWK: `PATCH /api/me { dm_public_key: { kty: 'EC', crv: 'P-256', x, y } }`. The server refuses any JWK that has `d`.

Other people's public keys come with the API responses that need them, as `dm_public_key` (JWK or `null`):
- `other.dm_public_key` in `GET /conversations` and `POST /conversations`;
- `author.dm_public_key` on channel messages;
- `person.dm_public_key` in `GET /spaces/:slug/members`.

If a person has no key yet (`null`), you cannot write to them in private. Show "They have not set up private messages yet".

## Deriving a pairwise key

`pairKey(myPrivate, theirPublicJwk, info, usage)`:

1. `bits = crypto.subtle.deriveBits({ name: 'ECDH', public: theirPublic }, myPrivate, 256)`.
2. `hkdf = crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])`.
3. `crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) }, hkdf, usage, false, usages)`.

ECDH is symmetric: both people get the same key.

## Direct messages

Envelope: **`sealed = { v: 1, iv, ct }`**. No other fields are accepted.

| Field | Content | Checked by the server |
|---|---|---|
| `v` | `1` | must be exactly 1 |
| `iv` | base64 of 12 random bytes | decodes to exactly 12 bytes |
| `ct` | base64 of the AES-GCM output (ciphertext and its 16-byte tag) | decodes to 17 to 8192 bytes |

To send to conversation `C` as sender `S`:
1. `key = pairKey(myPrivate, other.dm_public_key, 'popcart-community dm v1 ' + C, { name: 'AES-GCM', length: 256 })` with usages `['encrypt', 'decrypt']`.
2. `iv = crypto.getRandomValues(new Uint8Array(12))`. Never reuse an IV.
3. `ct = crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(C + ':' + S) }, key, utf8(JSON.stringify({ body })))`.
4. `POST /api/conversations/C/messages { sealed: { v: 1, iv: b64(iv), ct: b64(ct) } }`. The body must contain **only** `sealed`.

To read, derive the same key and decrypt with `additionalData = utf8(C + ':' + sender_id)`. The sender reads their own messages with the same key.

The plaintext can be at most 8176 bytes (8192 minus the 16-byte tag).

## Private Space messages

Envelope: **`sealed = { v: 1, iv, ct, keys }`**.

| Field | Content | Checked by the server |
|---|---|---|
| `v`, `iv`, `ct` | as for DMs | as for DMs |
| `keys` | `{ "<member user id>": base64 wrapped message key }` | 1 to 1000 entries; every id is a **current member** of the Space; the **sender's own id is included**; each value decodes to 1 to 512 bytes |

To send to channel `H` of Space `P` (its `space.id`) as sender `S`:
1. Make a fresh message key: `K = crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])`.
2. `iv` = 12 random bytes. `ct = AES-GCM(K, iv, plaintext, additionalData = utf8(H + ':' + S))`.
3. For every member `M` (page through `GET /spaces/:slug/members`, including yourself) who has a `dm_public_key`:
   - `W = pairKey(myPrivate, M.dm_public_key, 'popcart-community space v1 ' + P, { name: 'AES-KW', length: 256 })` with usages `['wrapKey', 'unwrapKey']`;
   - `keys[M.id] = b64(crypto.subtle.wrapKey('raw', K, W, 'AES-KW'))` (40 bytes).
   For yourself, use your own public key: ECDH with your own key pair works.
4. `POST /api/channels/H/messages { sealed: { v: 1, iv, ct, keys } }`. The body must contain **only** `sealed`.

To read, take `sealed.keys[myId]` (the API returns only your own entry), derive `W` with the **author's** `dm_public_key`, run `crypto.subtle.unwrapKey('raw', wrapped, W, 'AES-KW', 'AES-GCM', false, ['decrypt'])`, then decrypt with `additionalData = utf8(H + ':' + author.id)`.

A member who joins later has no key for older messages, and cannot read them. That is by design.

Public Spaces are public: they accept only `{ body }` in plaintext, and refuse `sealed` (`400 plaintext_only`).

## Limits of version 1

- **No key rotation yet.** If a person makes a new key pair (a new device, or cleared site data), messages sealed to the old key cannot be read on the new one. The same applies if an author changes key: older Space messages they wrote cannot be unwrapped. A later version will add device keys and a sender key id in the envelope.
- **The server sees metadata:** who talks to whom, when, in which Space, and the size of each message. It never sees the content.
- **Request size:** a request body is at most 64 KB, so a private Space message reaches about 500 members with 40-byte wrapped keys.
