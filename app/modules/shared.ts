// Helpers every module uses: input checks (fail with 400, never trust the client), the salamat week,
// the Places levels and area resolution.
import type { Db } from '../db/index.ts';
import { HttpError } from '../http/router.ts';

export const bad = (field: string, message: string): never => { throw new HttpError(400, 'invalid', `${field}: ${message}`); };

export function str(v: unknown, field: string, opts: { min?: number; max: number; optional?: boolean; pattern?: RegExp }): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    return bad(field, 'is required');
  }
  if (typeof v !== 'string') return bad(field, 'must be text');
  const s = v.normalize('NFC').trim();
  if (s.length < (opts.min ?? 0)) return bad(field, `needs at least ${opts.min} characters`);
  if (s.length > opts.max) return bad(field, `can be at most ${opts.max} characters`);
  if (opts.pattern && !opts.pattern.test(s)) return bad(field, 'has characters that are not allowed');
  return s;
}

export function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) return bad(field, `must be a whole number from ${min} to ${max}`);
  return n;
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[], fallback?: T): T {
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) return bad(field, `must be one of ${allowed.join(', ')}`);
  return v as T;
}

export const bool = (v: unknown): boolean => v === true;

/** Page size from ?limit, 1-50, default 20. Cursor = ISO time of the last item seen. */
export function page(q: URLSearchParams): { limit: number; before: string | null } {
  const limit = Math.min(50, Math.max(1, Number(q.get('limit')) || 20));
  const b = q.get('before');
  return { limit, before: b && !Number.isNaN(Date.parse(b)) ? new Date(b).toISOString() : null };
}

/** ISO week in Asia/Manila (UTC+8, no DST), e.g. "2026-W43". Salamats reset every Monday 00:00 PHT. */
export function manilaWeek(at = new Date()): string {
  const d = new Date(at.getTime() + 8 * 3600_000);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week decides the ISO year
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export const SALAMATS_PER_WEEK = 10;

// ---- Places (decision 0005) ----
export const LEVELS = ['barangay', 'city', 'region', 'country', 'world'] as const;
export type Level = (typeof LEVELS)[number];
export const levelIndex = (l: Level): number => LEVELS.indexOf(l);

export interface AreaCodes {
  area_code: string | null;
  barangay_code: string | null;
  city_code: string | null;
  region_code: string | null;
  country_code: string | null;
}

/** The feed-level codes for an area (a barangay, city, region or country code). Unknown code: 400. */
export async function resolveArea(db: Db, code: string | null | undefined): Promise<AreaCodes> {
  if (!code) return { area_code: null, barangay_code: null, city_code: null, region_code: null, country_code: null };
  const a = await db.one<{ code: string; level: string; city_code: string | null; region_code: string | null; country_code: string | null }>(
    'SELECT code, level, city_code, region_code, country_code FROM areas WHERE code = $1', [code]);
  if (!a) return bad('area', 'is not a known place');
  return {
    area_code: a.code,
    barangay_code: a.level === 'barangay' ? a.code : null,
    city_code: a.level === 'city' ? a.code : a.city_code,
    region_code: a.level === 'region' ? a.code : a.region_code,
    country_code: a.level === 'country' ? a.code : a.country_code,
  };
}

/** Public, minimal view of a person: never anything from the vault. */
export const PERSON_COLS = `u.id, u.handle, u.first_name, u.trade, u.avatar_media_id,
  EXISTS (SELECT 1 FROM credentials c WHERE c.user_id = u.id AND c.verified AND c.type = 'IdentityCheck') AS id_checked`;
export interface Person { id: string; handle: string; first_name: string; trade: string; avatar_media_id: string | null; id_checked: boolean }
