// Signed proof (decision 0001, point 2): a person brings a W3C Verifiable Credential issued by a trusted
// issuer, Community checks the signature and stores the short summary. The format is fixed in
// docs/credentials.md so an issuer can be built to match. Only node:crypto, no outside libraries.
import { createPublicKey, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { fail, isUuid, json, noContent, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { requireUser } from '../../http/session.ts';

export const VC_CONTEXT = 'https://www.w3.org/2018/credentials/v1';
/** Allowed clock difference between the issuer and us. */
export const CLOCK_SKEW_MS = 5 * 60_000;
export const MAX_VC_BYTES = 16 * 1024;

interface Issuer { key: KeyObject; alg: 'EdDSA' | 'ES256' }
let issuers: Map<string, Issuer> | null = null;

function loadIssuers(raw: unknown): Map<string, Issuer> {
  const out = new Map<string, Issuer>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, jwk] of Object.entries(raw as Record<string, unknown>)) {
    if (!jwk || typeof jwk !== 'object') continue;
    const j = jwk as Record<string, unknown>;
    if ('d' in j) throw new Error(`CREDENTIAL_ISSUERS: the key for ${id} is a private key; give the public key only`);
    let alg: Issuer['alg'];
    if (j.kty === 'OKP' && j.crv === 'Ed25519') alg = 'EdDSA';
    else if (j.kty === 'EC' && j.crv === 'P-256') alg = 'ES256';
    else throw new Error(`CREDENTIAL_ISSUERS: the key for ${id} must be Ed25519 (OKP) or P-256 (EC)`);
    out.set(id, { key: createPublicKey({ key: j as JsonWebKey, format: 'jwk' }), alg });
  }
  return out;
}

/** The trusted issuers, read once from env CREDENTIAL_ISSUERS (JSON: issuer id → public JWK). */
export function trustedIssuers(): Map<string, Issuer> {
  if (!issuers) {
    const env = process.env.CREDENTIAL_ISSUERS;
    let parsed: unknown = {};
    if (env) {
      try { parsed = JSON.parse(env); } catch { throw new Error('CREDENTIAL_ISSUERS is not valid JSON'); }
    }
    issuers = loadIssuers(parsed);
  }
  return issuers;
}

/** Replace the trusted list (tests, or a reload). null: read the environment again on next use. */
export function setTrustedIssuers(map: Record<string, object> | null): void {
  issuers = map === null ? null : loadIssuers(map);
}

/** Canonical JSON: object keys sorted recursively (by UTF-16 code units), arrays in order, no spaces. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

const reject = (code: string, message: string): never => fail(400, code, message);
const b64url = /^[A-Za-z0-9_-]+$/;

export interface VerifiedCredential { issuer: string; type: string; summary: string; as_of: Date }

/** Check a Verifiable Credential for this handle. Throws HttpError 400 with a clear code when anything is off. */
export function verifyCredential(vc: unknown, handle: string, now = new Date()): VerifiedCredential {
  if (!vc || typeof vc !== 'object' || Array.isArray(vc)) return reject('vc_shape', 'vc must be a JSON object');
  const c = vc as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(c)) > MAX_VC_BYTES) return reject('vc_too_large', `vc can be at most ${MAX_VC_BYTES} bytes`);
  if (!Array.isArray(c['@context']) || c['@context'][0] !== VC_CONTEXT) return reject('vc_shape', `@context must be an array starting with ${VC_CONTEXT}`);
  const types = c.type;
  if (!Array.isArray(types) || !types.includes('VerifiableCredential')) return reject('vc_shape', 'type must be an array that includes VerifiableCredential');
  const own = types.filter((t) => t !== 'VerifiableCredential');
  if (own.length !== 1 || typeof own[0] !== 'string' || !/^[A-Z][A-Za-z0-9]{1,40}$/.test(own[0])) {
    return reject('vc_shape', 'type must name exactly one credential type besides VerifiableCredential');
  }
  const issuerId = typeof c.issuer === 'string' ? c.issuer
    : c.issuer && typeof c.issuer === 'object' && typeof (c.issuer as Record<string, unknown>).id === 'string' ? (c.issuer as Record<string, string>).id : null;
  if (!issuerId) return reject('vc_shape', 'issuer must be a string or an object with an id');
  const trusted = trustedIssuers().get(issuerId);
  if (!trusted) return reject('untrusted_issuer', 'This issuer is not on the trusted list');

  // signature first: nothing else in an unsigned credential is worth reading
  const proof = c.proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || typeof (proof as Record<string, unknown>).jws !== 'string') {
    return reject('bad_proof', 'proof.jws is required');
  }
  const parts = String((proof as Record<string, unknown>).jws).split('.');
  if (parts.length !== 3 || parts[1] !== '' || !b64url.test(parts[0] || '') || !b64url.test(parts[2] || '')) {
    return reject('bad_proof', 'proof.jws must be a detached compact JWS: header..signature');
  }
  const [h64, , s64] = parts as [string, string, string];
  let header: Record<string, unknown>;
  try { header = JSON.parse(Buffer.from(h64, 'base64url').toString('utf8')); } catch { return reject('bad_proof', 'The JWS header is not valid JSON'); }
  if (!header || typeof header !== 'object') return reject('bad_proof', 'The JWS header is not an object');
  if ('b64' in header || 'crit' in header) return reject('bad_proof', 'The JWS header may not use b64 or crit');
  if (header.alg !== 'EdDSA' && header.alg !== 'ES256') return reject('bad_alg', 'alg must be EdDSA (Ed25519) or ES256');
  if (header.alg !== trusted.alg) return reject('bad_alg', `This issuer signs with ${trusted.alg}`);
  const { proof: _omit, ...unsigned } = c;
  const signingInput = Buffer.from(`${h64}.${Buffer.from(canonicalJson(unsigned), 'utf8').toString('base64url')}`, 'ascii');
  const sig = Buffer.from(s64, 'base64url');
  let ok = false;
  try {
    ok = trusted.alg === 'EdDSA'
      ? cryptoVerify(null, signingInput, trusted.key, sig)
      : sig.length === 64 && cryptoVerify('sha256', signingInput, { key: trusted.key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch { ok = false; }
  if (!ok) return reject('bad_signature', 'The signature does not match this credential');

  const date = (v: unknown): Date | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
  const issued = date(c.issuanceDate);
  if (!issued) return reject('vc_shape', 'issuanceDate must be an ISO 8601 time');
  if (issued.getTime() > now.getTime() + CLOCK_SKEW_MS) return reject('not_yet_valid', 'This credential is dated in the future');
  const expires = date(c.expirationDate);
  if (!expires) return reject('vc_shape', 'expirationDate must be an ISO 8601 time');
  if (expires.getTime() <= now.getTime()) return reject('expired', 'This credential has expired; ask the issuer for a fresh one');

  const subj = c.credentialSubject;
  if (!subj || typeof subj !== 'object' || Array.isArray(subj)) return reject('vc_shape', 'credentialSubject must be an object');
  const s = subj as Record<string, unknown>;
  if (s.id !== `community:@${handle}`) return reject('wrong_subject', 'This credential was issued to someone else');
  if (typeof s.summary !== 'string' || !s.summary.trim() || s.summary.length > 120) return reject('bad_summary', 'credentialSubject.summary must be 1-120 characters');
  const asOf = date(s.asOf);
  if (!asOf || asOf.getTime() > now.getTime() + CLOCK_SKEW_MS) return reject('bad_as_of', 'credentialSubject.asOf must be an ISO 8601 time, not in the future');
  return { issuer: issuerId, type: own[0], summary: s.summary.trim(), as_of: asOf };
}

const CRED_COLS = 'id, issuer, type, summary, as_of, verified, verified_at, shown, created_at';

export function registerCredentials(r: Router): void {
  r.get('/me/credentials', async (ctx) => {
    const me = requireUser(ctx);
    const credentials = await ctx.db.query(`SELECT ${CRED_COLS} FROM credentials WHERE user_id = $1 ORDER BY as_of DESC`, [me.id]);
    return json({ credentials, as_of: new Date().toISOString() });
  });

  r.post('/me/credentials', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const { vc } = await ctx.json<{ vc?: unknown }>();
    const v = verifyCredential(vc, me.handle);
    // A re-issued credential (same issuer and type) replaces the older one and keeps its id and `shown` choice.
    const existing = await ctx.db.one<{ id: string }>('SELECT id FROM credentials WHERE user_id = $1 AND issuer = $2 AND type = $3 ORDER BY created_at LIMIT 1', [me.id, v.issuer, v.type]);
    const credential = existing
      ? await ctx.db.one(`UPDATE credentials SET summary = $2, as_of = $3, vc = $4, verified = true, verified_at = now() WHERE id = $1 RETURNING ${CRED_COLS}`,
        [existing.id, v.summary, v.as_of.toISOString(), JSON.stringify(vc)])
      : await ctx.db.one(`INSERT INTO credentials (user_id, issuer, type, summary, as_of, vc, verified, verified_at) VALUES ($1, $2, $3, $4, $5, $6, true, now()) RETURNING ${CRED_COLS}`,
        [me.id, v.issuer, v.type, v.summary, v.as_of.toISOString(), JSON.stringify(vc)]);
    return json({ credential }, 201);
  });

  r.patch('/me/credentials/:id', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such credential');
    const { shown } = await ctx.json<{ shown?: unknown }>();
    if (typeof shown !== 'boolean') return fail(400, 'invalid', 'shown: must be true or false');
    const credential = await ctx.db.one(`UPDATE credentials SET shown = $3 WHERE id = $1 AND user_id = $2 RETURNING ${CRED_COLS}`, [ctx.params.id, me.id, shown]);
    if (!credential) return fail(404, 'not_found', 'No such credential');
    return json({ credential });
  });

  r.delete('/me/credentials/:id', async (ctx) => {
    const me = requireUser(ctx);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such credential');
    const gone = await ctx.db.one('DELETE FROM credentials WHERE id = $1 AND user_id = $2 RETURNING 1', [ctx.params.id, me.id]);
    if (!gone) return fail(404, 'not_found', 'No such credential');
    return noContent();
  });
}
