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
 * Words that may not be any part of a name either, so "admin.popcart", "popcart_official", "overseer1",
 * "admin2jun" or "st4ff1" are refused too. A part is any stretch between dots, underscores, digits used as
 * breaks, or the ends; a digit may be a break or a letter, and both readings are tried. Ordinary names
 * that only start with one ("admiral", "staffing.pro") are fine.
 */
const PART = ['admin', 'administrator', 'overseer', 'staff', 'mod', 'mods', 'moderator', 'moderators', 'support', 'helpdesk', 'security',
  'official', 'verified', 'popcart', 'popcartph', 'sysadmin', 'superuser', 'noreply', 'deleted'];
/**
 * The brand and the top staff words may not appear anywhere in a name ("popcartphl", "theoverseer",
 * "overseernews"). Matched before the rn/vv folds, with each m allowed to be written rn and each w vv, so
 * a fold can neither hide the word ("overseernews" folds to "overseemews") nor be mixed ("rnoderatornews").
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
const ANYWHERE_RES = ANYWHERE.map((w) => new RegExp(handleKey(w).replace(/m/g, '(?:m|rn)').replace(/w/g, '(?:w|vv)')));

/** Every stretch of a part that starts at its start or after a digit and ends at its end or before a digit. */
function stretches(part: string): string[] {
  const out: string[] = [], digit = (c: string | undefined) => !!c && c >= '0' && c <= '9';
  for (let i = 0; i < part.length; i++) {
    if (i > 0 && !digit(part[i - 1])) continue;
    for (let j = i + 1; j <= part.length; j++) if (j === part.length || digit(part[j])) out.push(part.slice(i, j));
  }
  return out;
}

export function isReserved(h: string): boolean {
  const k = handleKey(h), plain = h.toLowerCase().replace(/[._]/g, '').replace(/[0-9l]/g, (c) => AS[DIGITS.indexOf(c)] as string);
  if (RESERVED_KEYS.has(k) || ANYWHERE_RES.some((re) => re.test(plain))) return true;
  // Parts between dots and underscores, and every run of neighbouring parts joined, so a dot inside the
  // word doesn't hide it ("ad.min.jun" has "admin", "adm.in2" has "admin2").
  const parts = h.toLowerCase().split(/[._]/), runs: string[] = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j <= parts.length; j++) runs.push(parts.slice(i, j).join(''));
  return runs.some((part) => stretches(part).some((s) => PART_KEYS.has(handleKey(s))));
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
