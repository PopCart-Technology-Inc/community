// Spaces and messages (decision 0003): Spaces with roles, channels and public rules; direct messages
// with Requests for strangers. Decision 0001, point 4: private means end-to-end encrypted, so the
// server refuses plaintext for DMs and private Spaces and only checks the sealed envelope's shape and
// size (docs/e2e.md). Non-members get 404 for a private Space, never 403, so its existence does not leak.
import type { Db } from '../../db/index.ts';
import { fail, isUuid, json, noContent, type Ctx, type Router } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { requireUser } from '../../http/session.ts';
import { PERSON_COLS, bad, oneOf, page, resolveArea, str } from '../shared.ts';

type Role = 'owner' | 'moderator' | 'member';
const RANK: Record<Role, number> = { owner: 3, moderator: 2, member: 1 };
const ROLES = ['owner', 'moderator', 'member'] as const;
const KINDS = ['barangay', 'trade', 'crew'] as const;
const VISIBILITIES = ['public', 'private'] as const;
const SLUG = /^[a-z0-9-]{3,40}$/;
const CHANNEL = /^[a-z0-9-]{2,30}$/;
const MAX_CHANNELS = 50;
/** A stranger may send this many messages before the other person accepts the request. */
const REQUEST_MESSAGES = 3;

/** Envelope limits (docs/e2e.md). */
export const SEAL = { ivBytes: 12, ctMin: 17, ctMax: 8192, keyMax: 512, keysMax: 1000 } as const;

const asOf = () => new Date().toISOString();

/** A person (PERSON_COLS) as a JSON object, for the user id in `col`. */
const personOf = (col: string, extra = '') =>
  `(SELECT row_to_json(p) FROM (SELECT ${PERSON_COLS}${extra} FROM users u WHERE u.id = ${col}) p)`;

/** The person's public ECDH key (JWK) rides along wherever a browser must derive keys: DM partners,
 *  message authors and member lists (docs/e2e.md). It is public by design; the private key never leaves the browser. */
const WITH_KEY = ', u.dm_public_key';

const SPACE_COLS =`s.id, s.slug, s.name, s.kind, s.visibility, s.about, s.rules, s.cover_media_id, s.created_at,
  CASE WHEN a.code IS NULL THEN NULL ELSE json_build_object('code', a.code, 'name', a.name) END AS area,
  (SELECT count(*)::int FROM space_members sm WHERE sm.space_id = s.id) AS members`;

interface Space {
  id: string; slug: string; name: string; kind: string; visibility: 'public' | 'private'; about: string; rules: string;
  cover_media_id: string | null; created_at: string; area: { code: string; name: string } | null; members: number;
}

const notFound = (): never => fail(404, 'not_found', 'No such Space');

/** The Space and the viewer's role. A private Space is invisible (404) to anyone who is not a member. */
async function loadSpace(ctx: Ctx, slug: string | undefined): Promise<{ space: Space; role: Role | null }> {
  if (!slug || !SLUG.test(slug)) return notFound();
  const space = await ctx.db.one<Space>(`SELECT ${SPACE_COLS} FROM spaces s LEFT JOIN areas a ON a.code = s.area_code WHERE s.slug = $1`, [slug]);
  if (!space) return notFound();
  const role = ctx.user ? await roleIn(ctx.db, space.id, ctx.user.id) : null;
  if (space.visibility === 'private' && !role) return notFound();
  return { space, role };
}

async function roleIn(db: Db, spaceId: string, userId: string): Promise<Role | null> {
  return (await db.one<{ role: Role }>('SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, userId]))?.role ?? null;
}

function needRank(role: Role | null, min: Role): void {
  if (!role || RANK[role] < RANK[min]) fail(403, 'not_allowed', min === 'owner' ? 'Only an owner can do that' : 'Only owners and moderators can do that');
}

async function ownerCount(db: Db, spaceId: string): Promise<number> {
  return (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM space_members WHERE space_id = $1 AND role = 'owner'`, [spaceId]))?.n ?? 0;
}

/** The channel, its Space and the viewer's role. Private and not a member: 404. */
async function loadChannel(ctx: Ctx): Promise<{ channel: { id: string; space_id: string; name: string }; visibility: 'public' | 'private'; role: Role | null }> {
  const id = ctx.params.id;
  if (!isUuid(id)) return fail(404, 'not_found', 'No such channel');
  const c = await ctx.db.one<{ id: string; space_id: string; name: string; visibility: 'public' | 'private' }>(
    'SELECT c.id, c.space_id, c.name, s.visibility FROM channels c JOIN spaces s ON s.id = c.space_id WHERE c.id = $1', [id]);
  if (!c) return fail(404, 'not_found', 'No such channel');
  const role = ctx.user ? await roleIn(ctx.db, c.space_id, ctx.user.id) : null;
  if (c.visibility === 'private' && !role) return fail(404, 'not_found', 'No such channel');
  return { channel: { id: c.id, space_id: c.space_id, name: c.name }, visibility: c.visibility, role };
}

// ---- Sealed envelopes (docs/e2e.md) ----

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function b64Bytes(v: unknown, field: string): number {
  if (typeof v !== 'string' || !B64.test(v)) return bad(field, 'must be standard base64');
  return Buffer.byteLength(v, 'base64');
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Sealed { v: 1; iv: string; ct: string; keys?: Record<string, string> }

/**
 * Check an encrypted envelope strictly. DM: `{ v: 1, iv, ct }`. Private Space (`members` given):
 * `{ v: 1, iv, ct, keys }` where every key id is a current member and the sender's own id is present.
 */
export function checkSealed(v: unknown, opts: { sender: string; members?: Set<string> }): Sealed {
  if (!isPlainObject(v)) return bad('sealed', 'must be an encrypted envelope object');
  const allowed = opts.members ? ['v', 'iv', 'ct', 'keys'] : ['v', 'iv', 'ct'];
  for (const k of Object.keys(v)) if (!allowed.includes(k)) bad('sealed', `has an unexpected field (allowed: ${allowed.join(', ')})`);
  if (v.v !== 1) bad('sealed.v', 'must be 1');
  if (b64Bytes(v.iv, 'sealed.iv') !== SEAL.ivBytes) bad('sealed.iv', `must be ${SEAL.ivBytes} bytes`);
  const ct = b64Bytes(v.ct, 'sealed.ct');
  if (ct < SEAL.ctMin || ct > SEAL.ctMax) bad('sealed.ct', `must be ${SEAL.ctMin} to ${SEAL.ctMax} bytes`);
  const out: Sealed = { v: 1, iv: v.iv as string, ct: v.ct as string };
  if (opts.members) {
    if (!isPlainObject(v.keys)) return bad('sealed.keys', 'must map member ids to wrapped keys');
    const ids = Object.keys(v.keys);
    if (ids.length < 1 || ids.length > SEAL.keysMax) bad('sealed.keys', `must have 1 to ${SEAL.keysMax} entries`);
    const keys: Record<string, string> = {};
    for (const id of ids) {
      if (!isUuid(id) || !opts.members.has(id)) bad('sealed.keys', 'every key must be for a current member of this Space');
      const n = b64Bytes(v.keys[id], 'sealed.keys');
      if (n < 1 || n > SEAL.keyMax) bad('sealed.keys', `each wrapped key must be 1 to ${SEAL.keyMax} bytes`);
      keys[id] = v.keys[id] as string;
    }
    if (!Object.hasOwn(keys, opts.sender)) bad('sealed.keys', 'must include a key for yourself');
    out.keys = keys;
  }
  return out;
}

/** What one viewer sees of a private-Space envelope: only their own wrapped key. */
function sealedFor(s: Sealed | null, viewer: string): Sealed | null {
  if (!s) return null;
  if (!s.keys) return s;
  const mine = s.keys[viewer];
  return { v: s.v, iv: s.iv, ct: s.ct, keys: mine ? { [viewer]: mine } : {} };
}

/** Plaintext is refused where messages must be sealed: any field besides `sealed` is a refusal. */
function refusePlaintext(b: Record<string, unknown>, where: string): void {
  const extra = Object.keys(b).filter((k) => k !== 'sealed');
  if (extra.length || b.sealed === undefined) {
    fail(400, 'sealed_only', `${where} are end-to-end encrypted: send only { sealed } (see docs/e2e.md). Plaintext is never accepted.`);
  }
}

// ---- Conversations ----

const otherOf = (me: string) => `CASE WHEN c.user_a = ${me} THEN c.user_b ELSE c.user_a END`;
const myReadOf = (me: string) => `CASE WHEN c.user_a = ${me} THEN c.a_read_at ELSE c.b_read_at END`;

/** Conversations of the person in $1, with the other person (and their DM public key) and unread count. */
const CONV_SELECT = `SELECT c.id, c.accepted, c.created_at, (c.started_by IS NOT DISTINCT FROM $1::uuid) AS started_by_me,
    ${personOf(otherOf('$1::uuid'), WITH_KEY)} AS other,
    coalesce((SELECT max(d.created_at) FROM dm_messages d WHERE d.conversation_id = c.id), c.created_at) AS last_at,
    (SELECT count(*)::int FROM dm_messages d WHERE d.conversation_id = c.id AND d.sender_id <> $1::uuid
       AND d.created_at > ${myReadOf('$1::uuid')}) AS unread
  FROM conversations c
  WHERE (c.user_a = $1::uuid OR c.user_b = $1::uuid)
    AND EXISTS (SELECT 1 FROM users o WHERE o.id = ${otherOf('$1::uuid')} AND o.status <> 'deleted')`;

interface ConvRow { id: string; accepted: boolean; started_by: string | null; user_a: string; user_b: string }

async function loadConversation(ctx: Ctx, meId: string): Promise<ConvRow> {
  const id = ctx.params.id;
  if (!isUuid(id)) return fail(404, 'not_found', 'No such conversation');
  const c = await ctx.db.one<ConvRow>(
    'SELECT id, accepted, started_by, user_a, user_b FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2)', [id, meId]);
  if (!c) return fail(404, 'not_found', 'No such conversation');
  return c;
}

const conversationView = (db: Db, id: string, meId: string) => db.one(`${CONV_SELECT} AND c.id = $2`, [meId, id]);

const markConversationRead = (db: Db, id: string, meId: string) => db.query(
  `UPDATE conversations SET a_read_at = CASE WHEN user_a = $2 THEN now() ELSE a_read_at END,
     b_read_at = CASE WHEN user_b = $2 THEN now() ELSE b_read_at END WHERE id = $1`, [id, meId]);

export function register(r: Router): void {
  // ---- Spaces ----

  r.get('/spaces', async (ctx) => {
    const mine = ctx.query.get('mine') === '1';
    const me = mine ? requireUser(ctx) : ctx.user;
    const { limit: n, before } = page(ctx.query);
    const params: unknown[] = [me?.id ?? null];
    const where: string[] = [`(s.visibility = 'public' OR m.user_id IS NOT NULL)`];
    if (mine) where.push('m.user_id IS NOT NULL');
    const near = ctx.query.get('near');
    if (near) {
      const area = await resolveArea(ctx.db, str(near, 'near', { max: 40 }));
      if (area.area_code !== 'WORLD') {
        params.push(area.area_code);
        const p = `$${params.length}`;
        where.push(`(a.code = ${p} OR a.city_code = ${p} OR a.region_code = ${p} OR a.country_code = ${p})`);
      }
    }
    const q = ctx.query.get('q');
    if (q) {
      params.push('%' + str(q, 'q', { max: 60 }).replace(/[\\%_]/g, '\\$&') + '%');
      where.push(`(s.name ILIKE $${params.length} OR s.slug ILIKE $${params.length})`);
    }
    const sortAt = mine ? 'coalesce(lm.created_at, m.joined_at)' : 's.created_at';
    if (before) { params.push(before); where.push(`${sortAt} < $${params.length}::timestamptz`); }
    params.push(n);
    const rows = await ctx.db.query<Record<string, unknown> & { last_message: Record<string, unknown> | null }>(
      `SELECT ${SPACE_COLS}, m.role,
         CASE WHEN m.user_id IS NULL THEN NULL ELSE
           (SELECT count(*)::int FROM messages msg JOIN channels ch ON ch.id = msg.channel_id
            WHERE ch.space_id = s.id AND msg.created_at > m.last_read_at AND msg.author_id <> m.user_id AND msg.deleted_at IS NULL) END AS unread,
         CASE WHEN lm.id IS NULL THEN NULL ELSE json_build_object('id', lm.id, 'channel_id', lm.channel_id, 'author', lm.author,
           'body', lm.body, 'sealed', lm.sealed, 'created_at', lm.created_at) END AS last_message
       FROM spaces s
       LEFT JOIN areas a ON a.code = s.area_code
       LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = $1::uuid
       LEFT JOIN LATERAL (
         SELECT msg.id, msg.channel_id, msg.body, msg.sealed, msg.created_at, ${personOf('msg.author_id', WITH_KEY)} AS author
         FROM messages msg JOIN channels ch ON ch.id = msg.channel_id
         WHERE m.user_id IS NOT NULL AND ch.space_id = s.id AND msg.deleted_at IS NULL
         ORDER BY msg.created_at DESC LIMIT 1) lm ON true
       WHERE ${where.join(' AND ')}
       ORDER BY ${sortAt} DESC LIMIT $${params.length}`, params);
    for (const row of rows) {
      if (row.last_message && me) row.last_message.sealed = sealedFor(row.last_message.sealed as Sealed | null, me.id);
    }
    return json({ spaces: rows, as_of: asOf() });
  });

  r.post('/spaces', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json();
    const name = str(b.name, 'name', { min: 3, max: 60 });
    const slug = str(b.slug, 'slug', { min: 3, max: 40, pattern: SLUG });
    const kind = oneOf(b.kind, 'kind', KINDS);
    const visibility = oneOf(b.visibility, 'visibility', VISIBILITIES, 'public');
    const area = await resolveArea(ctx.db, str(b.area_code, 'area_code', { max: 40, optional: true }) || null);
    const about = str(b.about, 'about', { max: 500, optional: true });
    const rules = str(b.rules, 'rules', { max: 2000, optional: true });
    const id = await ctx.db.tx(async (t) => {
      const s = await t.one<{ id: string }>(
        `INSERT INTO spaces (slug, name, kind, visibility, area_code, about, rules, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [slug, name, kind, visibility, area.area_code, about, rules, me.id]);
      if (!s) return null;
      await t.query(`INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')`, [s.id, me.id]);
      await t.query(`INSERT INTO channels (space_id, name, position) VALUES ($1, 'chat', 0)`, [s.id]);
      return s.id;
    });
    if (!id) return fail(409, 'slug_taken', 'That Space address is taken');
    const space = await ctx.db.one(`SELECT ${SPACE_COLS} FROM spaces s LEFT JOIN areas a ON a.code = s.area_code WHERE s.id = $1`, [id]);
    return json({ space }, 201);
  });

  r.get('/spaces/:slug', async (ctx) => {
    const { space, role } = await loadSpace(ctx, ctx.params.slug);
    const channels = await ctx.db.query(
      `SELECT c.id, c.name, c.position,
         CASE WHEN m.user_id IS NULL THEN NULL ELSE
           (SELECT count(*)::int FROM messages msg WHERE msg.channel_id = c.id AND msg.created_at > m.last_read_at
              AND msg.author_id <> m.user_id AND msg.deleted_at IS NULL) END AS unread
       FROM channels c LEFT JOIN space_members m ON m.space_id = c.space_id AND m.user_id = $2::uuid
       WHERE c.space_id = $1 ORDER BY c.position, c.name`, [space.id, ctx.user?.id ?? null]);
    const faces = await ctx.db.query(
      `SELECT ${PERSON_COLS} FROM space_members m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = $1 AND u.status = 'active' ORDER BY (m.role = 'owner') DESC, m.joined_at DESC LIMIT 6`, [space.id]);
    return json({ space, channels, my_role: role, members_count: space.members, faces, as_of: asOf() });
  });

  r.patch('/spaces/:slug', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const { space, role } = await loadSpace(ctx, ctx.params.slug);
    needRank(role, 'moderator');
    const b = await ctx.json();
    // The address and visibility are fixed: old public messages are plaintext and old private ones are
    // sealed, so switching either way would break what members were promised.
    if (b.slug !== undefined && b.slug !== space.slug) return fail(400, 'fixed', 'A Space address cannot change');
    if (b.visibility !== undefined && b.visibility !== space.visibility) return fail(400, 'fixed', 'A Space cannot switch between public and private');
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) set('name', str(b.name, 'name', { min: 3, max: 60 }));
    if (b.kind !== undefined) set('kind', oneOf(b.kind, 'kind', KINDS));
    if (b.about !== undefined) set('about', str(b.about, 'about', { max: 500, optional: true }));
    if (b.rules !== undefined) set('rules', str(b.rules, 'rules', { max: 2000, optional: true }));
    if (b.area_code !== undefined) set('area_code', (await resolveArea(ctx.db, str(b.area_code, 'area_code', { max: 40, optional: true }) || null)).area_code);
    if (b.cover_media_id !== undefined) {
      if (b.cover_media_id === null) set('cover_media_id', null);
      else {
        if (typeof b.cover_media_id !== 'string' || !isUuid(b.cover_media_id)) return bad('cover_media_id', 'must be an uploaded image id');
        if (!(await ctx.db.one('SELECT 1 FROM media WHERE id = $1 AND owner_id = $2', [b.cover_media_id, me.id]))) return bad('cover_media_id', 'must be an image you uploaded');
        set('cover_media_id', b.cover_media_id);
      }
    }
    if (sets.length) {
      vals.push(space.id);
      await ctx.db.query(`UPDATE spaces SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }
    return json({ space: (await loadSpace(ctx, space.slug)).space });
  });

  // Join (no body) or, as owner/moderator, add someone ({ handle }). A private Space is invite only.
  r.post('/spaces/:slug/members', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const { space, role } = await loadSpace(ctx, ctx.params.slug);
    const b = await ctx.json();
    if (b.handle === undefined || b.handle === me.handle) {
      if (role) return noContent();
      if (space.visibility === 'private') return notFound(); // loadSpace already hides it; kept as a guard
      await ctx.db.query('INSERT INTO space_members (space_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [space.id, me.id]);
      return noContent();
    }
    needRank(role, 'moderator');
    const handle = str(b.handle, 'handle', { max: 30 });
    const t = await ctx.db.one<{ id: string }>(`SELECT id FROM users WHERE handle = $1 AND status = 'active'`, [handle]);
    if (!t) return fail(404, 'not_found', 'No one has that username');
    await ctx.db.query('INSERT INTO space_members (space_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [space.id, t.id]);
    return noContent();
  });

  // Leave (no body) or, as owner/moderator, remove someone of a lower role ({ handle }).
  r.delete('/spaces/:slug/members', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const { space, role } = await loadSpace(ctx, ctx.params.slug);
    const b = await ctx.json();
    if (b.handle === undefined || b.handle === me.handle) {
      if (!role) return noContent();
      if (role === 'owner' && (await ownerCount(ctx.db, space.id)) <= 1) return fail(409, 'last_owner', 'Make someone else an owner before you leave');
      await ctx.db.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [space.id, me.id]);
      return noContent();
    }
    needRank(role, 'moderator');
    const t = await ctx.db.one<{ user_id: string; role: Role }>(
      'SELECT m.user_id, m.role FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = $1 AND u.handle = $2',
      [space.id, str(b.handle, 'handle', { max: 30 })]);
    if (!t) return fail(404, 'not_found', 'That person is not a member');
    if (RANK[t.role] >= RANK[role as Role]) return fail(403, 'not_allowed', 'You can only remove people with a lower role');
    await ctx.db.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [space.id, t.user_id]);
    return noContent();
  });

  r.get('/spaces/:slug/members', async (ctx) => {
    const { space } = await loadSpace(ctx, ctx.params.slug);
    const { limit: n, before } = page(ctx.query);
    const members = await ctx.db.query(
      `SELECT ${personOf('m.user_id', WITH_KEY)} AS person, m.role, m.joined_at FROM space_members m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = $1 AND u.status <> 'deleted' AND ($2::timestamptz IS NULL OR m.joined_at < $2::timestamptz)
       ORDER BY m.joined_at DESC LIMIT $3`, [space.id, before, n]);
    return json({ members, as_of: asOf() });
  });

  r.patch('/spaces/:slug/members/:handle', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const { space, role } = await loadSpace(ctx, ctx.params.slug);
    needRank(role, 'owner');
    const b = await ctx.json();
    const next = oneOf(b.role, 'role', ROLES);
    const t = await ctx.db.one<{ user_id: string; role: Role }>(
      'SELECT m.user_id, m.role FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = $1 AND u.handle = $2',
      [space.id, ctx.params.handle]);
    if (!t) return fail(404, 'not_found', 'That person is not a member');
    if (t.user_id === me.id && next !== 'owner' && (await ownerCount(ctx.db, space.id)) <= 1) {
      return fail(409, 'last_owner', 'Make someone else an owner first');
    }
    await ctx.db.query('UPDATE space_members SET role = $3 WHERE space_id = $1 AND user_id = $2', [space.id, t.user_id, next]);
    return noContent();
  });

  // Mark everything in the Space read for me (unread counts use space_members.last_read_at).
  r.post('/spaces/:slug/read', async (ctx) => {
    const me = requireUser(ctx);
    const { space, role } = await loadSpace(ctx, ctx.params.slug);
    if (!role) return fail(403, 'not_member', 'Join this Space first');
    await ctx.db.query('UPDATE space_members SET last_read_at = now() WHERE space_id = $1 AND user_id = $2', [space.id, me.id]);
    return noContent();
  });

  r.post('/spaces/:slug/channels', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const { space, role } = await loadSpace(ctx, ctx.params.slug);
    needRank(role, 'moderator');
    const b = await ctx.json();
    const name = str(b.name, 'name', { min: 2, max: 30, pattern: CHANNEL });
    const count = await ctx.db.one<{ n: number; top: number }>(
      'SELECT count(*)::int AS n, coalesce(max(position), -1)::int AS top FROM channels WHERE space_id = $1', [space.id]);
    if ((count?.n ?? 0) >= MAX_CHANNELS) return fail(409, 'too_many', `A Space can have at most ${MAX_CHANNELS} channels`);
    const channel = await ctx.db.one(
      `INSERT INTO channels (space_id, name, position) VALUES ($1, $2, $3) ON CONFLICT (space_id, name) DO NOTHING
       RETURNING id, space_id, name, position`, [space.id, name, (count?.top ?? -1) + 1]);
    if (!channel) return fail(409, 'channel_taken', 'This Space already has a channel with that name');
    return json({ channel }, 201);
  });

  r.get('/channels/:id/messages', async (ctx) => {
    const me = requireUser(ctx);
    const { channel } = await loadChannel(ctx);
    const { limit: n, before } = page(ctx.query);
    const rows = await ctx.db.query<{ sealed: Sealed | null }>(
      `SELECT m.id, m.channel_id, ${personOf('m.author_id', WITH_KEY)} AS author, m.body, m.sealed, m.created_at
       FROM messages m WHERE m.channel_id = $1 AND m.deleted_at IS NULL AND ($2::timestamptz IS NULL OR m.created_at < $2::timestamptz)
       ORDER BY m.created_at DESC LIMIT $3`, [channel.id, before, n]);
    for (const row of rows) row.sealed = sealedFor(row.sealed, me.id);
    return json({ messages: rows, as_of: asOf() });
  });

  r.post('/channels/:id/messages', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const { channel, visibility, role } = await loadChannel(ctx);
    if (!role) return fail(403, 'not_member', 'Join this Space to send messages');
    const b = await ctx.json();
    let body: string | null = null;
    let sealed: Sealed | null = null;
    if (visibility === 'public') {
      if (b.sealed !== undefined) return fail(400, 'plaintext_only', 'Messages in a public Space are public: send { body }');
      body = str(b.body, 'body', { min: 1, max: 4000 });
    } else {
      refusePlaintext(b, 'Messages in a private Space');
      const members = new Set((await ctx.db.query<{ user_id: string }>('SELECT user_id FROM space_members WHERE space_id = $1', [channel.space_id])).map((m) => m.user_id));
      sealed = checkSealed(b.sealed, { sender: me.id, members });
    }
    const message = await ctx.db.one<{ sealed: Sealed | null }>(
      `INSERT INTO messages (channel_id, author_id, body, sealed) VALUES ($1, $2, $3, $4)
       RETURNING id, channel_id, ${personOf('author_id', WITH_KEY)} AS author, body, sealed, created_at`,
      [channel.id, me.id, body, sealed ? JSON.stringify(sealed) : null]);
    await ctx.db.query('UPDATE space_members SET last_read_at = now() WHERE space_id = $1 AND user_id = $2', [channel.space_id, me.id]);
    if (message) message.sealed = sealedFor(message.sealed, me.id);
    return json({ message }, 201);
  });

  // Space posts are written by the posts module (POST /posts with space_id); this lists them.
  r.get('/spaces/:slug/posts', async (ctx) => {
    const { space } = await loadSpace(ctx, ctx.params.slug);
    const { limit: n, before } = page(ctx.query);
    const posts = await ctx.db.query(
      `SELECT p.id, ${personOf('p.author_id')} AS author, p.body, p.created_at, p.reply_to, p.space_id, p.media_ids, p.reach,
         CASE WHEN a.code IS NULL THEN NULL ELSE json_build_object('code', a.code, 'name', a.name) END AS place,
         NULL::text AS distance_hint,
         (SELECT count(*)::int FROM salamats sl WHERE sl.post_id = p.id) AS salamats,
         (SELECT count(*)::int FROM posts rp WHERE rp.reply_to = p.id AND rp.deleted_at IS NULL) AS replies,
         EXISTS (SELECT 1 FROM saves sv WHERE sv.post_id = p.id AND sv.user_id = $2::uuid) AS saved,
         EXISTS (SELECT 1 FROM salamats sl WHERE sl.post_id = p.id AND sl.giver_id = $2::uuid) AS salamat_given,
         p.lang
       FROM posts p JOIN users u ON u.id = p.author_id LEFT JOIN areas a ON a.code = p.area_code
       WHERE p.space_id = $1 AND p.reply_to IS NULL AND p.deleted_at IS NULL AND u.status = 'active'
         AND ($3::timestamptz IS NULL OR p.created_at < $3::timestamptz)
       ORDER BY p.created_at DESC LIMIT $4`, [space.id, ctx.user?.id ?? null, before, n + 1]);
    return json({ posts: posts.slice(0, n), end: posts.length <= n, as_of: asOf() });
  });

  // ---- Conversations (always end-to-end encrypted) ----

  r.get('/conversations', async (ctx) => {
    const me = requireUser(ctx);
    const { limit: n, before } = page(ctx.query);
    const filter = ctx.query.get('requests') === '1'
      ? 'NOT c.accepted AND c.started_by IS DISTINCT FROM $1::uuid'
      : '(c.accepted OR c.started_by = $1::uuid)';
    const conversations = await ctx.db.query(
      `SELECT * FROM (${CONV_SELECT} AND ${filter}) x
       WHERE ($2::timestamptz IS NULL OR x.last_at < $2::timestamptz) ORDER BY x.last_at DESC LIMIT $3`, [me.id, before, n]);
    return json({ conversations, as_of: asOf() });
  });

  // Open (or find) the conversation with someone. It is accepted at once when they follow you;
  // otherwise it waits in their Requests. Opening a request you received accepts it.
  r.post('/conversations', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json();
    const handle = str(b.handle, 'handle', { max: 30 });
    const t = await ctx.db.one<{ id: string }>(`SELECT id FROM users WHERE handle = $1 AND status = 'active'`, [handle]);
    if (!t) return fail(404, 'not_found', 'No one has that username');
    if (t.id === me.id) return fail(400, 'self', 'You cannot message yourself');
    const followsMe = !!(await ctx.db.one('SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2', [t.id, me.id]));
    const pair = 'user_a = LEAST($1::uuid, $2::uuid) AND user_b = GREATEST($1::uuid, $2::uuid)';
    const existing = await ctx.db.one<ConvRow>(`SELECT id, accepted, started_by, user_a, user_b FROM conversations WHERE ${pair}`, [me.id, t.id]);
    if (existing) {
      if (!existing.accepted && (followsMe || existing.started_by === t.id)) {
        await ctx.db.query('UPDATE conversations SET accepted = true WHERE id = $1', [existing.id]);
      }
      return json({ conversation: await conversationView(ctx.db, existing.id, me.id) });
    }
    const made = await ctx.db.one<{ id: string }>(
      `INSERT INTO conversations (user_a, user_b, accepted, started_by) VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3, $1::uuid)
       ON CONFLICT (user_a, user_b) DO NOTHING RETURNING id`, [me.id, t.id, followsMe]);
    const id = made?.id ?? (await ctx.db.one<{ id: string }>(`SELECT id FROM conversations WHERE ${pair}`, [me.id, t.id]))?.id;
    if (!id) return fail(409, 'conflict', 'Try again');
    return json({ conversation: await conversationView(ctx.db, id, me.id) }, made ? 201 : 200);
  });

  r.post('/conversations/:id/accept', async (ctx) => {
    const me = requireUser(ctx);
    const c = await loadConversation(ctx, me.id);
    if (c.accepted) return noContent();
    if (c.started_by === me.id) return fail(403, 'not_allowed', 'Only the person you wrote to can accept');
    await ctx.db.query('UPDATE conversations SET accepted = true WHERE id = $1', [c.id]);
    return noContent();
  });

  // Reading the newest page marks the conversation read.
  r.get('/conversations/:id/messages', async (ctx) => {
    const me = requireUser(ctx);
    const c = await loadConversation(ctx, me.id);
    const { limit: n, before } = page(ctx.query);
    const messages = await ctx.db.query(
      `SELECT id, sender_id, sealed, created_at FROM dm_messages
       WHERE conversation_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz) ORDER BY created_at DESC LIMIT $3`,
      [c.id, before, n]);
    if (!before) await markConversationRead(ctx.db, c.id, me.id);
    return json({ messages, as_of: asOf() });
  });

  r.post('/conversations/:id/messages', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    const c = await loadConversation(ctx, me.id);
    const b = await ctx.json();
    refusePlaintext(b, 'Direct messages');
    const sealed = checkSealed(b.sealed, { sender: me.id });
    if (!c.accepted) {
      if (c.started_by === me.id) {
        const sent = await ctx.db.one<{ n: number }>('SELECT count(*)::int AS n FROM dm_messages WHERE conversation_id = $1 AND sender_id = $2', [c.id, me.id]);
        if ((sent?.n ?? 0) >= REQUEST_MESSAGES) return fail(409, 'request_pending', `Wait for them to accept before sending more than ${REQUEST_MESSAGES} messages`);
      } else {
        await ctx.db.query('UPDATE conversations SET accepted = true WHERE id = $1', [c.id]); // writing back accepts
      }
    }
    const message = await ctx.db.one(
      'INSERT INTO dm_messages (conversation_id, sender_id, sealed) VALUES ($1, $2, $3) RETURNING id, sender_id, sealed, created_at',
      [c.id, me.id, JSON.stringify(sealed)]);
    await markConversationRead(ctx.db, c.id, me.id);
    return json({ message }, 201);
  });
}
