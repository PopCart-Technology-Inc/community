// npm run places:import -- <psgc.csv>   (needs DATABASE_URL)
//
// Loads the Philippine Standard Geographic Code (PSGC, a published dataset) into `areas`. The CSV needs
// three columns: the 10-digit PSGC code, the name, and the geographic level (Reg, Prov, City, Mun,
// SubMun, Bgy). A header row is optional; with one, the columns are found by name. Other levels are
// skipped. Re-running is safe: every row is an upsert. Never import coordinates.
//
// Parents come from the code's prefixes: region = first 2 digits + 00000000, province = first 5 +
// 00000, city or municipality = first 7 + 000. A parent that is not in the file is skipped (so NCR
// cities hang directly from the region). A SubMun is stored as a city under its city; its barangays
// roll up to that city for the City feed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../../db/index.ts';

export type PsgcLevel = 'Reg' | 'Prov' | 'City' | 'Mun' | 'SubMun' | 'Bgy';
export interface PsgcRow { code: string; name: string; psgc_level: PsgcLevel }
export interface AreaRow {
  code: string; name: string; level: 'region' | 'province' | 'city' | 'barangay'; parent_code: string;
  city_code: string | null; region_code: string | null; country_code: 'PH';
}

const LEVEL_MAP: Record<PsgcLevel, AreaRow['level']> = { Reg: 'region', Prov: 'province', City: 'city', Mun: 'city', SubMun: 'city', Bgy: 'barangay' };
const LEVEL_ORDER: AreaRow['level'][] = ['region', 'province', 'city', 'barangay'];

/** Split CSV text into rows of fields (RFC 4180 quoting, CRLF or LF, BOM stripped). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Read PSGC rows from CSV text. Returns the usable rows and how many were skipped. */
export function parsePsgc(text: string): { rows: PsgcRow[]; skipped: number } {
  const all = parseCsv(text);
  let ci = 0, ni = 1, li = 2, start = 0;
  const first = all[0];
  if (first && !/^\s*\d{9,10}\s*$/.test(first[0] || '')) {
    const h = first.map((x) => x.trim().toLowerCase());
    const find = (...tests: RegExp[]) => { for (const t of tests) { const i = h.findIndex((x) => t.test(x)); if (i >= 0) return i; } return -1; };
    ci = find(/psgc/, /code/); ni = find(/^name$/, /name/); li = find(/level/);
    if (ci < 0 || ni < 0 || li < 0) throw new Error('places:import: the header needs a code, a name and a geographic level column');
    start = 1;
  }
  const rows: PsgcRow[] = [];
  let skipped = 0;
  for (const r of all.slice(start)) {
    let code = (r[ci] || '').trim();
    if (/^\d{9}$/.test(code)) code = '0' + code; // a spreadsheet dropped the leading zero
    const name = (r[ni] || '').trim().replace(/\s+/g, ' ');
    const lvl = (r[li] || '').trim();
    const level = (Object.keys(LEVEL_MAP) as PsgcLevel[]).find((k) => k.toLowerCase() === lvl.toLowerCase());
    if (!/^\d{10}$/.test(code) || !name || name.length > 120 || !level) { skipped++; continue; }
    rows.push({ code, name, psgc_level: level });
  }
  return { rows, skipped };
}

/** Turn PSGC rows into area rows with parents and the feed-level ancestor codes. */
export function buildAreas(rows: readonly PsgcRow[]): AreaRow[] {
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const has = (c: string, self: string) => c !== self && byCode.has(c);
  const regionOf = (c: string) => c.slice(0, 2) + '00000000';
  const parentOf = (r: PsgcRow): string => {
    const reg = regionOf(r.code);
    if (r.psgc_level === 'Reg') return 'PH';
    if (r.psgc_level === 'Prov') return has(reg, r.code) ? reg : 'PH';
    const prov = r.code.slice(0, 5) + '00000';
    if (r.psgc_level === 'Bgy') {
      const city = r.code.slice(0, 7) + '000';
      if (has(city, r.code)) return city;
    }
    if (has(prov, r.code)) return prov;
    return has(reg, r.code) ? reg : 'PH';
  };
  const out: AreaRow[] = [];
  for (const r of rows) {
    const level = LEVEL_MAP[r.psgc_level];
    const parent_code = parentOf(r);
    const parent = byCode.get(parent_code);
    let city_code: string | null = null;
    if (r.psgc_level === 'SubMun') city_code = parent && parent.psgc_level === 'City' ? parent_code : r.code;
    else if (level === 'city') city_code = r.code;
    else if (level === 'barangay' && parent && LEVEL_MAP[parent.psgc_level] === 'city') {
      // a barangay inside a SubMun belongs to the SubMun's city
      const up = parent.psgc_level === 'SubMun' ? byCode.get(parentOf(parent)) : null;
      city_code = up && up.psgc_level === 'City' ? parentOf(parent) : parent_code;
    }
    const reg = regionOf(r.code);
    out.push({ code: r.code, name: r.name, level, parent_code, city_code, region_code: byCode.has(reg) ? reg : null, country_code: 'PH' });
  }
  // parents before children, so foreign keys hold while inserting
  return out.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || (a.level === 'city' && b.level === 'city' ? Number(a.city_code !== a.code) - Number(b.city_code !== b.code) : 0));
}

/** Upsert the PH country row and every area. Safe to run again. Returns the number of areas written. */
export async function importAreas(db: Db, areas: readonly AreaRow[]): Promise<number> {
  return db.tx(async (t) => {
    await t.query(
      `INSERT INTO areas (code, name, level, parent_code, country_code) VALUES ('PH', 'Philippines', 'country', 'WORLD', 'PH')
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level, parent_code = EXCLUDED.parent_code, country_code = EXCLUDED.country_code`);
    const BATCH = 500;
    for (let i = 0; i < areas.length; i += BATCH) {
      const chunk = areas.slice(i, i + BATCH);
      const vals: unknown[] = [];
      const tuples = chunk.map((a) => {
        vals.push(a.code, a.name, a.level, a.parent_code, a.city_code, a.region_code, a.country_code);
        const n = vals.length;
        return `($${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
      });
      await t.query(
        `INSERT INTO areas (code, name, level, parent_code, city_code, region_code, country_code) VALUES ${tuples.join(', ')}
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level, parent_code = EXCLUDED.parent_code,
           city_code = EXCLUDED.city_code, region_code = EXCLUDED.region_code, country_code = EXCLUDED.country_code`, vals);
    }
    return areas.length;
  });
}

// ---- command line ----
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: npm run places:import -- <psgc.csv>'); process.exit(2); }
  const { loadConfig } = await import('../../config.ts');
  const { connectPg } = await import('../../db/index.ts');
  const { migrate } = await import('../../db/migrate.ts');
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  const { rows, skipped } = parsePsgc(readFileSync(file, 'utf8'));
  const areas = buildAreas(rows);
  const db = await connectPg(config.databaseUrl);
  await migrate(db);
  const n = await importAreas(db, areas);
  console.log(`places:import: ${n} areas written, ${skipped} rows skipped`);
  await db.close();
}
