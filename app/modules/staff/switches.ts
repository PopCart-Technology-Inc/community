// Platform and feature switches (decision 0009, point 11). Read by the server where they apply:
// `launched` by the transparency report, `read_only` by every write on the public host, and feature
// switches by `featureOn` (staging or production, from COMMUNITY_STAGE).
import type { Config } from '../../config.ts';
import type { Db } from '../../db/index.ts';

export type SwitchKey = 'launched' | 'read_only';
export const SWITCH_KEYS: readonly SwitchKey[] = ['launched', 'read_only'];
/** Switches that need a second Overseer to change. Read-only mode is for emergencies, so one is enough. */
export const TWO_PERSON: ReadonlySet<SwitchKey> = new Set(['launched']);

export interface SwitchRow { key: SwitchKey; is_on: boolean; note: string; updated_at: string; updated_by: string | null }

export const readSwitches = (db: Db): Promise<SwitchRow[]> => db.query<SwitchRow>(
  `SELECT s.key, s.is_on, s.note, s.updated_at, u.handle AS updated_by FROM platform_switches s LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.key`);

export async function switchOn(db: Db, key: SwitchKey): Promise<boolean> {
  return !!(await db.one<{ is_on: boolean }>('SELECT is_on FROM platform_switches WHERE key = $1', [key]))?.is_on;
}

export async function setSwitch(db: Db, key: SwitchKey, on: boolean, by: string, note: string): Promise<void> {
  await db.query('UPDATE platform_switches SET is_on = $2, note = $3, updated_by = $4, updated_at = now() WHERE key = $1', [key, on, note.slice(0, 200), by]);
}

/** Is this feature switched on where this server runs? Unknown features are off. */
export async function featureOn(db: Db, config: Config, id: string): Promise<boolean> {
  const f = await db.one<{ staging: boolean; production: boolean }>('SELECT staging, production FROM feature_switches WHERE id = $1', [id]);
  return !!f && (config.stage === 'staging' ? f.staging : f.production);
}

/** Writes that still work in read-only mode: signing in and out, reporting, and a person's data rights. */
const READ_ONLY_OK: readonly [string, RegExp][] = [
  ['POST', /^\/accounts\/(login\/options|login\/verify|logout)$/],
  ['POST', /^\/reports$/],
  ['DELETE', /^\/me$/],
  ['POST', /^\/me\/mod-actions\/[^/]+\/appeal$/],
  ['POST', /^\/me\/staff-code$/],
];
export const allowedWhenReadOnly = (method: string, path: string): boolean => READ_ONLY_OK.some(([m, re]) => m === method && re.test(path));
