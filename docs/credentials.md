# Credentials: the format Community verifies

Decision [0001](decisions/0001-hold-keys-not-data.md), point 2: PopCart's closed apps never send records into Community. When a person asks, an issuer signs a W3C Verifiable Credential about them; the person brings it to Community (`POST /api/me/credentials { vc }`), and Community checks it and keeps only a short summary and its "as of" time. This page is the exact format, so an issuer can be built to match. The verifier is `app/modules/work/credentials.ts` (only `node:crypto`).

## Trusted issuers

The server reads the environment variable `CREDENTIAL_ISSUERS` once: a JSON object mapping an issuer id to that issuer's **public** JWK.

```json
{
  "https://issuer.example": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url public key>" },
  "https://other-issuer.example": { "kty": "EC", "crv": "P-256", "x": "<base64url>", "y": "<base64url>" }
}
```

(Example values; not real issuers.) An Ed25519 key means the issuer signs with `EdDSA`; a P-256 key means `ES256`. A JWK with a private part (`d`) is refused at start-up. An issuer that is not in the list is refused with `untrusted_issuer`.

## The credential

W3C VC Data Model 1.1, JSON (not JSON-LD processed):

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "DeliveryRecord"],
  "issuer": "https://issuer.example",
  "issuanceDate": "2026-10-14T08:00:00Z",
  "expirationDate": "2026-11-14T08:00:00Z",
  "credentialSubject": {
    "id": "community:@ana.rider",
    "summary": "Example: 1,240 deliveries · 97% on time",
    "asOf": "2026-10-14T08:00:00Z"
  },
  "proof": {
    "type": "DetachedJws",
    "created": "2026-10-14T08:00:00Z",
    "jws": "<base64url header>..<base64url signature>"
  }
}
```

| Field | Rule |
|---|---|
| `@context` | an array whose first entry is `https://www.w3.org/2018/credentials/v1` |
| `type` | an array with `VerifiableCredential` and exactly one other type, `^[A-Z][A-Za-z0-9]{1,40}$`. That type is what Community stores. `IdentityCheck` is the Level 2 ID check (decision 0001, point 3): it gives the person the verified tick and lets them post work. |
| `issuer` | a string, or an object with a string `id`; must be in `CREDENTIAL_ISSUERS` |
| `issuanceDate` | ISO 8601; not later than now (5 minutes of clock skew allowed) |
| `expirationDate` | ISO 8601; **required**, and must be in the future. Issue short-lived credentials and re-issue them from live data. |
| `credentialSubject.id` | exactly `community:@` + the person's Community handle |
| `credentialSubject.summary` | 1-120 characters of plain text, shown on the profile and on job applications |
| `credentialSubject.asOf` | ISO 8601: when the issuer read the data behind the summary; not in the future |
| `proof.jws` | a detached compact JWS (below). Other `proof` fields (`type`, `created`, `verificationMethod`) are allowed and not checked. |

Other fields are allowed and are covered by the signature.

## The signature

1. Take the credential **without its `proof` field**.
2. Canonical JSON: sort every object's keys recursively (plain string sort, as JavaScript `Array.prototype.sort()` does), keep arrays in order, then `JSON.stringify` with no spaces. Strings are UTF-8.
3. Header: `{"alg":"EdDSA"}` (Ed25519) or `{"alg":"ES256"}` (P-256, SHA-256). `kid` and `typ` may be added. `b64` and `crit` are refused: this is a plain RFC 7515 detached JWS.
4. Signing input: `BASE64URL(header) + "." + BASE64URL(canonical JSON)`, as ASCII bytes.
5. Sign. For ES256 the signature is the 64-byte `r || s` (JWS form), not DER.
6. `proof.jws = BASE64URL(header) + ".." + BASE64URL(signature)` (the payload part is empty: detached).

Base64url is without padding.

In Node.js:

```js
const canonical = (v) => JSON.stringify(sortKeys(v));
const h64 = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url');
const input = Buffer.from(`${h64}.${Buffer.from(canonical(unsignedVc)).toString('base64url')}`);
const sig = crypto.sign(null, input, ed25519PrivateKey);          // ES256: crypto.sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' })
vc.proof = { type: 'DetachedJws', created: new Date().toISOString(), jws: `${h64}..${sig.toString('base64url')}` };
```

## Errors

`POST /api/me/credentials` answers 400 with one of these codes:

| Code | Meaning |
|---|---|
| `vc_shape` | not an object, wrong `@context` or `type`, missing issuer, dates or subject |
| `vc_too_large` | over 16 KB |
| `untrusted_issuer` | the issuer is not in `CREDENTIAL_ISSUERS` |
| `bad_proof` | `proof.jws` missing or not `header..signature`, or the header is bad |
| `bad_alg` | `alg` is not EdDSA or ES256, or not the one this issuer's key uses |
| `bad_signature` | the signature does not match the credential (a changed claim, or the wrong key) |
| `not_yet_valid` | `issuanceDate` is in the future |
| `expired` | `expirationDate` has passed |
| `wrong_subject` | `credentialSubject.id` is not this person |
| `bad_summary` | `summary` missing, empty or over 120 characters |
| `bad_as_of` | `asOf` missing, not a time, or in the future |

## What Community keeps

`issuer`, `type`, `summary`, `as_of`, the credential as issued (`vc`, with its proof, so anyone can re-check it), `verified` and `verified_at`. A new credential with the same issuer and type replaces the older one and keeps its id and the person's `shown` choice. The person can hide (`PATCH { shown: false }`) or delete a credential at any time; a hidden credential disappears from the profile and from applications already sent.
