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
  };
}
