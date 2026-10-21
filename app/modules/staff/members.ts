// Who holds a staff role, and changing it (decision 0009). Used by the server's command line now and by
// the Overseer panel later. Overseers have no end date, and there is always at least one.
import type { Db } from '../../db/index.ts';
import { fail } from '../../http/router.ts';
import { OVERSEER, scopesOf, type Scope } from '../../http/scopes.ts';

export const DEFAULT_DAYS = 90;

export interface StaffRow { user_id: string; handle: string; role: string; ends_at: string | null; granted_at: string; granted_by: string | null; scopes: Scope[] }

/** Everyone holding a role now (ended roles are left out), Overseers first. */
export async function listStaff(db: Db): Promise<StaffRow[]> {
  const rows = await db.query<Omit<StaffRow, 'scopes'> & { stored: string[] }>(
    `SELECT sm.user_id, u.handle, sm.role, sm.ends_at, sm.granted_at, g.handle AS granted_by, sr.scopes AS stored
     FROM staff_members sm JOIN users u ON u.id = sm.user_id JOIN staff_roles sr ON sr.name = sm.role LEFT JOIN users g ON g.id = sm.granted_by
     WHERE (sm.ends_at IS NULL OR sm.ends_at > now()) AND u.status <> 'deleted'
     ORDER BY sm.role = $1 DESC, u.handle`, [OVERSEER]);
  return rows.map(({ stored, ...r }) => ({ ...r, scopes: scopesOf(r.role, stored) }));
}

export const roleNames = async (db: Db): Promise<string[]> => (await db.query<{ name: string }>('SELECT name FROM staff_roles ORDER BY name = $1 DESC, name', [OVERSEER])).map((r) => r.name);

async function userId(db: Db, handle: string): Promise<string> {
  const u = await db.one<{ id: string }>(`SELECT id FROM users WHERE handle = $1 AND status <> 'deleted'`, [handle.replace(/^@/, '').toLowerCase()]);
  return u?.id ?? fail(404, 'not_found', 'No one has that username');
}

/**
 * Overseers who can still act (a deleted or suspended account doesn't count), leaving out `except`. With
 * `lock`, inside a transaction, the Overseer rows are locked first, so two changes at the same moment
 * can't both see an Overseer the other is removing.
 */
/** Lock the Overseer rows, in id order. Everything that changes Overseers takes this first, then the target's row. */
export const lockOverseers = (db: Db) => db.query('SELECT user_id FROM staff_members WHERE role = $1 ORDER BY user_id FOR UPDATE', [OVERSEER]);

export async function overseerCount(db: Db, opts: { except?: string; lock?: boolean } = {}): Promise<number> {
  if (opts.lock) await lockOverseers(db);
  return (await db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM staff_members sm JOIN users u ON u.id = sm.user_id
     WHERE sm.role = $1 AND u.status = 'active' AND sm.user_id IS DISTINCT FROM $2::uuid`, [OVERSEER, opts.except ?? null]))!.n;
}

const LAST = 'Community must keep at least one Overseer who can act';

/**
 * Give someone a role (replacing any role they hold). Non-Overseer roles end after `days`. `emailHash` is
 * the keyed hash of their address on the gate list; kept when not given.
 */
/** `keepOverseers`: refuse to change an Overseer's role (the panel; only two Overseers remove one). */
export async function grantRole(db: Db, opts: { handle: string; role: string; days?: number; by?: string | null; emailHash?: Buffer; keepOverseers?: boolean }): Promise<{ ends_at: string | null }> {
  const id = await userId(db, opts.handle);
  if (!(await db.one('SELECT 1 FROM staff_roles WHERE name = $1', [opts.role]))) fail(400, 'invalid', `role: no role named ${opts.role}`);
  const days = opts.days ?? DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 366) fail(400, 'invalid', 'days: must be a whole number from 1 to 366');
  return db.tx(async (t) => {
    await lockOverseers(t);
    const current = await t.one<{ role: string }>('SELECT role FROM staff_members WHERE user_id = $1 FOR UPDATE', [id]);
    if (opts.keepOverseers && current?.role === OVERSEER) fail(409, 'is_overseer', 'Removing an Overseer needs a second Overseer: use Remove');
    if (current?.role === OVERSEER && opts.role !== OVERSEER && (await overseerCount(t, { except: id, lock: true })) < 1) fail(409, 'last_overseer', LAST);
    const row = await t.one<{ ends_at: string | null }>(
      `INSERT INTO staff_members (user_id, role, ends_at, granted_by, email_hash) VALUES ($1, $2, CASE WHEN $2 = $5 THEN NULL ELSE now() + make_interval(days => $3) END, $4, $6)
       ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, ends_at = EXCLUDED.ends_at, granted_by = EXCLUDED.granted_by, granted_at = now(),
         email_hash = coalesce(EXCLUDED.email_hash, staff_members.email_hash)
       WHERE NOT $7 OR staff_members.role <> $5
       RETURNING ends_at`, [id, opts.role, days, opts.by ?? null, OVERSEER, opts.emailHash ?? null, !!opts.keepOverseers]);
    // Made an Overseer since we looked (the check above runs without a row lock): still never by one person.
    if (!row) return fail(409, 'is_overseer', 'Removing an Overseer needs a second Overseer: use Remove');
    return { ends_at: row.ends_at };
  });
}

/** Push a role's end date out by `days` from today (or from its current end, if later). */
export async function renewRole(db: Db, opts: { handle: string; days?: number }): Promise<{ ends_at: string }> {
  const id = await userId(db, opts.handle);
  const days = opts.days ?? DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 366) fail(400, 'invalid', 'days: must be a whole number from 1 to 366');
  const row = await db.one<{ ends_at: string }>(
    `UPDATE staff_members SET ends_at = greatest(ends_at, now()) + make_interval(days => $2) WHERE user_id = $1 AND ends_at IS NOT NULL RETURNING ends_at`,
    [id, days]);
  return row ?? fail(404, 'not_found', 'That person holds no role with an end date');
}

/** Take someone's role away. The last Overseer can't be removed. */
/** `keepOverseers`: refuse if they are an Overseer (the panel; removing one is a two-person request). */
export async function revokeRole(db: Db, handle: string, opts: { keepOverseers?: boolean } = {}): Promise<{ role: string }> {
  const id = await userId(db, handle);
  return db.tx(async (t) => {
    await lockOverseers(t);
    const current = await t.one<{ role: string }>('SELECT role FROM staff_members WHERE user_id = $1 FOR UPDATE', [id]);
    if (!current) return fail(404, 'not_found', 'That person holds no staff role');
    if (opts.keepOverseers && current.role === OVERSEER) fail(409, 'is_overseer', 'Removing an Overseer needs a second Overseer');
    if (current.role === OVERSEER && (await overseerCount(t, { except: id, lock: true })) < 1) fail(409, 'last_overseer', LAST);
    await t.query('DELETE FROM staff_members WHERE user_id = $1', [id]);
    // Their staff passkeys and sessions go with the role.
    await t.query('DELETE FROM staff_sessions WHERE user_id = $1', [id]);
    await t.query('DELETE FROM staff_passkeys WHERE user_id = $1', [id]);
    return current;
  });
}
