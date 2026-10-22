// The Overseer and Admin panels' API (decision 0009, points 10-15). Staff host only, after the gate and
// a staff passkey; every route checks a scope, never a role name. Every change is written to the staff
// audit log. Reports and appeals reuse the public handlers (which Space moderators also use), called with
// the staff session, so a staff member's scopes only ever work here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../db/index.ts';
import { fail, isUuid, json, noContent, Router, type Ctx, type Handler } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { isRoleScope, OVERSEER, OVERSEER_SCOPES, SCOPE_GROUPS, scopesOf, type Scope } from '../../http/scopes.ts';
import type { StaffUser } from '../../http/staff-session.ts';
import { handleKey } from '../accounts/handles.ts';
import { emailHash, emailOf, INVITE_DAYS, inviteByEmail } from '../accounts/routes.ts';
import { registerAppeals } from '../safety/routes.ts';
import { PERSON_COLS, str } from '../shared.ts';
import * as approvals from './approvals.ts';
import { logStaff, readLog } from './audit.ts';
import { DEFAULT_DAYS, grantRole, listStaff, renewRole, revokeRole, roleNames } from './members.ts';
import { requireStaffScope, requireStaffSession } from './routes.ts';
import { readSwitches, setSwitch, SWITCH_KEYS, TWO_PERSON, type SwitchKey } from './switches.ts';

const now = () => new Date().toISOString();
const STARTED = now();
const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
const ROLE_NAME = /^[A-Z][A-Za-z ]{2,29}$/;
const masked = (email: string) => 'an address ending in @' + email.split('@')[1];

/** One of these scopes, or 403. */
function requireAnyScope(ctx: Ctx, scopes: Scope[]): StaffUser {
  const u = requireStaffSession(ctx);
  if (!scopes.some((s) => u.scopes.includes(s))) fail(403, 'no_scope', 'Your role does not allow this');
  return u;
}

const days = (v: unknown): number => {
  const n = v === undefined ? DEFAULT_DAYS : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 366 ? n : fail(400, 'invalid', 'days: a whole number from 1 to 366');
};

async function userByHandle(db: Db, handle: string): Promise<{ id: string; handle: string; status: string }> {
  const u = await db.one<{ id: string; handle: string; status: string }>(
    `SELECT id, handle, status FROM users WHERE handle = $1 AND status <> 'deleted'`, [handle.replace(/^@/, '').toLowerCase()]);
  return u ?? fail(404, 'not_found', 'No one has that username');
}

/** Suspensions with an end date are lifted once it passes. Cheap; run by the server every minute and before reads here. */
export const liftSuspensions = (db: Db) => db.query(
  `UPDATE users SET status = 'active', suspended_until = NULL WHERE status = 'suspended' AND suspended_until IS NOT NULL AND suspended_until <= now()`);

/**
 * Serve a handler from another router at a staff path, as the staff member, and log what it did.
 * The body is read once and kept, so the log can say what was decided.
 */
function alias(staff: Router, from: Router, method: string, staffPath: string, fromPath: string, scope: Scope,
  log?: (ctx: Ctx, me: StaffUser, body: Record<string, unknown>) => Promise<void>): void {
  const m = from.match(method, fromPath.replace(/:\w+/g, '_'));
  if (!m) throw new Error(`alias: no ${method} ${fromPath}`);
  const handler: Handler = async (ctx) => {
    const me = requireStaffScope(ctx, scope);
    let body: Record<string, unknown> | undefined;
    const read = ctx.json.bind(ctx);
    ctx.json = (async () => (body ??= await read<Record<string, unknown>>())) as Ctx['json'];
    const out = await m.handler(ctx);
    if (log) await log(ctx, me, body ?? {});
    return out;
  };
  staff.add(method, staffPath, handler);
}

export function registerPanel(r: Router, pub: Router): void {
  /* ---------- Overview ---------- */
  r.get('/staff/overview', async (ctx) => {
    const me = requireStaffSession(ctx);
    const has = (s: Scope) => me.scopes.includes(s);
    await liftSuspensions(ctx.db);
    const people = await ctx.db.one<{ total: number; week: number; series: number[] }>(
      `SELECT (SELECT count(*)::int FROM users WHERE status = 'active') AS total,
         (SELECT count(*)::int FROM users WHERE status = 'active' AND created_at > now() - interval '7 days') AS week,
         ARRAY(SELECT (SELECT count(*)::int FROM users WHERE status = 'active' AND created_at <= now() - make_interval(weeks => w))
               FROM generate_series(7, 0, -1) AS w) AS series`);
    const out: Record<string, unknown> = {
      as_of: now(),
      people,
      joining: { invite_only: true, note: 'Joining is by invite until the privacy review (decision 0006).' },
      switches: Object.fromEntries((await readSwitches(ctx.db)).map((s) => [s.key, s.is_on])),
    };
    const needs: { kind: string; count: number; text: string }[] = [];
    if (has('reports.review')) {
      const cs = has('reports.child_safety');
      const rep = await ctx.db.one<{ open: number; series: number[] }>(
        `SELECT (SELECT count(*)::int FROM reports WHERE status IN ('open', 'escalated') AND ($1 OR reason <> 'child_safety')) AS open,
           ARRAY(SELECT (SELECT count(*)::int FROM reports WHERE ($1 OR reason <> 'child_safety')
                   AND created_at >= date_trunc('day', now()) - make_interval(days => d) AND created_at < date_trunc('day', now()) - make_interval(days => d - 1))
                 FROM generate_series(6, 0, -1) AS d) AS series`, [cs]);
      out.reports = rep;
      if (rep!.open) needs.push({ kind: 'reports', count: rep!.open, text: rep!.open === 1 ? 'report to decide' : 'reports to decide' });
    }
    if (has('staff.manage')) {
      const st = await ctx.db.one<{ total: number; ending: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE sm.ends_at < now() + interval '14 days')::int AS ending
         FROM staff_members sm JOIN users u ON u.id = sm.user_id WHERE (sm.ends_at IS NULL OR sm.ends_at > now()) AND u.status <> 'deleted'`);
      out.staff = st;
      if (st!.ending) needs.push({ kind: 'staff', count: st!.ending, text: st!.ending === 1 ? 'role ends within 14 days' : 'roles end within 14 days' });
    }
    if (has('approvals.decide')) {
      const waiting = (await approvals.list(ctx.db, me.id, 'waiting')).filter((a) => a.can_decide).length;
      if (waiting) needs.unshift({ kind: 'approvals', count: waiting, text: waiting === 1 ? 'request needs your approval' : 'requests need your approval' });
    }
    out.needs = needs;
    if (has('audit.read')) out.latest = await readLog(ctx.db, { limit: 6 });
    return json(out);
  });

  /* ---------- Approvals (two people) ---------- */
  r.get('/staff/approvals', async (ctx) => {
    const me = requireStaffScope(ctx, 'approvals.decide');
    const status = ctx.query.get('status') === 'done' ? 'done' : 'waiting';
    return json({ approvals: await approvals.list(ctx.db, me.id, status), overseers: await approvals.overseerCount(ctx.db), window_hours: approvals.WINDOW_HOURS, as_of: now() });
  });
  for (const d of ['approve', 'decline'] as const) {
    r.post(`/staff/approvals/:id/${d}`, async (ctx) => {
      const me = requireStaffScope(ctx, 'approvals.decide');
      if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such request');
      const b = await ctx.json<{ reason?: unknown }>();
      await approvals.decide(ctx.db, me, ctx.params.id!, d, typeof b.reason === 'string' ? b.reason : '');
      return noContent();
    });
  }
  r.post('/staff/approvals/:id/withdraw', async (ctx) => {
    const me = requireStaffScope(ctx, 'approvals.decide');
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such request');
    await approvals.withdraw(ctx.db, me, ctx.params.id!);
    return noContent();
  });

  /* ---------- Staff ---------- */
  r.get('/staff/members', async (ctx) => {
    requireStaffScope(ctx, 'staff.manage');
    const invites = await ctx.db.query(
      `SELECT encode(sha256(i.code_hash), 'hex') AS id, coalesce(i.staff_role, $1) AS role, i.staff_days AS days, i.note, i.expires_at, g.handle AS invited_by
       FROM invites i LEFT JOIN users g ON g.id = i.created_by
       WHERE i.role = 'staff' AND i.used_at IS NULL AND i.expires_at > now() ORDER BY i.expires_at`, [OVERSEER]);
    return json({ staff: await listStaff(ctx.db), invites, roles: await roleNames(ctx.db), overseers: await approvals.overseerCount(ctx.db), default_days: DEFAULT_DAYS, as_of: now() });
  });

  // Give someone a role (or change it). Making an Overseer needs a second Overseer.
  r.post('/staff/members', async (ctx) => {
    const me = requireStaffScope(ctx, 'staff.manage');
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const u = await userByHandle(ctx.db, str(b.handle, 'handle', { min: 3, max: 31 }));
    if (u.status !== 'active') return fail(409, 'not_active', 'That account is suspended');
    const role = str(b.role, 'role', { min: 3, max: 30 });
    const current = await ctx.db.one<{ role: string }>('SELECT role FROM staff_members WHERE user_id = $1', [u.id]);
    if (role === OVERSEER) {
      if (current?.role === OVERSEER) return fail(409, 'already', '@' + u.handle + ' is already an Overseer');
      const a = await approvals.ask(ctx.db, me, { kind: 'overseer_add', key: 'overseer:' + u.id, title: `Make @${u.handle} an Overseer`, payload: { user_id: u.id } });
      return json({ approval: a }, 202);
    }
    if (current?.role === OVERSEER) return fail(409, 'is_overseer', 'Removing an Overseer needs a second Overseer: use Remove');
    const n = days(b.days);
    const eh = typeof b.email === 'string' && b.email.trim() ? emailHash(ctx.config, emailOf(b.email)) : undefined;
    const g = await grantRole(ctx.db, { handle: u.handle, role, days: n, by: me.id, emailHash: eh, keepOverseers: true });
    await logStaff(ctx.db, me, 'role', current ? `changed the role from ${current.role} to ${role} for ${n} days` : `gave the ${role} role for ${n} days`, u);
    return json({ ends_at: g.ends_at }, 201);
  });

  r.post('/staff/members/:handle/renew', async (ctx) => {
    const me = requireStaffScope(ctx, 'staff.manage');
    const u = await userByHandle(ctx.db, ctx.params.handle!);
    const n = days((await ctx.json<{ days?: unknown }>()).days);
    const g = await renewRole(ctx.db, { handle: u.handle, days: n });
    await logStaff(ctx.db, me, 'role', `renewed the role for ${n} days`, u);
    return json({ ends_at: g.ends_at });
  });

  // Take a role away. Removing an Overseer needs a second Overseer.
  r.delete('/staff/members/:handle', async (ctx) => {
    const me = requireStaffScope(ctx, 'staff.manage');
    const u = await userByHandle(ctx.db, ctx.params.handle!);
    const current = await ctx.db.one<{ role: string }>('SELECT role FROM staff_members WHERE user_id = $1', [u.id]);
    if (!current) return fail(404, 'not_found', 'That person holds no staff role');
    if (current.role === OVERSEER) {
      const others = await approvals.overseerCount(ctx.db, { except: u.id });
      if (others < 1) return fail(409, 'last_overseer', 'Community must keep at least one Overseer who can act');
      // The person it is about can't decide it, so someone besides the asker and them must be able to.
      if (u.id !== me.id && others < 2) return fail(409, 'no_second', 'Nobody else can approve this. With two Overseers, removing one is done with npm run staff on the server.');
      const a = await approvals.ask(ctx.db, me, { kind: 'overseer_remove', key: 'overseer:' + u.id, title: `Remove @${u.handle} as an Overseer`, payload: { user_id: u.id } });
      return json({ approval: a }, 202);
    }
    const gone = await revokeRole(ctx.db, u.handle, { keepOverseers: true }); // made an Overseer since we looked: still two people
    await logStaff(ctx.db, me, 'role', `took away the ${gone.role} role`, u);
    return noContent();
  });

  // Invite someone by email straight into a role (never Overseer: that needs two people, after they join).
  r.post('/staff/invites', async (ctx) => {
    const me = requireStaffScope(ctx, 'staff.manage');
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const email = emailOf(b.email);
    const role = str(b.role, 'role', { min: 3, max: 30 });
    if (role === OVERSEER) return fail(400, 'invalid', 'role: invite them with another role; making an Overseer needs a second Overseer after they join');
    if (!(await ctx.db.one('SELECT 1 FROM staff_roles WHERE name = $1', [role]))) return fail(400, 'invalid', `role: no role named ${role}`);
    const n = days(b.days);
    const { expiresAt, renewed } = await inviteByEmail(ctx.db, ctx.config, { email, createdBy: me.id, note: str(b.note, 'note', { max: 80, optional: true }), days: INVITE_DAYS, role: 'staff', staffRole: role, staffDays: n });
    await logStaff(ctx.db, me, 'invite', `${renewed ? 'renewed an invite for' : 'invited'} ${masked(email)} as ${role} for ${n} days`);
    return json({ sent: true, expires_at: expiresAt, expires_in_days: INVITE_DAYS }, 201);
  });

  r.delete('/staff/invites/:id', async (ctx) => {
    const me = requireStaffScope(ctx, 'staff.manage');
    if (!/^[0-9a-f]{64}$/.test(ctx.params.id!)) return fail(404, 'not_found', 'No such invite');
    const gone = await ctx.db.one<{ role: string }>(
      `DELETE FROM invites WHERE encode(sha256(code_hash), 'hex') = $1 AND role = 'staff' AND used_at IS NULL RETURNING coalesce(staff_role, $2) AS role`, [ctx.params.id, OVERSEER]);
    if (!gone) return fail(404, 'not_found', 'No such invite');
    await logStaff(ctx.db, me, 'invite', `cancelled a staff invite (${gone.role})`);
    return noContent();
  });

  // A member invite (scope invites.send), as on the public site before 0.10.0.
  r.post('/staff/member-invites', async (ctx) => {
    const me = requireStaffScope(ctx, 'invites.send');
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const email = emailOf(b.email);
    const { expiresAt, renewed } = await inviteByEmail(ctx.db, ctx.config, { email, createdBy: me.id, note: str(b.note, 'note', { max: 80, optional: true }), days: INVITE_DAYS });
    await logStaff(ctx.db, me, 'invite', `${renewed ? 'renewed a member invite for' : 'sent a member invite to'} ${masked(email)}`);
    return json({ sent: true, expires_at: expiresAt, expires_in_days: INVITE_DAYS }, 201);
  });

  /* ---------- Roles & scopes ---------- */
  r.get('/staff/roles', async (ctx) => {
    requireStaffScope(ctx, 'roles.manage');
    const rows = await ctx.db.query<{ name: string; scopes: string[]; holders: number; invites: number }>(
      `SELECT r.name, r.scopes,
         (SELECT count(*)::int FROM staff_members sm WHERE sm.role = r.name AND (sm.ends_at IS NULL OR sm.ends_at > now())) AS holders,
         (SELECT count(*)::int FROM invites i WHERE i.staff_role = r.name AND i.used_at IS NULL AND i.expires_at > now()) AS invites
       FROM staff_roles r ORDER BY r.name = $1 DESC, r.name`, [OVERSEER]);
    return json({
      roles: rows.map((r) => ({ name: r.name, scopes: scopesOf(r.name, r.scopes), holders: r.holders, invites: r.invites, locked: r.name === OVERSEER })),
      groups: SCOPE_GROUPS.map(([g, list]) => ({ group: g, scopes: list.map(([id, label, what, risk]) => ({ id, label, what, risk })) })),
      overseer_only: OVERSEER_SCOPES, as_of: now(),
    });
  });

  const scopeList = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length > 50) return fail(400, 'invalid', 'scopes: a list of scopes');
    const bad = v.filter((s) => !isRoleScope(s));
    if (bad.length) return fail(400, 'invalid', `scopes: not a scope a role can have: ${bad.map(String).join(', ').slice(0, 120)}`);
    return [...new Set(v as string[])];
  };

  r.post('/staff/roles', async (ctx) => {
    const me = requireStaffScope(ctx, 'roles.manage');
    const b = await ctx.json<Record<string, unknown>>();
    const name = str(b.name, 'name', { min: 3, max: 30 }).trim();
    if (!ROLE_NAME.test(name)) return fail(400, 'invalid', 'name: 3-30 letters and spaces, starting with a capital');
    if (name === OVERSEER || (await ctx.db.one('SELECT 1 FROM staff_roles WHERE lower(name) = lower($1)', [name]))) return fail(409, 'exists', 'A role with that name exists');
    const scopes = scopeList(b.scopes);
    await ctx.db.query('INSERT INTO staff_roles (name, scopes) VALUES ($1, $2)', [name, scopes]);
    await logStaff(ctx.db, me, 'role', `made the role ${name} (${scopes.length ? scopes.join(', ') : 'no scopes'})`);
    return json({ name, scopes }, 201);
  });

  r.put('/staff/roles/:name', async (ctx) => {
    const me = requireStaffScope(ctx, 'roles.manage');
    const name = ctx.params.name!;
    if (name === OVERSEER) return fail(403, 'locked', 'The Overseer role has every scope and cannot be edited');
    const old = await ctx.db.one<{ scopes: string[] }>('SELECT scopes FROM staff_roles WHERE name = $1', [name]);
    if (!old) return fail(404, 'not_found', 'No such role');
    const scopes = scopeList((await ctx.json<Record<string, unknown>>()).scopes);
    await ctx.db.query('UPDATE staff_roles SET scopes = $2 WHERE name = $1', [name, scopes]);
    const added = scopes.filter((s) => !old.scopes.includes(s)), removed = old.scopes.filter((s) => !scopes.includes(s));
    await logStaff(ctx.db, me, 'role', `changed the role ${name}: ${[added.length && '+' + added.join(' +'), removed.length && '-' + removed.join(' -')].filter(Boolean).join(' ') || 'no change'}`, null, { added, removed });
    return json({ name, scopes });
  });

  r.delete('/staff/roles/:name', async (ctx) => {
    const me = requireStaffScope(ctx, 'roles.manage');
    const name = ctx.params.name!;
    if (name === OVERSEER) return fail(403, 'locked', 'The Overseer role cannot be deleted');
    if (await ctx.db.one('SELECT 1 FROM staff_members WHERE role = $1', [name])) return fail(409, 'held', 'Someone holds this role. Change their role first.');
    if (await ctx.db.one('SELECT 1 FROM invites WHERE staff_role = $1 AND used_at IS NULL', [name])) return fail(409, 'held', 'An invite gives this role. Cancel it first.');
    await ctx.db.query('DELETE FROM invites WHERE staff_role = $1', [name]); // used or expired invites only
    if (!(await ctx.db.one('DELETE FROM staff_roles WHERE name = $1 RETURNING 1', [name]))) return fail(404, 'not_found', 'No such role');
    await logStaff(ctx.db, me, 'role', `deleted the role ${name}`);
    return noContent();
  });

  /* ---------- Platform and feature switches ---------- */
  r.get('/staff/switches', async (ctx) => {
    requireAnyScope(ctx, ['switches.platform', 'switches.staging']);
    const waiting = await ctx.db.query<{ key: string }>(`SELECT key FROM staff_approvals WHERE status = 'waiting' AND (kind = 'switch' OR kind = 'feature') AND expires_at > now()`);
    return json({
      switches: (await readSwitches(ctx.db)).map((s) => ({ ...s, two_person: TWO_PERSON.has(s.key) })),
      invite_only: { is_on: true, locked: true, note: 'Joining is by invite until the privacy review (decision 0006). Open joining is not built yet.' },
      features: await ctx.db.query(`SELECT f.id, f.name, f.staging, f.production, f.created_at, u.handle AS created_by FROM feature_switches f LEFT JOIN users u ON u.id = f.created_by ORDER BY f.id`),
      waiting: waiting.map((w) => w.key), stage: ctx.config.stage, as_of: now(),
    });
  });

  r.post('/staff/switches/:key', async (ctx) => {
    const me = requireStaffScope(ctx, 'switches.platform');
    const key = ctx.params.key as SwitchKey;
    if (!SWITCH_KEYS.includes(key)) return fail(404, 'not_found', 'No such switch');
    const b = await ctx.json<{ on?: unknown; note?: unknown }>();
    if (typeof b.on !== 'boolean') return fail(400, 'invalid', 'on: true or false');
    const note = str(b.note, 'note', { min: 3, max: 200 });
    if (TWO_PERSON.has(key)) {
      const a = await approvals.ask(ctx.db, me, { kind: 'switch', key: 'switch:' + key, title: `Switch ${b.on ? 'on' : 'off'} "${key}"`, payload: { key, on: b.on, note } });
      return json({ approval: a }, 202);
    }
    await setSwitch(ctx.db, key, b.on, me.id, note);
    await logStaff(ctx.db, me, 'switch', `switched ${b.on ? 'on' : 'off'} "${key}": ${note}`);
    return noContent();
  });

  r.post('/staff/features', async (ctx) => {
    const me = requireStaffScope(ctx, 'switches.staging');
    const b = await ctx.json<Record<string, unknown>>();
    const id = str(b.id, 'id', { min: 2, max: 41, pattern: /^[a-z][a-z0-9_.]{1,40}$/ });
    const name = str(b.name, 'name', { min: 3, max: 60 });
    if (await ctx.db.one('SELECT 1 FROM feature_switches WHERE id = $1', [id])) return fail(409, 'exists', 'A feature switch with that id exists');
    await ctx.db.query('INSERT INTO feature_switches (id, name, created_by) VALUES ($1, $2, $3)', [id, name, me.id]);
    await logStaff(ctx.db, me, 'switch', `added the feature switch "${id}"`);
    return json({ id, name, staging: false, production: false }, 201);
  });

  r.post('/staff/features/:id/staging', async (ctx) => {
    const me = requireStaffScope(ctx, 'switches.staging');
    const b = await ctx.json<{ on?: unknown }>();
    if (typeof b.on !== 'boolean') return fail(400, 'invalid', 'on: true or false');
    if (!(await ctx.db.one('UPDATE feature_switches SET staging = $2 WHERE id = $1 RETURNING 1', [ctx.params.id, b.on]))) return fail(404, 'not_found', 'No such feature switch');
    await logStaff(ctx.db, me, 'switch', `switched ${b.on ? 'on' : 'off'} "${ctx.params.id}" in staging`);
    return noContent();
  });

  r.post('/staff/features/:id/production', async (ctx) => {
    const me = requireStaffScope(ctx, 'switches.platform');
    const b = await ctx.json<{ on?: unknown }>();
    if (typeof b.on !== 'boolean') return fail(400, 'invalid', 'on: true or false');
    const f = await ctx.db.one<{ name: string; staging: boolean; production: boolean }>('SELECT name, staging, production FROM feature_switches WHERE id = $1', [ctx.params.id]);
    if (!f) return fail(404, 'not_found', 'No such feature switch');
    if (f.production === b.on) return fail(409, 'already', `It is already ${b.on ? 'on' : 'off'} in production`);
    if (b.on && !f.staging) return fail(409, 'staging_first', 'Switch it on in staging first');
    // Switching off in production is the safe direction: one Overseer can do it at once.
    if (!b.on) {
      await ctx.db.query('UPDATE feature_switches SET production = false WHERE id = $1', [ctx.params.id]);
      await logStaff(ctx.db, me, 'switch', `switched off "${ctx.params.id}" in production`);
      return noContent();
    }
    const a = await approvals.ask(ctx.db, me, { kind: 'feature', key: 'feature:' + ctx.params.id, title: `Switch on "${f.name}" in production`, payload: { id: ctx.params.id, on: true } });
    return json({ approval: a }, 202);
  });

  r.delete('/staff/features/:id', async (ctx) => {
    const me = requireStaffScope(ctx, 'switches.staging');
    const f = await ctx.db.one<{ production: boolean }>('SELECT production FROM feature_switches WHERE id = $1', [ctx.params.id]);
    if (!f) return fail(404, 'not_found', 'No such feature switch');
    if (f.production) return fail(409, 'in_production', 'Switch it off in production first');
    await ctx.db.query('DELETE FROM feature_switches WHERE id = $1', [ctx.params.id]);
    await logStaff(ctx.db, me, 'switch', `removed the feature switch "${ctx.params.id}"`);
    return noContent();
  });

  /* ---------- Vault requests ---------- */
  r.get('/staff/vault', (ctx) => {
    requireStaffScope(ctx, 'vault.request');
    return json({ requests: [], built: false, as_of: now(),
      note: 'The sealed vault is not built yet, so there is nothing to open. When it is, a request needs a court order and a second Overseer, the record shows for 30 minutes, and the person is told (decision 0001).' });
  });

  /* ---------- Audit log: CSV ---------- */
  r.get('/staff/audit.csv', async (ctx) => {
    const me = requireStaffScope(ctx, 'audit.read');
    const kind = ctx.query.get('kind');
    const entries = await readLog(ctx.db, { who: ctx.query.get('who'), kind: kind || null, q: (ctx.query.get('q') || '').slice(0, 80), limit: 5000 });
    // Cells that start like a formula are prefixed, so a spreadsheet never runs them.
    const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const csv = ['at,who,kind,text,subject', ...entries.map((e) => [e.at, e.who, e.kind, e.text, e.subject].map(cell).join(','))].join('\r\n') + '\r\n';
    await logStaff(ctx.db, me, 'audit', `exported ${entries.length} audit entries as CSV`);
    return { status: 200, body: Buffer.from(csv, 'utf8'), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="staff-audit-${now().slice(0, 10)}.csv"` } };
  });

  /* ---------- Admin: reports and appeals (the public handlers, as staff) ---------- */
  alias(r, pub, 'GET', '/staff/reports', '/mod/reports', 'reports.review');
  alias(r, pub, 'POST', '/staff/reports/:id/decide', '/mod/reports/:id/decide', 'reports.review', async (ctx, me, b) => {
    await logStaff(ctx.db, me, 'report', `decided a report: ${String(b.action)}${b.note ? ` (${String(b.note).slice(0, 120)})` : ''}`, null, { report: ctx.params.id });
  });
  alias(r, pub, 'DELETE', '/staff/posts/:id', '/posts/:id', 'reports.review', async (ctx, me) => {
    await logStaff(ctx.db, me, 'report', 'deleted a post', null, { post: ctx.params.id });
  });
  const appeals = new Router();
  registerAppeals(appeals);
  alias(r, appeals, 'GET', '/staff/appeals', '/mod/appeals', 'reports.review');
  alias(r, appeals, 'POST', '/staff/appeals/:id/decide', '/mod/appeals/:id/decide', 'reports.review', async (ctx, me, b) => {
    await logStaff(ctx.db, me, 'appeal', `decided an appeal: ${String(b.decision)}`, null, { action: ctx.params.id });
  });

  /* ---------- Admin: people ---------- */
  r.get('/staff/people', async (ctx) => {
    const me = requireStaffScope(ctx, 'people.lookup');
    const q = (ctx.query.get('q') || '').trim().replace(/^@/, '').toLowerCase().slice(0, 30);
    if (q.length < 2) return json({ people: [], as_of: now() });
    await liftSuspensions(ctx.db);
    const like = q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const people = await ctx.db.query(
      `SELECT u.handle, u.first_name, u.status FROM users u WHERE u.status <> 'deleted' AND (u.handle LIKE $1 ESCAPE '\\' OR u.handle_key = $3)
       ORDER BY u.handle = $2 DESC, u.handle LIMIT 10`, [like, q, handleKey(q)]);
    await logStaff(ctx.db, me, 'account', `searched people for "${q}"`);
    return json({ people, as_of: now() });
  });

  r.get('/staff/people/:handle', async (ctx) => {
    const me = requireStaffScope(ctx, 'people.lookup');
    await liftSuspensions(ctx.db);
    const u = await userByHandle(ctx.db, ctx.params.handle!);
    const p = await ctx.db.one<Record<string, unknown>>(
      `SELECT ${PERSON_COLS}, u.status, u.suspended_until, u.created_at, sm.role AS staff_role,
         (SELECT count(*)::int FROM mod_actions a WHERE a.subject_id = u.id) AS actions,
         (SELECT count(*)::int FROM posts p WHERE p.author_id = u.id AND p.deleted_at IS NULL) AS posts
       FROM users u LEFT JOIN staff_members sm ON sm.user_id = u.id AND (sm.ends_at IS NULL OR sm.ends_at > now()) WHERE u.id = $1`, [u.id]);
    const history = await ctx.db.query(
      `SELECT a.action, a.target_kind, a.reason, a.created_at, a.appealed_at, a.appeal_decision FROM mod_actions a WHERE a.subject_id = $1 ORDER BY a.created_at DESC LIMIT 20`, [u.id]);
    await logStaff(ctx.db, me, 'account', 'looked at the account', u);
    return json({ person: p, history, as_of: now() });
  });

  r.post('/staff/people/:handle/suspend', async (ctx) => {
    const me = requireStaffScope(ctx, 'accounts.suspend');
    limit(limits.write, me.id);
    const u = await userByHandle(ctx.db, ctx.params.handle!);
    if (u.id === me.id) return fail(403, 'own_account', 'You cannot suspend yourself');
    if (await ctx.db.one(`SELECT 1 FROM staff_members WHERE user_id = $1 AND role = $2`, [u.id, OVERSEER])) return fail(403, 'overseer', 'An Overseer is removed with two people, not suspended');
    const b = await ctx.json<Record<string, unknown>>();
    const n = Number(b.days ?? 7);
    if (!Number.isInteger(n) || n < 1 || n > 7) return fail(400, 'invalid', 'days: 1 to 7');
    const reason = str(b.reason, 'reason', { min: 3, max: 500 });
    if (u.status !== 'active') return fail(409, 'not_active', 'That account is already suspended');
    await ctx.db.tx(async (t) => {
      await t.query(`UPDATE users SET status = 'suspended', suspended_until = now() + make_interval(days => $2) WHERE id = $1`, [u.id, n]);
      await t.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
      const a = await t.one<{ id: string }>(`INSERT INTO mod_actions (actor_id, subject_id, action, target_kind, target_id, reason) VALUES ($1, $2, 'suspend', 'user', $2, $3) RETURNING id`, [me.id, u.id, reason]);
      await t.query(`INSERT INTO notifications (user_id, kind, ref_kind, ref_id) VALUES ($1, 'mod_action', 'mod_action', $2)`, [u.id, a!.id]);
      await logStaff(t, me, 'account', `suspended the account for ${n} days: ${reason}`, u);
    });
    return noContent();
  });

  r.post('/staff/people/:handle/unsuspend', async (ctx) => {
    const me = requireStaffScope(ctx, 'accounts.suspend');
    const u = await userByHandle(ctx.db, ctx.params.handle!);
    const reason = str((await ctx.json<Record<string, unknown>>()).reason, 'reason', { min: 3, max: 500 });
    if (u.status !== 'suspended') return fail(409, 'not_suspended', 'That account is not suspended');
    await ctx.db.tx(async (t) => {
      await t.query(`UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1`, [u.id]);
      const a = await t.one<{ id: string }>(`INSERT INTO mod_actions (actor_id, subject_id, action, target_kind, target_id, reason) VALUES ($1, $2, 'restore', 'user', $2, $3) RETURNING id`, [me.id, u.id, reason]);
      await t.query(`INSERT INTO notifications (user_id, kind, ref_kind, ref_id) VALUES ($1, 'mod_action', 'mod_action', $2)`, [u.id, a!.id]);
      await logStaff(t, me, 'account', `lifted the suspension: ${reason}`, u);
    });
    return noContent();
  });

  /* ---------- Admin: health ---------- */
  r.get('/staff/health', async (ctx) => {
    requireStaffScope(ctx, 'ops.health');
    const t0 = performance.now();
    await ctx.db.query('SELECT 1');
    const dbMs = Math.round((performance.now() - t0) * 10) / 10;
    const mig = await ctx.db.one<{ n: number; last: string; at: string }>(`SELECT count(*)::int AS n, max(name) AS last, max(applied_at) AS at FROM schema_migrations`);
    return json({ version: VERSION, node: process.version, started_at: STARTED, uptime_s: Math.round(process.uptime()), stage: ctx.config.stage,
      db: { ok: true, ms: dbMs }, migrations: mig, as_of: now() });
  });
}
