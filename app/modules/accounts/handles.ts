// Usernames: the shape rule, the reserved names and the look-alike key. Every place that sets a
// username goes through checkHandle(), so a profile URL (community.popcartph.com/<username>) can never
// be a staff word, a screen of the app or one of the server's own files. Decision 0009.
import type { Db } from '../../db/index.ts';
import { fail } from '../../http/router.ts';

/** 3-30 of a-z, 0-9, dot and underscore; starts and ends with a letter or digit; no two dots in a row. */
export const HANDLE_RE = /^(?=.{3,30}$)(?!.*\.\.)[a-z0-9](?:[a-z0-9._]*[a-z0-9])?$/;

/**
 * The look-alike key: dots and underscores dropped, and 0 1 3 4 5 7 read as o i e a s t. Two names with
 * the same key are the same name, so "maria.santos" and "mariasantos", or "admin" and "adm1n", cannot
 * both exist. Migration 0008 keeps the same key in users.handle_key.
 */
export const handleKey = (h: string): string => h.toLowerCase().replace(/[._]/g, '').replace(/[013457]/g, (d) => 'oieast'['013457'.indexOf(d)] as string);

/** Words nobody can hold, compared by their look-alike key. */
const STAFF = ['admin', 'administrator', 'overseer', 'staff', 'mod', 'mods', 'moderator', 'moderators', 'support', 'help', 'helpdesk',
  'security', 'safety', 'official', 'verified', 'team', 'community', 'popcart', 'popcartph', 'root', 'system', 'sysadmin', 'superuser',
  'owner', 'operator', 'trust', 'abuse', 'legal', 'privacy', 'news', 'announcements', 'noreply', 'postmaster', 'webmaster', 'hostmaster'];
/** The first part of every screen path in app/web/static/lib/router.js (a test checks they match). */
const SCREENS = ['places', 'trade', 'picks', 'join', 'login', 'logout', 'p', 'compose', 'explore', 'activity', 'spaces', 's', 'inbox',
  'work', 'gigs', 'u', 'me', 'report', 'transparency', 'search', 'settings', 'notifications', 'messages', 'home', 'about', 'terms', 'rules'];
/** Paths the server answers itself, and well-known files. */
const FILES = ['api', 'static', 'brand', 'media', 'sw.js', 'manifest.webmanifest', 'robots.txt', 'favicon.ico', 'sitemap.xml',
  'security.txt', 'humans.txt', 'ads.txt', 'app-ads.txt', 'apple-app-site-association', 'assetlinks.json', 'index.html', 'health', 'status', 'www', 'mail', 'email'];

export const RESERVED: readonly string[] = [...STAFF, ...SCREENS, ...FILES];
const RESERVED_KEYS = new Set(RESERVED.map(handleKey));

export const isReserved = (h: string): boolean => RESERVED_KEYS.has(handleKey(h));

export type HandleProblem = 'shape' | 'reserved' | 'taken' | null;

/** Why a username can't be used, or null. `db` adds the "already taken (or a look-alike of one)" check. */
export async function handleProblem(h: string, db?: Db, exceptUserId?: string): Promise<HandleProblem> {
  if (!HANDLE_RE.test(h)) return 'shape';
  if (isReserved(h)) return 'reserved';
  if (db && await db.one('SELECT 1 FROM users WHERE handle_key = $1 AND id IS DISTINCT FROM $2', [handleKey(h), exceptUserId ?? null])) return 'taken';
  return null;
}

const MESSAGES: Record<Exclude<HandleProblem, null>, [number, string, string]> = {
  shape: [400, 'invalid', 'handle: use 3-30 letters, numbers, dots or underscores, starting and ending with a letter or number, with no two dots in a row'],
  reserved: [409, 'handle_reserved', 'That username is reserved. Pick another.'],
  taken: [409, 'handle_taken', 'That username is taken'],
};

/** The username, lower-cased and checked, or an HttpError with a message the join screen shows as is. */
export async function checkHandle(v: unknown, db: Db, exceptUserId?: string): Promise<string> {
  const h = typeof v === 'string' ? v.normalize('NFC').trim().toLowerCase() : '';
  const p = await handleProblem(h, db, exceptUserId);
  if (p) { const [status, code, msg] = MESSAGES[p]; fail(status, code, msg); }
  return h;
}
