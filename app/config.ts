// Runtime configuration, from the environment only. Nothing secret has a default.
export interface Config {
  port: number;
  /** postgres://… for the platform database. Unset: the server refuses to start (tests pass a Db). */
  databaseUrl: string | null;
  /** The public origin, e.g. https://community.popcartph.com. Used for CSRF checks and passkeys. */
  origin: string;
  /** WebAuthn relying party id: the origin's host name. */
  rpId: string;
  rpName: string;
  /** Optional directory with the brand pack (sprite.svg). Not part of this repository (TRADEMARKS.md). */
  brandDir: string | null;
  /** Where uploaded media is stored on disk. */
  mediaDir: string;
  sessionDays: number;
  /** Behind a reverse proxy or tunnel: trust X-Forwarded-For for the client address. */
  trustProxy: boolean;
  /** Key for the hash that matches an invited email address (the address itself is never stored). */
  emailKey: string | null;
  /** Resend API key for sending email. Unset: on http://localhost the email is printed instead; elsewhere sending fails. */
  resendKey: string | null;
  /** The From line, e.g. "PopCart Community <hello@example.org>". Required with resendKey. */
  mailFrom: string | null;
  /**
   * The staff host (decision 0009), e.g. https://<random letters>.example.org. Unset: no staff panels and
   * no staff API anywhere. Keep the real name in private config only.
   */
  staffOrigin: string | null;
  /** WebAuthn relying party id for staff passkeys: the staff host name. */
  staffRpId: string | null;
  /** The Cloudflare Access team domain that guards the staff host, e.g. https://<team>.cloudflareaccess.com. */
  accessTeam: string | null;
  /** The Access application's audience tag (AUD). */
  accessAud: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = (env.COMMUNITY_ORIGIN || 'http://localhost:8080').replace(/\/$/, '');
  const url = new URL(origin);
  return {
    port: Number(env.PORT || 8080),
    databaseUrl: env.DATABASE_URL || null,
    origin,
    rpId: env.WEBAUTHN_RP_ID || url.hostname,
    rpName: env.WEBAUTHN_RP_NAME || 'PopCart Community',
    brandDir: env.BRAND_DIR || null,
    mediaDir: env.MEDIA_DIR || 'data/media',
    sessionDays: Number(env.SESSION_DAYS || 30),
    trustProxy: env.TRUST_PROXY === '1',
    emailKey: env.EMAIL_HASH_KEY || null,
    resendKey: env.RESEND_API_KEY || null,
    mailFrom: env.MAIL_FROM || null,
    staffOrigin: env.STAFF_ORIGIN ? env.STAFF_ORIGIN.replace(/\/$/, '') : null,
    staffRpId: env.STAFF_ORIGIN ? (env.STAFF_RP_ID || new URL(env.STAFF_ORIGIN).hostname) : null,
    accessTeam: env.ACCESS_TEAM_DOMAIN ? env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '') : null,
    accessAud: env.ACCESS_AUD || null,
  };
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLocal = (host: string): boolean => LOCAL.has(host) || host.endsWith('.localhost');

/** A connection from this machine itself (the socket's address; X-Forwarded-For is never trusted for this). */
export const isLoopback = (addr: string | undefined): boolean => !!addr && (addr === '::1' || /^(::ffff:)?127\./.test(addr));

/**
 * Why this config can't run a staff host, or null. A public staff host must be https, on its own host
 * name, and behind Access; only a staff host on this machine (development) may run without the gate.
 */
export function staffConfigProblem(c: Config): string | null {
  if (!c.staffOrigin) return null;
  let s: URL;
  try { s = new URL(c.staffOrigin); } catch { return 'STAFF_ORIGIN is not a URL'; }
  if (s.host === new URL(c.origin).host) return 'STAFF_ORIGIN must be a different host from COMMUNITY_ORIGIN';
  if (s.pathname !== '/' || s.search) return 'STAFF_ORIGIN is an origin only, with no path';
  if (!c.accessTeam !== !c.accessAud) return 'ACCESS_TEAM_DOMAIN and ACCESS_AUD go together: set both or neither';
  if (isLocal(s.hostname)) {
    // Without the gate only for trying it out: Community itself must be on this machine too.
    return isLocal(new URL(c.origin).hostname) ? null : 'A localhost STAFF_ORIGIN is for a Community on this machine only (COMMUNITY_ORIGIN is public)';
  }
  if (s.protocol !== 'https:') return 'STAFF_ORIGIN must be https';
  if (!c.accessTeam || !c.accessAud) return 'ACCESS_TEAM_DOMAIN and ACCESS_AUD are required with a public STAFF_ORIGIN';
  let team: URL;
  try { team = new URL(c.accessTeam); } catch { return 'ACCESS_TEAM_DOMAIN is not a URL'; }
  if (team.protocol !== 'https:' || team.pathname !== '/' || team.search) return 'ACCESS_TEAM_DOMAIN must be an https origin, e.g. https://your-team.cloudflareaccess.com';
  // Staff passkeys belong to the staff host: their domain must be that host (or one it sits under) and
  // must not also cover the public site.
  const rp = c.staffRpId || s.hostname, pub = new URL(c.origin).hostname;
  if (s.hostname !== rp && !s.hostname.endsWith('.' + rp)) return 'STAFF_RP_ID must be the staff host name or a domain it is under';
  if (pub === rp || pub.endsWith('.' + rp)) return 'STAFF_RP_ID must not also cover COMMUNITY_ORIGIN: leave it unset to use the staff host name';
  return null;
}
