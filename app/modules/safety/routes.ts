// Safety and your data (decision 0001; decision 0003 for Space moderators): the report button, the
// review queue, take-downs with every action logged and shown to the person, appeals decided by a
// different staff member, and one-tap export and delete. Child safety (RA 11930): a child_safety
// report hides the content at once and goes to staff only. Every count here is live, with `as_of`.
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../../db/index.ts';
import { fail, isUuid, json, noContent, type Ctx, type Router, type SessionUser } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { can, endSession, requireScope, requireUser } from '../../http/session.ts';
import { OVERSEER } from '../../http/scopes.ts';
import { bad, oneOf, page, PERSON_COLS, str, type Person } from '../shared.ts';
import { lockOverseers, overseerCount } from '../staff/members.ts';

const TARGET_KINDS = ['post', 'message', 'dm', 'user', 'gig', 'space'] as const;
type TargetKind = (typeof TARGET_KINDS)[number];
const REASONS = ['scam', 'harassment', 'private_info', 'violence', 'child_safety', 'other'] as const;
const ACTIONS = ['keep', 'warn', 'remove', 'escalate'] as const;
type Action = (typeof ACTIONS)[number];
const STATUS_OF: Record<Action, string> = { keep: 'kept', warn: 'warned', remove: 'removed', escalate: 'escalated' };
/** Actions a person can appeal: the ones that did something to them. */
const APPEALABLE = new Set(['warn', 'remove', 'suspend']);

const now = (): string => new Date().toISOString();

/**
 * SQL: the target of the row aliased `x` has a child-safety report that wasn't kept. Kept means staff with
 * reports.child_safety found it was not a child-safety case; any other status keeps the target with them.
 */
const CS_TARGET = (x: string) => `EXISTS (SELECT 1 FROM reports cs WHERE cs.target_kind = ${x}.target_kind AND cs.target_id = ${x}.target_id AND cs.reason = 'child_safety' AND cs.status <> 'kept')`;
/** Is this target a child-safety case (see CS_TARGET)? Then only reports.child_safety may see or decide anything about it. */
const csTarget = async (db: Db, kind: string, id: string): Promise<boolean> =>
  !!(await db.one(`SELECT 1 FROM reports WHERE target_kind = $1 AND target_id = $2 AND reason = 'child_safety' AND status <> 'kept'`, [kind, id]));

/** Signed in, active or suspended. Data rights (see, export, delete, appeal) never stop at a suspension. */
function signedIn(ctx: Ctx): SessionUser {
  if (!ctx.user) return fail(401, 'sign_in', 'Sign in first');
  return ctx.user;
}

interface Target {
  /** Whose content it is (the person a decision is about), or null when that account is gone. */
  subject_id: string | null;
  /** The Space whose moderators review it, or null for staff-only targets. */
  space_id: string | null;
  space_private: boolean;
  deleted: boolean;
  /** For DMs: the two people in the conversation. */
  members?: [string, string];
  preview: Record<string, unknown>;
}

/** Load a report target, including hidden or removed content (moderators need to see what it was). */
async function loadTarget(db: Db, kind: TargetKind, id: string): Promise<Target | null> {
  switch (kind) {
    case 'post': {
      const p = await db.one<{ author_id: string; space_id: string | null; private: boolean | null; body: string; reply_to: string | null; created_at: string; deleted_at: string | null }>(
        `SELECT p.author_id, p.space_id, s.visibility = 'private' AS private, p.body, p.reply_to, p.created_at, p.deleted_at
         FROM posts p LEFT JOIN spaces s ON s.id = p.space_id WHERE p.id = $1`, [id]);
      if (!p) return null;
      return { subject_id: p.author_id, space_id: p.space_id, space_private: !!p.private, deleted: !!p.deleted_at,
        preview: { body: p.body, reply_to: p.reply_to, created_at: p.created_at, hidden: !!p.deleted_at } };
    }
    case 'message': {
      const m = await db.one<{ author_id: string; space_id: string; private: boolean; body: string | null; created_at: string; deleted_at: string | null }>(
        `SELECT m.author_id, c.space_id, s.visibility = 'private' AS private, m.body, m.created_at, m.deleted_at
         FROM messages m JOIN channels c ON c.id = m.channel_id JOIN spaces s ON s.id = c.space_id WHERE m.id = $1`, [id]);
      if (!m) return null;
      return { subject_id: m.author_id, space_id: m.space_id, space_private: m.private, deleted: !!m.deleted_at,
        preview: { body: m.body, sealed: m.body === null, created_at: m.created_at, hidden: !!m.deleted_at } };
    }
    case 'dm': {
      const d = await db.one<{ sender_id: string; user_a: string; user_b: string; created_at: string }>(
        `SELECT d.sender_id, c.user_a, c.user_b, d.created_at FROM dm_messages d JOIN conversations c ON c.id = d.conversation_id WHERE d.id = $1`, [id]);
      if (!d) return null;
      // The server cannot read a DM: moderators see only what the reporter chose to reveal.
      return { subject_id: d.sender_id, space_id: null, space_private: false, deleted: false, members: [d.user_a, d.user_b],
        preview: { sealed: true, created_at: d.created_at } };
    }
    case 'user': {
      const u = await db.one<{ id: string; handle: string; status: string }>(`SELECT id, handle, status FROM users WHERE id = $1`, [id]);
      if (!u) return null;
      return { subject_id: u.id, space_id: null, space_private: false, deleted: u.status === 'deleted', preview: { handle: u.handle, status: u.status } };
    }
    case 'gig': {
      const g = await db.one<{ poster_id: string; space_id: string | null; private: boolean | null; title: string; body: string; status: string }>(
        `SELECT g.poster_id, g.space_id, s.visibility = 'private' AS private, g.title, g.body, g.status
         FROM gigs g LEFT JOIN spaces s ON s.id = g.space_id WHERE g.id = $1`, [id]);
      if (!g) return null;
      return { subject_id: g.poster_id, space_id: g.space_id, space_private: !!g.private, deleted: false, preview: { title: g.title, body: g.body, status: g.status } };
    }
    case 'space': {
      // A report about a Space itself goes to staff, never to that Space's own moderators.
      const s = await db.one<{ created_by: string; slug: string; name: string; visibility: string; id: string }>(
        `SELECT id, created_by, slug, name, visibility FROM spaces WHERE id = $1`, [id]);
      if (!s) return null;
      return { subject_id: s.created_by, space_id: null, space_private: s.visibility === 'private', deleted: false, preview: { slug: s.slug, name: s.name } };
    }
  }
}

/** Can this person see the target at all? Reporting something you cannot see is refused as not found. */
async function canSee(db: Db, me: SessionUser, kind: TargetKind, id: string, t: Target): Promise<boolean> {
  if (t.deleted) return false;
  if (kind === 'dm') return !!t.members?.includes(me.id);
  if (kind === 'user') return true;
  const spaceId = kind === 'space' ? id : t.space_id;
  if (t.space_private && spaceId) return !!(await db.one('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, me.id]));
  return true;
}

/** Space ids where this person is owner or moderator. */
async function modSpaces(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db.query<{ space_id: string }>(`SELECT space_id FROM space_members WHERE user_id = $1 AND role IN ('owner', 'moderator')`, [userId]);
  return new Set(rows.map((r) => r.space_id));
}

function checkRevealed(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) return bad('revealed', 'must be a list of 1 to 20 messages');
  for (const m of v) {
    if (!m || typeof m !== 'object' || typeof (m as { text?: unknown }).text !== 'string' || ((m as { text: string }).text.length > 4000)) {
      return bad('revealed', 'each message needs its text (at most 4000 characters)');
    }
  }
  const s = JSON.stringify(v);
  if (s.length > 40_000) return bad('revealed', 'is too large');
  return s;
}

interface ReportRow {
  id: string; reporter_id: string; target_kind: TargetKind; target_id: string; space_id: string | null; space_slug?: string | null;
  reason: string; note: string; revealed: unknown; status: string; hid_content: boolean; created_at: string;
  decided_at: string | null; decision_note: string;
}

async function person(db: Db, id: string | null): Promise<Person | null> {
  if (!id) return null;
  return db.one<Person>(`SELECT ${PERSON_COLS} FROM users u WHERE u.id = $1`, [id]);
}

export function register(r: Router): void {
  // ---- The report button ----
  r.post('/reports', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const kind = oneOf(b.target_kind, 'target_kind', TARGET_KINDS);
    const targetId = typeof b.target_id === 'string' && isUuid(b.target_id) ? b.target_id : bad('target_id', 'must be an id');
    const reason = oneOf(b.reason, 'reason', REASONS);
    const note = str(b.note, 'note', { max: 500, optional: true });
    const revealed = checkRevealed(b.revealed);
    if (revealed && kind !== 'dm') return bad('revealed', 'is only for direct messages');
    const t = await loadTarget(ctx.db, kind, targetId);
    if (!t || !(await canSee(ctx.db, me, kind, targetId, t))) return fail(404, 'not_found', 'There is nothing to report there');
    if (t.subject_id === me.id) return fail(400, 'self', 'You cannot report yourself or your own content');
    if (await ctx.db.one('SELECT 1 FROM reports WHERE reporter_id = $1 AND target_kind = $2 AND target_id = $3', [me.id, kind, targetId])) {
      return fail(409, 'already_reported', 'You have already reported this');
    }
    const childSafety = reason === 'child_safety';
    const report = await ctx.db.tx(async (tx) => {
      // RA 11930: hide child-safety reports at once, before anyone reviews them.
      let hid = false;
      if (childSafety && (kind === 'post' || kind === 'message')) {
        const table = kind === 'post' ? 'posts' : 'messages';
        hid = !!(await tx.one(`UPDATE ${table} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING 1`, [targetId]));
      }
      const row = await tx.one<{ id: string; status: string; created_at: string }>(
        `INSERT INTO reports (reporter_id, target_kind, target_id, space_id, reason, note, revealed, hid_content)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) ON CONFLICT DO NOTHING RETURNING id, status, created_at`,
        [me.id, kind, targetId, t.space_id, reason, note, revealed, hid]);
      // a second report raced in: throw, so the transaction (and any hide) rolls back
      return row ?? fail(409, 'already_reported', 'You have already reported this');
    });
    return json({ report: { id: report.id, target_kind: kind, target_id: targetId, reason, status: report.status, created_at: report.created_at,
      goes_to: childSafety || !t.space_id ? 'staff' : 'space_moderators' } }, 201);
  });

  // ---- The review queue: staff see everything; a Space's owner and moderators see their Space ----
  r.get('/mod/reports', async (ctx) => {
    const me = requireUser(ctx);
    const staff = can(me, 'reports.review');
    const { limit: n, before } = page(ctx.query);
    const decided = ctx.query.get('status') === 'decided';
    const slug = ctx.query.get('space');
    const where: string[] = [], vals: unknown[] = [];
    const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('$?', `$${vals.length}`)); };
    let spaceId: string | null = null;
    if (slug) {
      const s = await ctx.db.one<{ id: string }>('SELECT id FROM spaces WHERE slug = $1', [slug]);
      if (!s) return fail(404, 'not_found', 'No such Space');
      spaceId = s.id;
    }
    if (staff) {
      where.push(decided ? `r.status NOT IN ('open', 'escalated')` : `r.status IN ('open', 'escalated')`);
      if (!can(me, 'reports.child_safety')) where.push(`r.reason <> 'child_safety' AND NOT ${CS_TARGET('r')}`);
      if (spaceId) add('r.space_id = $?', spaceId);
    } else {
      const mine = await modSpaces(ctx.db, me.id);
      if (spaceId && !mine.has(spaceId)) return fail(403, 'not_moderator', 'You do not moderate this Space');
      if (!mine.size) return fail(403, 'not_moderator', 'Only staff and Space moderators can see reports');
      // child_safety goes to staff only, whatever Space it came from, with every other report on the same target.
      where.push(`r.reason <> 'child_safety' AND NOT ${CS_TARGET('r')}`);
      where.push(decided ? `r.status <> 'open'` : `r.status = 'open'`);
      if (spaceId) add('r.space_id = $?', spaceId);
      else add('r.space_id = ANY ($?::uuid[])', [...mine]);
    }
    if (before) add('r.created_at < $?', before);
    vals.push(n);
    const rows = await ctx.db.query<ReportRow>(
      `SELECT r.id, r.reporter_id, r.target_kind, r.target_id, r.space_id, sp.slug AS space_slug, r.reason, r.note, r.revealed,
         r.status, r.hid_content, r.created_at, r.decided_at, r.decision_note
       FROM reports r LEFT JOIN spaces sp ON sp.id = r.space_id
       WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT $${vals.length}`, vals);
    const reports = [];
    for (const row of rows) {
      const t = await loadTarget(ctx.db, row.target_kind, row.target_id);
      // A moderator never reviews reports about their own content.
      if (!staff && t?.subject_id === me.id) continue;
      reports.push({
        id: row.id, target_kind: row.target_kind, target_id: row.target_id, space: row.space_id ? { id: row.space_id, slug: row.space_slug } : null,
        reason: row.reason, note: row.note, status: row.status, created_at: row.created_at, decided_at: row.decided_at, decision_note: row.decision_note,
        hidden_on_report: row.hid_content,
        target: t ? { ...t.preview, author: await person(ctx.db, t.subject_id) } : null,
        // Who reported, and what they revealed from a DM, is for staff only: it protects reporters.
        reporter: staff ? await person(ctx.db, row.reporter_id) : null,
        revealed: staff ? row.revealed : null,
      });
    }
    return json({ reports, as_of: now() });
  });

  r.post('/mod/reports/:id/decide', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const staff = can(me, 'reports.review');
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such report');
    const b = await ctx.json<Record<string, unknown>>();
    const action = oneOf(b.action, 'action', ACTIONS);
    const note = str(b.note, 'note', { min: action === 'warn' || action === 'remove' ? 3 : 0, max: 500, optional: action === 'keep' || action === 'escalate' });
    const rep = await ctx.db.one<ReportRow>('SELECT * FROM reports WHERE id = $1', [ctx.params.id]);
    if (!rep) return fail(404, 'not_found', 'No such report');
    const childSafety = rep.reason === 'child_safety';
    const csAny = childSafety || await csTarget(ctx.db, rep.target_kind, rep.target_id);
    if (csAny && !can(me, 'reports.child_safety')) return fail(404, 'not_found', 'No such report');
    if (!staff) {
      // Hide the existence of staff-only reports from everyone else.
      if (csAny || !rep.space_id) return fail(404, 'not_found', 'No such report');
      if (!(await modSpaces(ctx.db, me.id)).has(rep.space_id)) return fail(403, 'not_moderator', 'You do not moderate this Space');
    }
    if (!(rep.status === 'open' || (rep.status === 'escalated' && staff))) return fail(409, 'decided', 'This report has already been decided');
    const t = await loadTarget(ctx.db, rep.target_kind, rep.target_id);
    if (t?.subject_id === me.id) return fail(403, 'own_content', 'Someone else must decide reports about your own content');
    let logged: string = action;
    if (action === 'remove') {
      if (rep.target_kind === 'space') return fail(400, 'not_supported', 'Removing a whole Space is not built yet: escalate it to staff');
      if ((rep.target_kind === 'user' || rep.target_kind === 'dm') && !can(me, 'accounts.suspend')) return fail(403, 'staff_only', 'Only staff can do that');
      if (rep.target_kind === 'user') logged = 'suspend';
      // An Overseer is removed by two Overseers (decision 0009), never suspended through a report: that
      // would lock them out on one person's say.
      if (rep.target_kind === 'user' && await ctx.db.one('SELECT 1 FROM staff_members WHERE user_id = $1 AND role = $2', [rep.target_id, OVERSEER])) {
        return fail(403, 'overseer', 'An Overseer is removed with two people, not suspended');
      }
    }
    await ctx.db.tx(async (tx) => {
      if (action === 'remove') {
        if (rep.target_kind === 'post') await tx.query('UPDATE posts SET deleted_at = coalesce(deleted_at, now()) WHERE id = $1', [rep.target_id]);
        else if (rep.target_kind === 'message') await tx.query('UPDATE messages SET deleted_at = coalesce(deleted_at, now()) WHERE id = $1', [rep.target_id]);
        else if (rep.target_kind === 'gig') await tx.query(`UPDATE gigs SET status = 'closed' WHERE id = $1`, [rep.target_id]);
        else if (rep.target_kind === 'dm') await tx.query('DELETE FROM dm_messages WHERE id = $1', [rep.target_id]);
        else if (rep.target_kind === 'user') {
          await tx.query(`UPDATE users SET status = 'suspended' WHERE id = $1 AND status = 'active'`, [rep.target_id]);
          await tx.query('DELETE FROM sessions WHERE user_id = $1', [rep.target_id]);
        }
      }
      // A child_safety report hid the content; if staff keep it, it comes back.
      if (action === 'keep' && rep.hid_content) {
        const table = rep.target_kind === 'post' ? 'posts' : 'messages';
        await tx.query(`UPDATE ${table} SET deleted_at = NULL WHERE id = $1`, [rep.target_id]);
      }
      // Decide this report, and on a final decision the other open reports of the same target too.
      await tx.query(
        `UPDATE reports SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3
         WHERE id = $4 OR ($5 AND target_kind = $6 AND target_id = $7 AND status = 'open' AND reason <> 'child_safety')`,
        [STATUS_OF[action], me.id, note, rep.id, action !== 'escalate', rep.target_kind, rep.target_id]);
      // Sealed: a child-safety case passed on. Looked at again here, so a child-safety report made since
      // the first look counts too.
      const sealed = action === 'escalate' && (csAny || await csTarget(tx, rep.target_kind, rep.target_id));
      const a = await tx.one<{ id: string }>(
        `INSERT INTO mod_actions (actor_id, subject_id, action, target_kind, target_id, report_id, reason, sealed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [me.id, t?.subject_id ?? null, logged, rep.target_kind, rep.target_id, rep.id, note, sealed]);
      // Tell the person what was done and why. Not when a child-safety case is passed on to the
      // authorities: tipping off a suspect could put a child at risk.
      if (t?.subject_id && !sealed) {
        await tx.query(`INSERT INTO notifications (user_id, kind, ref_kind, ref_id) VALUES ($1, 'mod_action', 'mod_action', $2)`, [t.subject_id, a!.id]);
      }
    });
    return noContent();
  });

  // ---- What was done to my content, and one appeal each ----
  r.get('/me/mod-actions', async (ctx) => {
    const me = signedIn(ctx);
    const actions = await ctx.db.query<Record<string, unknown> & { action: string; appealed_at: string | null }>(
      `SELECT a.id, a.action, a.target_kind, a.target_id, a.reason, a.created_at, a.appealed_at, a.appeal_note,
         a.appeal_decision, a.appeal_decision_note, a.appeal_decided_at
       FROM mod_actions a
       WHERE a.subject_id = $1 AND NOT a.sealed
       ORDER BY a.created_at DESC LIMIT 200`, [me.id]);
    return json({ actions: actions.map((a) => ({ ...a, can_appeal: APPEALABLE.has(a.action) && !a.appealed_at })), as_of: now() });
  });

  r.post('/me/mod-actions/:id/appeal', async (ctx) => {
    const me = signedIn(ctx);
    limit(limits.write, me.id);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such action');
    const b = await ctx.json<Record<string, unknown>>();
    const note = str(b.note, 'note', { min: 3, max: 1000 });
    const a = await ctx.db.one<{ action: string; appealed_at: string | null }>(
      'SELECT action, appealed_at FROM mod_actions WHERE id = $1 AND subject_id = $2 AND NOT sealed', [ctx.params.id, me.id]);
    if (!a) return fail(404, 'not_found', 'No such action');
    if (!APPEALABLE.has(a.action)) return fail(400, 'not_appealable', 'Only a warning, a removal or a suspension can be appealed');
    const done = await ctx.db.one(
      'UPDATE mod_actions SET appealed_at = now(), appeal_note = $2 WHERE id = $1 AND appealed_at IS NULL RETURNING 1', [ctx.params.id, note]);
    if (!done) return fail(409, 'already_appealed', 'You have already appealed this');
    return noContent();
  });

  // ---- Appeals: staff only, and never the person who took the action ----
  r.get('/mod/appeals', async (ctx) => {
    const me = requireScope(ctx, 'reports.review');
    const rows = await ctx.db.query<Record<string, unknown> & { actor_id: string; subject_id: string | null }>(
      `SELECT a.id, a.actor_id, a.subject_id, a.action, a.target_kind, a.target_id, a.report_id, a.reason, a.created_at, a.appealed_at, a.appeal_note
       FROM mod_actions a
       WHERE a.appealed_at IS NOT NULL AND a.appeal_decision IS NULL AND ($1 OR NOT ${CS_TARGET('a')})
       ORDER BY a.appealed_at LIMIT 100`, [can(me, 'reports.child_safety')]);
    const appeals = [];
    for (const { actor_id, subject_id, ...a } of rows) {
      appeals.push({ ...a, subject: await person(ctx.db, subject_id), can_decide: actor_id !== me.id && subject_id !== me.id });
    }
    return json({ appeals, as_of: now() });
  });

  r.post('/mod/appeals/:id/decide', async (ctx) => {
    const me = requireScope(ctx, 'reports.review');
    limit(limits.write, me.id);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such appeal');
    const b = await ctx.json<Record<string, unknown>>();
    const decision = oneOf(b.decision, 'decision', ['upheld', 'overturned'] as const);
    const note = str(b.note, 'note', { min: 3, max: 500 });
    const a = await ctx.db.one<{ id: string; actor_id: string; subject_id: string | null; action: string; target_kind: string; target_id: string; report_id: string | null; appealed_at: string | null; appeal_decision: string | null }>(
      'SELECT id, actor_id, subject_id, action, target_kind, target_id, report_id, appealed_at, appeal_decision FROM mod_actions WHERE id = $1', [ctx.params.id]);
    if (!a || !a.appealed_at) return fail(404, 'not_found', 'No such appeal');
    if (!can(me, 'reports.child_safety') && await csTarget(ctx.db, a.target_kind, a.target_id)) return fail(404, 'not_found', 'No such appeal');
    if (a.appeal_decision) return fail(409, 'decided', 'This appeal has already been decided');
    if (a.actor_id === me.id) return fail(403, 'same_moderator', 'A different staff member must decide this appeal');
    if (a.subject_id === me.id) return fail(403, 'own_content', 'You cannot decide your own appeal');
    await ctx.db.tx(async (tx) => {
      const done = await tx.one(
        `UPDATE mod_actions SET appeal_decision = $2, appeal_decision_note = $3, appeal_decided_by = $4, appeal_decided_at = now()
         WHERE id = $1 AND appeal_decision IS NULL RETURNING 1`, [a.id, decision, note, me.id]);
      if (!done) fail(409, 'decided', 'This appeal has already been decided');
      if (decision === 'overturned') {
        if (await tx.one(
          `SELECT 1 FROM reports WHERE target_kind = $1 AND target_id = $2 AND reason = 'child_safety' AND status IN ('open', 'escalated')`, [a.target_kind, a.target_id])) {
          fail(409, 'child_safety_open', 'A child-safety report on this is still open: it stays hidden until that is decided');
        }
        if (a.action === 'remove' && a.target_kind === 'post') await tx.query('UPDATE posts SET deleted_at = NULL WHERE id = $1', [a.target_id]);
        if (a.action === 'remove' && a.target_kind === 'message') await tx.query('UPDATE messages SET deleted_at = NULL WHERE id = $1', [a.target_id]);
        if (a.action === 'remove' && a.target_kind === 'gig') await tx.query(`UPDATE gigs SET status = 'open' WHERE id = $1 AND status = 'closed'`, [a.target_id]);
        if (a.action === 'suspend') await tx.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'suspended'`, [a.target_id]);
        await tx.query(
          `INSERT INTO mod_actions (actor_id, subject_id, action, target_kind, target_id, report_id, reason) VALUES ($1, $2, 'restore', $3, $4, $5, $6)`,
          [me.id, a.subject_id, a.target_kind, a.target_id, a.report_id, note]);
      }
      if (a.subject_id) await tx.query(`INSERT INTO notifications (user_id, kind, ref_kind, ref_id) VALUES ($1, 'mod_action', 'mod_action', $2)`, [a.subject_id, a.id]);
    });
    return noContent();
  });

  // ---- Your data: what we hold, in plain words, with live counts ----
  r.get('/me/data', async (ctx) => {
    const me = signedIn(ctx);
    const c = await ctx.db.one<Record<string, number>>(
      `SELECT
         (SELECT count(*)::int FROM posts WHERE author_id = $1 AND reply_to IS NULL AND deleted_at IS NULL) AS posts,
         (SELECT count(*)::int FROM posts WHERE author_id = $1 AND reply_to IS NOT NULL AND deleted_at IS NULL) AS replies,
         (SELECT count(*)::int FROM posts WHERE author_id = $1 AND deleted_at IS NOT NULL) AS hidden_posts,
         (SELECT count(*)::int FROM salamats WHERE giver_id = $1) AS salamats_given,
         (SELECT count(*)::int FROM salamats WHERE receiver_id = $1) AS salamats_received,
         (SELECT count(*)::int FROM follows WHERE follower_id = $1) AS following,
         (SELECT count(*)::int FROM follows WHERE followee_id = $1) AS followers,
         (SELECT count(*)::int FROM saves WHERE user_id = $1) AS saves,
         (SELECT count(*)::int FROM space_members WHERE user_id = $1) AS spaces,
         (SELECT count(*)::int FROM messages WHERE author_id = $1 AND deleted_at IS NULL) AS space_messages,
         (SELECT count(*)::int FROM dm_messages WHERE sender_id = $1) AS dm_messages,
         (SELECT count(*)::int FROM conversations WHERE user_a = $1 OR user_b = $1) AS conversations,
         (SELECT count(*)::int FROM gigs WHERE poster_id = $1) AS gigs,
         (SELECT count(*)::int FROM applications WHERE applicant_id = $1) AS applications,
         (SELECT count(*)::int FROM ratings WHERE rater_id = $1) AS ratings_given,
         (SELECT count(*)::int FROM ratings WHERE ratee_id = $1) AS ratings_received,
         (SELECT count(*)::int FROM credentials WHERE user_id = $1) AS credentials,
         (SELECT count(*)::int FROM media WHERE owner_id = $1) AS media,
         (SELECT count(*)::int FROM sessions WHERE user_id = $1 AND expires_at > now()) AS sessions,
         (SELECT count(*)::int FROM passkeys WHERE user_id = $1) AS passkeys,
         (SELECT count(*)::int FROM notifications WHERE user_id = $1) AS notifications,
         (SELECT count(*)::int FROM reports WHERE reporter_id = $1) AS reports_made,
         (SELECT count(*)::int FROM mod_actions WHERE subject_id = $1 AND NOT sealed) AS mod_actions`, [me.id]);
    const n = c!;
    const holds = [
      { key: 'profile', what: 'Your profile: username, first name, trade, bio, home area, photo and settings', count: 1 },
      { key: 'posts', what: 'Posts you wrote', count: n.posts },
      { key: 'replies', what: 'Replies you wrote', count: n.replies },
      { key: 'hidden_posts', what: 'Posts and replies you deleted or that were taken down (hidden from everyone, still kept)', count: n.hidden_posts },
      { key: 'salamats_given', what: 'Salamats you gave', count: n.salamats_given },
      { key: 'salamats_received', what: 'Salamats you received', count: n.salamats_received },
      { key: 'following', what: 'People you follow', count: n.following },
      { key: 'followers', what: 'People who follow you', count: n.followers },
      { key: 'saves', what: 'Posts and gigs you saved', count: n.saves },
      { key: 'spaces', what: 'Spaces you belong to', count: n.spaces },
      { key: 'space_messages', what: 'Messages you wrote in Spaces (private Spaces: sealed, we cannot read them)', count: n.space_messages },
      { key: 'conversations', what: 'Direct conversations you are in', count: n.conversations },
      { key: 'dm_messages', what: 'Direct messages you sent, sealed end to end: we cannot read them', count: n.dm_messages },
      { key: 'gigs', what: 'Gigs you posted', count: n.gigs },
      { key: 'applications', what: 'Gig applications you sent', count: n.applications },
      { key: 'ratings_given', what: 'Ratings you gave', count: n.ratings_given },
      { key: 'ratings_received', what: 'Ratings you received', count: n.ratings_received },
      { key: 'credentials', what: 'Signed credentials you added', count: n.credentials },
      { key: 'media', what: 'Images you uploaded', count: n.media },
      { key: 'sessions', what: 'Devices signed in to your account', count: n.sessions },
      { key: 'passkeys', what: 'Passkeys you sign in with (public keys only)', count: n.passkeys },
      { key: 'notifications', what: 'Notifications for you', count: n.notifications },
      { key: 'reports_made', what: 'Reports you made', count: n.reports_made },
      { key: 'mod_actions', what: 'Moderation actions on your content', count: n.mod_actions },
    ];
    return json({
      holds,
      sealed: { what: 'Kept in the sealed vault: none yet', count: 0, note: 'The sealed identity vault is not built yet, so nothing about you is kept there.' },
      as_of: now(),
    });
  });

  // ---- One-tap export: this person's own rows, never other people's private data ----
  r.get('/me/export', async (ctx) => {
    const me = signedIn(ctx);
    const q = <T = Record<string, unknown>>(sql: string) => ctx.db.query<T>(sql, [me.id]);
    const data = {
      exported_at: now(),
      about: 'Everything PopCart Community holds about you. Direct messages are the sealed envelopes: only your device can open them.',
      profile: (await q(`SELECT id, handle, first_name, trade, bio, home_area, avatar_media_id, cover_media_id, status, terms_version,
        terms_accepted_at, improve_usage, improve_surveys, dm_public_key, created_at FROM users WHERE id = $1`))[0] ?? null,
      staff_role: (await q(`SELECT role, ends_at, granted_at FROM staff_members WHERE user_id = $1`))[0] ?? null,
      posts: await q(`SELECT id, body, reply_to, space_id, media_ids, reach, area_code, lang, created_at, deleted_at FROM posts WHERE author_id = $1 ORDER BY created_at`),
      salamats_given: await q(`SELECT s.id, s.post_id, s.gig_id, u.handle AS to_handle, s.tags, s.week, s.created_at
        FROM salamats s JOIN users u ON u.id = s.receiver_id WHERE s.giver_id = $1 ORDER BY s.created_at`),
      // who gave a salamat is theirs to export, not yours: received ones carry only what and when
      salamats_received: await q(`SELECT id, post_id, gig_id, tags, week, created_at FROM salamats WHERE receiver_id = $1 ORDER BY created_at`),
      following: await q(`SELECT u.handle, f.created_at FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = $1 ORDER BY f.created_at`),
      followers: await q(`SELECT u.handle, f.created_at FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = $1 AND u.status = 'active' ORDER BY f.created_at`),
      saves: await q(`SELECT post_id, gig_id, created_at FROM saves WHERE user_id = $1 ORDER BY created_at`),
      spaces: await q(`SELECT s.slug, s.name, m.role, m.joined_at FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE m.user_id = $1 ORDER BY m.joined_at`),
      space_messages: await q(`SELECT m.id, s.slug AS space, c.name AS channel, m.body, m.sealed, m.created_at, m.deleted_at
        FROM messages m JOIN channels c ON c.id = m.channel_id JOIN spaces s ON s.id = c.space_id WHERE m.author_id = $1 ORDER BY m.created_at`),
      conversations: await q(`SELECT c.id, u.handle AS with_handle, c.accepted, c.created_at FROM conversations c
        JOIN users u ON u.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END WHERE c.user_a = $1 OR c.user_b = $1 ORDER BY c.created_at`),
      dm_messages: await q(`SELECT d.id, d.conversation_id, d.sender_id = $1 AS sent_by_me, d.sealed, d.created_at FROM dm_messages d
        JOIN conversations c ON c.id = d.conversation_id WHERE c.user_a = $1 OR c.user_b = $1 ORDER BY d.created_at`),
      gigs: await q(`SELECT id, space_id, title, body, pay_amount, pay_currency, pay_unit, pay_note, when_text, paid_how, skills, area_code, status, created_at
        FROM gigs WHERE poster_id = $1 ORDER BY created_at`),
      applications: await q(`SELECT id, gig_id, note, credential_ids, status, done_by_poster, done_by_applicant, created_at FROM applications WHERE applicant_id = $1 ORDER BY created_at`),
      ratings_given: await q(`SELECT id, gig_id, on_time, quality, easy, again, created_at FROM ratings WHERE rater_id = $1 ORDER BY created_at`),
      ratings_received: await q(`SELECT id, gig_id, on_time, quality, easy, again, created_at FROM ratings WHERE ratee_id = $1 ORDER BY created_at`),
      credentials: await q(`SELECT id, issuer, type, summary, as_of, vc, verified, verified_at, shown, created_at FROM credentials WHERE user_id = $1 ORDER BY created_at`),
      media: await q(`SELECT id, mime, bytes, width, height, sha256, created_at FROM media WHERE owner_id = $1 ORDER BY created_at`),
      sessions: await q(`SELECT created_at, expires_at FROM sessions WHERE user_id = $1 ORDER BY created_at`),
      passkeys: await q(`SELECT id, transports, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at`),
      notifications: await q(`SELECT id, kind, ref_kind, ref_id, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at`),
      reports_made: await q(`SELECT id, target_kind, target_id, reason, note, revealed, status, decided_at, created_at FROM reports WHERE reporter_id = $1 ORDER BY created_at`),
      mod_actions: await q(`SELECT a.id, a.action, a.target_kind, a.target_id, a.reason, a.created_at, a.appealed_at, a.appeal_note, a.appeal_decision,
        a.appeal_decision_note, a.appeal_decided_at FROM mod_actions a
        WHERE a.subject_id = $1 AND NOT a.sealed ORDER BY a.created_at`),
      sealed_vault: { held: [], note: 'The sealed identity vault is not built yet, so nothing about you is kept there.' },
    };
    const day = data.exported_at.slice(0, 10);
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="popcart-community-${me.handle}-${day}.json"`,
      },
      body: JSON.stringify(data, null, 2),
    };
  });

  // ---- One-tap delete ----
  r.delete('/me', async (ctx) => {
    const me = signedIn(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    if (b.confirm !== 'DELETE') return fail(400, 'confirm', 'Type DELETE to confirm');
    const tombstone = `deleted.${randomHex(8)}`;
    const files = await ctx.db.tx(async (tx) => {
      await lockOverseers(tx);
      if (await tx.one(`SELECT 1 FROM staff_members sm JOIN users u ON u.id = sm.user_id WHERE sm.user_id = $1 AND sm.role = $2 AND u.status = 'active'`, [me.id, OVERSEER])
        && (await overseerCount(tx, { except: me.id, lock: true })) < 1) {
        fail(409, 'last_overseer', 'You are the last Overseer. Make someone else an Overseer first, then delete your account.');
      }
      const media = await tx.query<{ id: string }>('DELETE FROM media WHERE owner_id = $1 RETURNING id', [me.id]);
      await tx.query('UPDATE posts SET deleted_at = now() WHERE author_id = $1 AND deleted_at IS NULL', [me.id]);
      await tx.query('UPDATE messages SET deleted_at = now() WHERE author_id = $1 AND deleted_at IS NULL', [me.id]);
      await tx.query(`UPDATE gigs SET status = 'closed' WHERE poster_id = $1 AND status = 'open'`, [me.id]);
      await tx.query(`UPDATE applications SET status = 'withdrawn' WHERE applicant_id = $1 AND status = 'sent'`, [me.id]);
      await tx.query('DELETE FROM follows WHERE follower_id = $1 OR followee_id = $1', [me.id]);
      await tx.query('DELETE FROM saves WHERE user_id = $1', [me.id]);
      await tx.query('DELETE FROM space_members WHERE user_id = $1', [me.id]);
      await tx.query('DELETE FROM credentials WHERE user_id = $1', [me.id]);
      await tx.query('DELETE FROM notifications WHERE user_id = $1', [me.id]);
      await tx.query('DELETE FROM sessions WHERE user_id = $1', [me.id]);
      await tx.query('DELETE FROM passkeys WHERE user_id = $1', [me.id]);
      await tx.query('DELETE FROM staff_members WHERE user_id = $1', [me.id]);
      await tx.query(
        `UPDATE users SET status = 'deleted', handle = $2, first_name = 'Deleted', bio = '', home_area = NULL, avatar_media_id = NULL,
           cover_media_id = NULL, dm_public_key = NULL, improve_usage = false, improve_surveys = false WHERE id = $1`, [me.id, tombstone]);
      return media.map((m) => m.id);
    });
    for (const id of files) await rm(join(ctx.config.mediaDir, id), { force: true });
    return { status: 204, headers: { 'Set-Cookie': await endSession(ctx.db, ctx.config, ctx.req) } };
  });

  // ---- Vault openings for this person ----
  r.get('/me/record-log', (ctx) => {
    signedIn(ctx);
    return json({ openings: [], as_of: now(), note: 'The sealed vault is not built yet, so it has never been opened. When it exists, every opening about you is listed here.' });
  });

  // ---- Transparency report: live counts, never invented ----
  r.get('/transparency', async (ctx) => {
    const c = await ctx.db.one<{ legal_requests: number; produced: number; refused: number; posts_removed: number; reports: number }>(
      `SELECT
         (SELECT count(*)::int FROM legal_requests) AS legal_requests,
         (SELECT count(*)::int FROM legal_requests WHERE outcome = 'produced') AS produced,
         (SELECT count(*)::int FROM legal_requests WHERE outcome = 'refused') AS refused,
         (SELECT count(*)::int FROM mod_actions WHERE action = 'remove' AND target_kind = 'post') AS posts_removed,
         (SELECT count(*)::int FROM reports) AS reports`);
    return json({ as_of: now(), launched: false, counts: c });
  });
}

const randomHex = (n: number): string => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
