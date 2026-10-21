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
  if (LOCAL.has(s.hostname) || s.hostname.endsWith('.localhost')) return null;
  if (s.protocol !== 'https:') return 'STAFF_ORIGIN must be https';
  if (!c.accessTeam || !c.accessAud) return 'ACCESS_TEAM_DOMAIN and ACCESS_AUD are required with a public STAFF_ORIGIN';
  return null;
}

/** True when the staff host runs without the Access gate: only ever on this machine. */
export const staffGateOff = (c: Config): boolean => !!c.staffOrigin && !c.accessTeam && staffConfigProblem(c) === null;
