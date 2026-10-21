// Two people for the big ones (decision 0009, point 11). One Overseer asks, a different Overseer
// approves within 72 hours, and only then is the change made, in the same transaction as the approval.
// A request nobody decides expires and changes nothing. Until a second Overseer exists these changes
// are made with `npm run staff` on the server (point 14).
import type { Db } from '../../db/index.ts';
import { fail } from '../../http/router.ts';
import { OVERSEER } from '../../http/scopes.ts';
import { logStaff, type Actor } from './audit.ts';
import { overseerCount } from './members.ts';
import { setSwitch, type SwitchKey } from './switches.ts';

export const WINDOW_HOURS = 72;
export type ApprovalKind = 'overseer_add' | 'overseer_remove' | 'switch' | 'feature';

export interface Approval {
  id: string; kind: ApprovalKind; key: string; title: string; payload: Record<string, unknown>;
  asked_by: string; asked_at: string; expires_at: string; status: string;
  decided_by: string | null; decided_at: string | null; reason: string;
}

/**
 * Waiting requests past their 72 hours become `expired`, and those whose asker can no longer act (removed,
 * demoted, suspended or deleted, by any route) are withdrawn. Run before reading or deciding.
 */
export async function expireOld(db: Db): Promise<void> {
  await db.query(`UPDATE staff_approvals SET status = 'expired' WHERE status = 'waiting' AND expires_at <= now()`);
  await db.query(
    `UPDATE staff_approvals a SET status = 'withdrawn', decided_at = now(), reason = 'The Overseer who asked can no longer act'
     WHERE a.status = 'waiting' AND NOT EXISTS (SELECT 1 FROM staff_members sm JOIN users u ON u.id = sm.user_id
       WHERE sm.user_id = a.asked_by AND sm.role = $1 AND u.status = 'active')`, [OVERSEER]);
}

export { overseerCount } from './members.ts';

/** Nobody decides a request about themselves: the person an Overseer removal is about can't stop it. */
const about = (a: Pick<Approval, 'kind' | 'payload'>, id: string): boolean => a.kind === 'overseer_remove' && a.payload.user_id === id;

export async function ask(db: Db, me: Actor, a: { kind: ApprovalKind; key: string; title: string; payload: Record<string, unknown> }): Promise<{ id: string; expires_at: string }> {
  await expireOld(db);
  return db.tx(async (t) => {
    if (await t.one(`SELECT 1 FROM staff_approvals WHERE key = $1 AND status = 'waiting'`, [a.key])) {
      fail(409, 'already_asked', 'A request for this is already waiting for a second Overseer');
    }
    const row = await t.one<{ id: string; expires_at: string }>(
      `INSERT INTO staff_approvals (kind, key, title, payload, asked_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
       ON CONFLICT (key) WHERE status = 'waiting' DO NOTHING RETURNING id, expires_at`, [a.kind, a.key, a.title.slice(0, 200), JSON.stringify(a.payload), me.id, WINDOW_HOURS]);
    if (!row) return fail(409, 'already_asked', 'A request for this is already waiting for a second Overseer');
    await logStaff(t, me, 'approval', `asked: ${a.title}`, null, { approval: row!.id });
    return row!;
  });
}

export async function list(db: Db, meId: string, status: 'waiting' | 'done'): Promise<(Approval & { asked_by_handle: string; decided_by_handle: string | null; can_decide: boolean; mine: boolean })[]> {
  await expireOld(db);
  const rows = await db.query<Approval & { asked_by_handle: string; decided_by_handle: string | null }>(
    `SELECT a.*, ab.handle AS asked_by_handle, db.handle AS decided_by_handle FROM staff_approvals a
       JOIN users ab ON ab.id = a.asked_by LEFT JOIN users db ON db.id = a.decided_by
     WHERE ${status === 'waiting' ? `a.status = 'waiting'` : `a.status <> 'waiting'`}
     ORDER BY ${status === 'waiting' ? 'a.expires_at' : 'coalesce(a.decided_at, a.expires_at) DESC'} LIMIT 100`);
  return rows.map((r) => ({ ...r, can_decide: r.status === 'waiting' && r.asked_by !== meId && !about(r, meId), mine: r.asked_by === meId }));
}

/** Approve (and make the change) or decline with a reason. Never by the person who asked. */
export async function decide(db: Db, me: Actor & { id: string }, id: string, decision: 'approve' | 'decline', reason: string): Promise<void> {
  await expireOld(db);
  await db.tx(async (t) => {
    // Overseer rows first, then the request: the same order as everything else that locks them.
    await t.query('SELECT user_id FROM staff_members WHERE role = $1 FOR UPDATE', [OVERSEER]);
    const a = await t.one<Approval>('SELECT * FROM staff_approvals WHERE id = $1 FOR UPDATE', [id]);
    if (!a) return fail(404, 'not_found', 'No such request');
    if (a.status !== 'waiting') return fail(409, 'decided', a.status === 'expired' ? 'This request expired. Ask again.' : 'This request has already been decided');
    if (a.asked_by === me.id) return fail(403, 'same_person', 'A second Overseer must decide this');
    if (about(a, me.id)) return fail(403, 'about_you', 'This request is about you: another Overseer decides it');
    // A request from someone who is no longer an Overseer (removed, or their account suspended) is not decided.
    if (!(await t.one(`SELECT 1 FROM staff_members sm JOIN users u ON u.id = sm.user_id WHERE sm.user_id = $1 AND sm.role = $2 AND u.status = 'active'`, [a.asked_by, OVERSEER]))) {
      return fail(409, 'asker_gone', 'The Overseer who asked can no longer act. Ask again if it is still needed.');
    }
    if (decision === 'decline' && reason.trim().length < 3) return fail(400, 'invalid', 'reason: say why, so the asker knows');
    if (decision === 'approve') await apply(t, a, me);
    await t.query(`UPDATE staff_approvals SET status = $2, decided_by = $3, decided_at = now(), reason = $4 WHERE id = $1`,
      [id, decision === 'approve' ? 'approved' : 'declined', me.id, reason.trim().slice(0, 500)]);
    await logStaff(t, me, 'approval', `${decision === 'approve' ? 'approved' : 'declined'}: ${a.title}`, null, { approval: id, ...(reason ? { reason } : {}) });
  });
}

export async function withdraw(db: Db, me: Actor & { id: string }, id: string): Promise<void> {
  await db.tx(async (t) => {
    const a = await t.one<Approval>(`SELECT * FROM staff_approvals WHERE id = $1 FOR UPDATE`, [id]);
    if (!a) return fail(404, 'not_found', 'No such request');
    if (a.asked_by !== me.id) return fail(403, 'not_yours', 'Only the Overseer who asked can withdraw it');
    if (a.status !== 'waiting') return fail(409, 'decided', 'This request has already been decided');
    await t.query(`UPDATE staff_approvals SET status = 'withdrawn', decided_at = now() WHERE id = $1`, [id]);
    await logStaff(t, me, 'approval', `withdrew: ${a.title}`, null, { approval: id });
  });
}

/** Make the approved change. Checks again, because things may have moved in 72 hours. */
async function apply(t: Db, a: Approval, me: Actor): Promise<void> {
  const p = a.payload;
  if (a.kind === 'overseer_add') {
    const u = await t.one<{ id: string; handle: string }>(`SELECT id, handle FROM users WHERE id = $1 AND status = 'active'`, [p.user_id]);
    if (!u) return fail(409, 'gone', 'That account is no longer active');
    await t.query(
      `INSERT INTO staff_members (user_id, role, ends_at, granted_by) VALUES ($1, $2, NULL, $3)
       ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, ends_at = NULL, granted_by = EXCLUDED.granted_by, granted_at = now()`,
      [u.id, OVERSEER, a.asked_by]);
    await logStaff(t, me, 'staff', 'made an Overseer (two people)', u);
  } else if (a.kind === 'overseer_remove') {
    const u = await t.one<{ id: string; handle: string }>(`SELECT u.id, u.handle FROM users u JOIN staff_members sm ON sm.user_id = u.id AND sm.role = $2 WHERE u.id = $1`, [p.user_id, OVERSEER]);
    if (!u) return fail(409, 'gone', 'That person is no longer an Overseer');
    if ((await overseerCount(t, { except: u.id, lock: true })) < 1) return fail(409, 'last_overseer', 'Community must keep at least one Overseer who can act');
    await t.query('DELETE FROM staff_members WHERE user_id = $1', [u.id]);
    await t.query(`UPDATE staff_approvals SET status = 'withdrawn', decided_at = now(), reason = 'The Overseer who asked was removed'
                   WHERE asked_by = $1 AND status = 'waiting' AND id <> $2`, [u.id, a.id]);
    await t.query('DELETE FROM staff_sessions WHERE user_id = $1', [u.id]);
    await t.query('DELETE FROM staff_passkeys WHERE user_id = $1', [u.id]);
    await logStaff(t, me, 'staff', 'removed an Overseer (two people)', u);
  } else if (a.kind === 'switch') {
    await setSwitch(t, p.key as SwitchKey, p.on === true, a.asked_by, String(p.note || ''));
    await logStaff(t, me, 'switch', `switched ${p.on ? 'on' : 'off'} "${p.key}" (two people)`);
  } else if (a.kind === 'feature') {
    const f = await t.one('UPDATE feature_switches SET production = $2 WHERE id = $1 RETURNING 1', [p.id, p.on === true]);
    if (!f) return fail(409, 'gone', 'That feature switch no longer exists');
    await logStaff(t, me, 'switch', `switched ${p.on ? 'on' : 'off'} "${p.id}" in production (two people)`);
  }
}
