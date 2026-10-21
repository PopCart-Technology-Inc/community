// Usernames: the shape rule, the reserved names and the look-alike key. Every place that sets a
// username goes through checkHandle(), so a profile URL (community.popcartph.com/<username>) can never
// be a staff word, a screen of the app or one of the server's own files. Decision 0009.
import type { Db } from '../../db/index.ts';
import { fail } from '../../http/router.ts';

/** 3-30 of a-z, 0-9, dot and underscore; starts and ends with a letter or digit; no two dots in a row. */
export const HANDLE_RE = /^(?=.{3,30}$)(?!.*\.\.)[a-z0-9](?:[a-z0-9._]*[a-z0-9])?$/;

const DIGITS = '0123456789l', AS = 'oizeasgtbgi';
/**
 * The look-alike key: dots and underscores dropped; 0 1 2 3 4 5 6 7 8 9 read as o i z e a s g t b g, l as
 * i, then rn as m and vv as w. Two names with the same key are the same name, so "maria.santos" and
 * "mariasantos", or "admin", "adm1n" and "adrnin", cannot both exist. Migration 0008 keeps the same key in
 * users.handle_key (a test keeps the two in step).
 */
export const handleKey = (h: string): string => h.toLowerCase().replace(/[._]/g, '')
  .replace(/[0-9l]/g, (c) => AS[DIGITS.indexOf(c)] as string).replace(/rn/g, 'm').replace(/vv/g, 'w');

/** Words nobody can hold, compared by their look-alike key. */
const STAFF = ['admin', 'administrator', 'overseer', 'staff', 'mod', 'mods', 'moderator', 'moderators', 'support', 'help', 'helpdesk',
  'security', 'safety', 'official', 'verified', 'team', 'community', 'popcart', 'popcartph', 'root', 'system', 'sysadmin', 'superuser',
  'owner', 'operator', 'trust', 'abuse', 'legal', 'privacy', 'news', 'announcements', 'noreply', 'postmaster', 'webmaster', 'hostmaster', 'deleted'];
/**
 * Words that may not be any part of a name either (parts are split at dots and underscores, with digits
 * at either end ignored), so "admin.popcart", "popcart_official" or "overseer1" are refused too. Ordinary
 * names that only start with one ("admiral", "staffing.pro") are fine.
 */
const PART = ['admin', 'administrator', 'overseer', 'staff', 'mod', 'mods', 'moderator', 'moderators', 'support', 'helpdesk', 'security',
  'official', 'verified', 'popcart', 'popcartph', 'sysadmin', 'superuser', 'noreply', 'deleted'];
/**
 * The brand and the top staff words may not appear anywhere in a name ("popcartphl", "theoverseer").
 * Checked on the key with and without the rn/vv folds, so a letter after the word ("overseernews", whose
 * key is "overseemews") can't hide it.
 */
const ANYWHERE = ['popcart', 'overseer', 'moderator', 'administrator'];
/** The first part of every screen path in app/web/static/lib/router.js (a test checks they match). */
const SCREENS = ['places', 'trade', 'picks', 'join', 'login', 'logout', 'p', 'compose', 'explore', 'activity', 'spaces', 's', 'inbox',
  'work', 'gigs', 'u', 'me', 'report', 'transparency', 'search', 'settings', 'notifications', 'messages', 'home', 'about', 'terms', 'rules'];
/** Paths the server answers itself, and well-known files. */
const FILES = ['api', 'static', 'brand', 'media', 'sw.js', 'manifest.webmanifest', 'robots.txt', 'favicon.ico', 'sitemap.xml',
  'security.txt', 'humans.txt', 'ads.txt', 'app-ads.txt', 'apple-app-site-association', 'assetlinks.json', 'index.html', 'health', 'status', 'www', 'mail', 'email'];

export const RESERVED: readonly string[] = [...STAFF, ...SCREENS, ...FILES];
const RESERVED_KEYS = new Set(RESERVED.map(handleKey));
const PART_KEYS = new Set(PART.map(handleKey));
const ANYWHERE_KEYS = ANYWHERE.map(handleKey);

export function isReserved(h: string): boolean {
  const k = handleKey(h), plain = h.toLowerCase().replace(/[._]/g, '').replace(/[0-9l]/g, (c) => AS[DIGITS.indexOf(c)] as string);
  if (RESERVED_KEYS.has(k) || ANYWHERE_KEYS.some((w) => k.includes(w) || plain.includes(w))) return true;
  // Parts: split at dots and underscores, and again at digits ("admin2jun", "support24x7").
  const parts = h.toLowerCase().split(/[._]/);
  return [...parts, ...parts.flatMap((p) => p.split(/[0-9]+/))].some((part) => PART_KEYS.has(handleKey(part)));
}

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
