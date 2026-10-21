// The gate in front of the staff host (decision 0009, point 8): Cloudflare Access lets only listed staff
// addresses through and adds a signed token (Cf-Access-Jwt-Assertion, RS256) to every request. The
// server checks that token itself, so a request that found another way to the server still gets a 404.
// Keys come from the team's certs endpoint and are cached; an unknown key id fetches them again.
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

export interface AccessIdentity { email: string; sub: string }

export type JwksFetcher = (url: string) => Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;

const fetchJwks: JwksFetcher = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`access certs: ${r.status}`);
  return r.json() as Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;
};

const CACHE_MS = 60 * 60_000, REFETCH_MS = 60_000, SKEW_S = 60;
const part = (s: string): Record<string, unknown> | null => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };

export class AccessVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private team: string;
  private aud: string;
  private fetcher: JwksFetcher;
  constructor(team: string, aud: string, fetcher: JwksFetcher = fetchJwks) { this.team = team; this.aud = aud; this.fetcher = fetcher; }

  private async load(force: boolean): Promise<void> {
    const age = Date.now() - this.fetchedAt;
    if (!force && age < CACHE_MS && this.keys.size) return;
    if (force && age < REFETCH_MS) return; // an unknown key id can't make us hammer the endpoint
    const { keys } = await this.fetcher(`${this.team}/cdn-cgi/access/certs`);
    const next = new Map<string, KeyObject>();
    for (const k of keys || []) if (k.kid && k.kty === 'RSA') next.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
    this.keys = next;
    this.fetchedAt = Date.now();
  }

  /** The person the gate let through, or null for anything missing, forged, expired or for another app. */
  async verify(token: string | undefined, now = Date.now()): Promise<AccessIdentity | null> {
    if (!token || token.length > 8192) return null;
    const [h, p, s, extra] = token.split('.');
    if (!h || !p || !s || extra !== undefined) return null;
    const head = part(h), claims = part(p);
    if (!head || !claims || head.alg !== 'RS256' || typeof head.kid !== 'string') return null;
    try {
      await this.load(false);
      if (!this.keys.has(head.kid)) await this.load(true);
    } catch { return null; }
    const key = this.keys.get(head.kid);
    if (!key || !verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return null;
    const t = now / 1000;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.team || !aud.includes(this.aud)) return null;
    if (typeof claims.exp !== 'number' || claims.exp < t - SKEW_S) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > t + SKEW_S) return null;
    if (typeof claims.email !== 'string' || !claims.email.includes('@')) return null;
    return { email: claims.email.trim().toLowerCase(), sub: String(claims.sub || '') };
  }
}
