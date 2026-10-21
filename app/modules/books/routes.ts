// Open Books (decision 0009): the community's money, in public and read-only. Anyone can read the
// ledger, its drafts, trustees, anchors and bank matches. Trustees and staff draft; trustees sign with
// a key made in their own browser; an entry seals when it has the signatures the rules ask for.
// Amounts are whole centavos. Every summary is computed live from the ledger, with `as_of`.
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/index.ts';
import { fail, isUuid, json, noContent, type Ctx, type Router, type SessionUser } from '../../http/router.ts';
import { limit, limits } from '../../http/security.ts';
import { requireStaff, requireUser } from '../../http/session.ts';
import { bad, bool, int, oneOf, str } from '../shared.ts';
import {
  canon, entryHash, GENESIS, keyId, merkleRoot, need, publicJwk, signed, verifyLedger, verifySig,
  type Body, type Entry, type KeyInfo, type LedgerFile, type PartyKind,
} from './ledger.ts';

export const CATEGORIES = ['donations', 'grants', 'ads', 'builders', 'hosting', 'legal', 'events', 'community_aid', 'bank_fees', 'other'] as const;
const PARTY_KINDS = ['company', 'person_consented', 'person_private', 'donors', 'related_party'] as const;
const MAX_AMOUNT = 1_000_000_000_000; // ₱10 billion in centavos: a typo guard, not a policy
const HEX64 = /^[0-9a-f]{64}$/;
/** The OpenTimestamps file header, then version 1 and the SHA-256 op (docs/open-books.md). */
export const OTS_MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
/** Today's date in Manila (UTC+8, no DST). */
const manilaToday = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

interface Row { seq: number; hash: string; entry: Entry }

async function loadLedger(db: Db): Promise<LedgerFile> {
  const rows = await db.query<Row>('SELECT seq, hash, entry FROM books_entries ORDER BY seq');
  const keys = await db.query<KeyInfo>('SELECT key_id, handle, public_key, created_at, retired_at FROM books_keys ORDER BY created_at, key_id');
  const anchors = await db.query<{ id: number; upto_seq: number; root: string }>('SELECT id, upto_seq, root FROM books_anchors ORDER BY id');
  return {
    entries: rows.map((r) => ({ ...r.entry, hash: r.hash })),
    keys: keys.map((k) => ({ ...k, created_at: iso(k.created_at)!, retired_at: iso(k.retired_at) })),
    anchors,
  };
}

const balanceOf = (entries: { body: Body }[]): number => entries.reduce((s, e) => s + signed(e.body), 0);

async function currentRule(db: Db): Promise<{ two_sig_over: number; set_by: string | null; set_at: string }> {
  const r = await db.one<{ two_sig_over: string | number; set_by: string | null; set_at: string }>('SELECT two_sig_over, set_by, set_at FROM books_rules ORDER BY id DESC LIMIT 1');
  return { two_sig_over: Number(r!.two_sig_over), set_by: r!.set_by, set_at: iso(r!.set_at)! };
}

const isTrustee = async (db: Db, userId: string): Promise<boolean> =>
  !!(await db.one('SELECT 1 FROM books_trustees WHERE user_id = $1 AND ended_at IS NULL', [userId]));

/** Trustees and staff may draft and keep the proof up to date. */
async function requireKeeper(ctx: Ctx): Promise<SessionUser> {
  const me = requireUser(ctx);
  if (me.role !== 'staff' && !(await isTrustee(ctx.db, me.id))) fail(403, 'not_trustee', 'Only trustees and staff can do this');
  return me;
}

/** A sealed entry for reading: the body's fields, its hash, who signed and what reversed it. */
function present(e: Entry & { hash: string }, keys: Map<string, KeyInfo>, reversedBy: Map<number, number>) {
  return {
    seq: e.seq, hash: e.hash, prev: e.prev, sealed_at: e.sealed_at,
    kind: e.body.kind, amount: e.body.amount, currency: e.body.currency, date: e.body.date, category: e.body.category,
    description: e.body.description, party: e.body.party, related_note: e.body.related_note ?? null, evidence: e.body.evidence,
    reverses: e.body.reverses ?? null, reversed_by: reversedBy.get(e.seq) ?? null, assisted: e.body.assisted,
    drafted_by: e.body.drafted_by, needs: need(e.body), signers: e.sigs.map((s) => keys.get(s.key_id)?.handle ?? s.key_id), conflicted: e.conflicted,
  };
}

function reversals(entries: Entry[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const e of entries) if (e.body.reverses !== undefined) m.set(e.body.reverses, e.seq);
  return m;
}

/** Party key for totals: a name, a stable ID, or "Donors". */
const partyKey = (p: Body['party']): string => p.kind === 'person_private' ? p.ref! : p.kind === 'donors' ? 'Donors' : p.name!;

/**
 * Totals with corrections netted against what they correct: a reversal lowers the original's side,
 * month, category and party, so the totals say what really happened.
 */
function totals(entries: Entry[]) {
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const month = new Map<string, { in: number; out: number }>();
  const cat = new Map<string, { in: number; out: number }>();
  const party = new Map<string, { kind: PartyKind; name: string; in: number; out: number; entries: number; last_date: string }>();
  let tin = 0, tout = 0;
  for (const e of entries) {
    const o = e.body.reverses !== undefined ? bySeq.get(e.body.reverses) : undefined;
    const base = o ?? e;
    const side: 'in' | 'out' = base.body.kind;
    const amt = o ? -e.body.amount : e.body.amount;
    if (side === 'in') tin += amt; else tout += amt;
    const m = base.body.date.slice(0, 7);
    const mm = month.get(m) ?? { in: 0, out: 0 }; mm[side] += amt; month.set(m, mm);
    const cc = cat.get(base.body.category) ?? { in: 0, out: 0 }; cc[side] += amt; cat.set(base.body.category, cc);
    const k = base.body.party.kind + ':' + partyKey(base.body.party);
    const pp = party.get(k) ?? { kind: base.body.party.kind, name: partyKey(base.body.party), in: 0, out: 0, entries: 0, last_date: '' };
    pp[side] += amt;
    if (!o) pp.entries++;
    if (e.body.date > pp.last_date) pp.last_date = e.body.date;
    party.set(k, pp);
  }
  return { total_in: tin, total_out: tout, month, cat, party };
}

async function budgets(db: Db, year: number) {
  const rows = await db.query<{ category: string; amount: string | number; set_by: string; set_at: string }>(
    `SELECT DISTINCT ON (category) category, amount, set_by, set_at FROM books_budgets WHERE year = $1 ORDER BY category, id DESC`, [year]);
  return rows.map((r) => ({ category: r.category, amount: Number(r.amount), set_by: r.set_by, set_at: iso(r.set_at) }));
}

async function draftsOut(db: Db) {
  const ds = await db.query<{ id: string; body: Body; created_at: string }>('SELECT id, body, created_at FROM books_drafts ORDER BY created_at');
  const sigs = await db.query<{ draft_id: string; handle: string; key_id: string; signed_at: string }>(
    'SELECT s.draft_id, k.handle, s.key_id, s.signed_at FROM books_draft_sigs s JOIN books_keys k ON k.key_id = s.key_id ORDER BY s.signed_at');
  const cons = await db.query<{ draft_id: string; handle: string; note: string }>('SELECT draft_id, handle, note FROM books_draft_conflicts ORDER BY declared_at');
  return ds.map((d) => ({
    id: d.id, created_at: iso(d.created_at), body: d.body, needs: need(d.body),
    signatures: sigs.filter((s) => s.draft_id === d.id).map((s) => ({ handle: s.handle, key_id: s.key_id, signed_at: iso(s.signed_at) })),
    conflicts: cons.filter((c) => c.draft_id === d.id).map((c) => ({ handle: c.handle, note: c.note })),
  }));
}

/**
 * Seal a draft that has its signatures: the next entry in the chain. Locks the ledger so two seals
 * cannot take the same number. Refuses (409) a payment the balance cannot cover. Returns null while
 * signatures are missing.
 */
async function seal(db: Db, draftId: string): Promise<{ seq: number; hash: string } | null> {
  return db.tx(async (tx) => {
    await tx.query('LOCK TABLE books_entries IN SHARE ROW EXCLUSIVE MODE');
    const d = await tx.one<{ body: Body }>('SELECT body FROM books_drafts WHERE id = $1 FOR UPDATE', [draftId]);
    if (!d) return fail(404, 'not_found', 'No such draft');
    const sigs = await tx.query<{ key_id: string; sig: string }>(
      `SELECT s.key_id, s.sig FROM books_draft_sigs s JOIN books_keys k ON k.key_id = s.key_id
       JOIN books_trustees t ON t.user_id = s.user_id AND t.ended_at IS NULL WHERE s.draft_id = $1 AND k.retired_at IS NULL ORDER BY s.key_id`, [draftId]);
    if (sigs.length < need(d.body)) return null;
    const conflicted = (await tx.query<{ handle: string }>('SELECT handle FROM books_draft_conflicts WHERE draft_id = $1 ORDER BY handle', [draftId])).map((c) => c.handle);
    const rows = await tx.query<{ seq: number; hash: string; entry: Entry }>('SELECT seq, hash, entry FROM books_entries ORDER BY seq');
    if (balanceOf(rows.map((r) => r.entry)) + signed(d.body) < 0) return fail(409, 'balance', 'The balance cannot cover this payment yet');
    if (d.body.reverses !== undefined && rows.some((r) => r.entry.body.reverses === d.body.reverses)) return fail(409, 'already_reversed', 'That entry has already been reversed');
    const last = rows[rows.length - 1];
    const t = await tx.one<{ now: string }>('SELECT now()');
    const entry: Entry = { seq: (last?.seq ?? 0) + 1, prev: last?.hash ?? GENESIS, sealed_at: iso(t!.now)!, body: d.body, sigs, conflicted };
    const hash = entryHash(entry);
    await tx.query('INSERT INTO books_entries (seq, hash, entry, sealed_at) VALUES ($1, $2, $3::jsonb, $4)', [entry.seq, hash, JSON.stringify(entry), entry.sealed_at]);
    await tx.query('DELETE FROM books_drafts WHERE id = $1', [draftId]);
    return { seq: entry.seq, hash };
  });
}

function party(v: unknown, kind: 'in' | 'out'): Body['party'] {
  if (!v || typeof v !== 'object') return bad('party', 'is required');
  const p = v as Record<string, unknown>;
  const k = oneOf(p.kind, 'party.kind', PARTY_KINDS);
  if (k === 'donors') {
    if (kind !== 'in') return bad('party', 'donors can only give money in');
    return { kind: k };
  }
  // A private person is shown by a stable ID only. Who it stands for is kept by the foundation, not here.
  if (k === 'person_private') return { kind: k, ref: str(p.ref, 'party.ref', { max: 12, pattern: /^C-\d{4,6}$/ }) };
  return { kind: k, name: str(p.name, 'party.name', { min: 2, max: 80 }) };
}

function evidence(v: unknown): Body['evidence'] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 5) return bad('evidence', 'must be a list of at most 5 files');
  return v.map((f, i) => {
    const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    const h = typeof o.sha256 === 'string' && HEX64.test(o.sha256) ? o.sha256 : bad(`evidence[${i}].sha256`, 'must be a SHA-256 in hex');
    return { name: str(o.name, `evidence[${i}].name`, { min: 1, max: 80 }), sha256: h };
  });
}

function dateIn(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z')) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) return bad(field, 'must be a date (YYYY-MM-DD)');
  if (v < '2026-01-01' || v > manilaToday()) return bad(field, 'must be between 2026-01-01 and today');
  return v;
}

const amountIn = (v: unknown, field = 'amount'): number => int(v, field, 1, MAX_AMOUNT);

export function register(r: Router): void {
  // ---- Public: the summary, the entries, payees, the whole ledger and its check ----
  r.get('/books', async (ctx) => {
    const led = await loadLedger(ctx.db);
    const t = totals(led.entries);
    const year = Number(manilaToday().slice(0, 4));
    const months: { month: string; in: number; out: number }[] = [];
    const now = new Date(Date.now() + 8 * 3600_000);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const m = d.toISOString().slice(0, 7);
      months.push({ month: m, ...(t.month.get(m) ?? { in: 0, out: 0 }) });
    }
    const lastAnchor = led.anchors[led.anchors.length - 1];
    const anchorRow = lastAnchor ? await ctx.db.one<{ created_at: string; stamped: boolean }>('SELECT created_at, ots IS NOT NULL AS stamped FROM books_anchors WHERE id = $1', [lastAnchor.id]) : null;
    const recon = await ctx.db.one<{ statement_date: string; bank_balance: string; ledger_balance: string; created_at: string }>(
      `SELECT to_char(statement_date, 'YYYY-MM-DD') AS statement_date, bank_balance, ledger_balance, created_at FROM books_reconciliations ORDER BY statement_date DESC, id DESC LIMIT 1`);
    const drafts = await ctx.db.one<{ n: number }>('SELECT count(*)::int AS n FROM books_drafts');
    const last = led.entries[led.entries.length - 1];
    return json({
      currency: 'PHP',
      entries: led.entries.length,
      balance: t.total_in - t.total_out,
      total_in: t.total_in,
      total_out: t.total_out,
      last_entry_at: last ? last.sealed_at : null,
      months,
      categories: [...t.cat].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.out + b.in - (a.out + a.in)),
      budgets: { year, items: await budgets(ctx.db, year) },
      drafts_waiting: drafts!.n,
      anchor: lastAnchor ? { id: lastAnchor.id, upto_seq: lastAnchor.upto_seq, root: lastAnchor.root, created_at: iso(anchorRow!.created_at), stamped: anchorRow!.stamped } : null,
      unanchored: led.entries.length - (lastAnchor?.upto_seq ?? 0),
      bank_match: recon ? { statement_date: recon.statement_date, bank_balance: Number(recon.bank_balance), ledger_balance: Number(recon.ledger_balance), created_at: iso(recon.created_at) } : null,
      rule: await currentRule(ctx.db),
      as_of: new Date().toISOString(),
    });
  });

  r.get('/books/entries', async (ctx) => {
    const n = Math.min(50, Math.max(1, Number(ctx.query.get('limit')) || 20));
    const before = Number(ctx.query.get('before')) || Infinity;
    const kind = ctx.query.get('kind');
    const category = ctx.query.get('category');
    const led = await loadLedger(ctx.db);
    const keys = new Map(led.keys.map((k) => [k.key_id, k]));
    const rev = reversals(led.entries);
    const items = led.entries.filter((e) => e.seq < before && (!kind || e.body.kind === kind) && (!category || e.body.category === category))
      .reverse().slice(0, n).map((e) => present(e, keys, rev));
    return json({ items, end: items.length < n, as_of: new Date().toISOString() });
  });

  r.get('/books/entries/:seq', async (ctx) => {
    const seq = Number(ctx.params.seq);
    if (!Number.isInteger(seq) || seq < 1) return fail(404, 'not_found', 'No such entry');
    const led = await loadLedger(ctx.db);
    const e = led.entries[seq - 1];
    if (!e) return fail(404, 'not_found', 'No such entry');
    const keys = new Map(led.keys.map((k) => [k.key_id, k]));
    const anchor = led.anchors.find((a) => a.upto_seq >= seq) ?? null;
    return json({ entry: present(e, keys, reversals(led.entries)), recomputed_hash: entryHash({ seq: e.seq, prev: e.prev, sealed_at: e.sealed_at, body: e.body, sigs: e.sigs, conflicted: e.conflicted }),
      signed_body: canon(e.body), anchored_in: anchor, as_of: new Date().toISOString() });
  });

  r.get('/books/payees', async (ctx) => {
    const led = await loadLedger(ctx.db);
    const t = totals(led.entries);
    const all = [...t.party.values()];
    return json({
      paid: all.filter((p) => p.out > 0).sort((a, b) => b.out - a.out).map((p) => ({ kind: p.kind, name: p.name, amount: p.out, entries: p.entries, last_date: p.last_date })),
      funders: all.filter((p) => p.in > 0).sort((a, b) => b.in - a.in).map((p) => ({ kind: p.kind, name: p.name, amount: p.in, entries: p.entries, last_date: p.last_date })),
      as_of: new Date().toISOString(),
    });
  });

  r.get('/books/ledger', async (ctx) => {
    const led = await loadLedger(ctx.db);
    const rules = await ctx.db.query<{ id: number; two_sig_over: string; set_by: string | null; set_at: string }>('SELECT id, two_sig_over, set_by, set_at FROM books_rules ORDER BY id');
    const as_of = new Date().toISOString();
    const file = { format: 'popcart-community/open-books/v1', currency: 'PHP', as_of, ...led,
      rules: rules.map((x) => ({ id: x.id, two_sig_over: Number(x.two_sig_over), set_by: x.set_by, set_at: iso(x.set_at) })) };
    const headers: Record<string, string> = ctx.query.get('download') ? { 'Content-Disposition': `attachment; filename="open-books-${as_of.slice(0, 10)}.json"` } : {};
    return json(file, 200, headers);
  });

  r.get('/books/verify', async (ctx) => json({ ...(await verifyLedger(await loadLedger(ctx.db))), as_of: new Date().toISOString() }));

  r.get('/books/trustees', async (ctx) => {
    const rows = await ctx.db.query<{ handle: string; first_name: string; appointed_at: string; ended_at: string | null; appointed_by: string | null; key_id: string | null; key_since: string | null }>(
      `SELECT u.handle, u.first_name, t.appointed_at, t.ended_at, a.handle AS appointed_by, k.key_id, k.created_at AS key_since
       FROM books_trustees t JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.appointed_by
       LEFT JOIN books_keys k ON k.user_id = t.user_id AND k.retired_at IS NULL ORDER BY t.ended_at IS NOT NULL, t.appointed_at`);
    return json({ trustees: rows.map((t) => ({ ...t, appointed_at: iso(t.appointed_at), ended_at: iso(t.ended_at), key_since: iso(t.key_since) })), as_of: new Date().toISOString() });
  });

  r.get('/books/drafts', async (ctx) => json({ drafts: await draftsOut(ctx.db), rule: await currentRule(ctx.db), as_of: new Date().toISOString() }));

  r.get('/books/anchors', async (ctx) => {
    const rows = await ctx.db.query<{ id: number; upto_seq: number; root: string; made_by: string; created_at: string; stamped: boolean; stamped_at: string | null }>(
      'SELECT id, upto_seq, root, made_by, created_at, ots IS NOT NULL AS stamped, stamped_at FROM books_anchors ORDER BY id DESC');
    return json({ anchors: rows.map((a) => ({ ...a, created_at: iso(a.created_at), stamped_at: iso(a.stamped_at) })), as_of: new Date().toISOString() });
  });

  r.get('/books/anchors/:id/proof', async (ctx) => {
    const id = Number(ctx.params.id);
    const a = Number.isInteger(id) ? await ctx.db.one<{ ots: Buffer | Uint8Array | null }>('SELECT ots FROM books_anchors WHERE id = $1', [id]) : null;
    if (!a || !a.ots) return fail(404, 'not_found', 'This anchor has no Bitcoin proof yet');
    return { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="open-books-anchor-${id}.ots"` }, body: Buffer.from(a.ots) };
  });

  r.get('/books/reconciliations', async (ctx) => {
    const rows = await ctx.db.query<{ id: number; statement_date: string; bank_balance: string; ledger_balance: string; statement_sha256: string | null; note: string; made_by: string; created_at: string }>(
      `SELECT id, to_char(statement_date, 'YYYY-MM-DD') AS statement_date, bank_balance, ledger_balance, statement_sha256, note, made_by, created_at
       FROM books_reconciliations ORDER BY statement_date DESC, id DESC LIMIT 60`);
    return json({ reconciliations: rows.map((x) => ({ ...x, bank_balance: Number(x.bank_balance), ledger_balance: Number(x.ledger_balance), created_at: iso(x.created_at) })), as_of: new Date().toISOString() });
  });

  // ---- You: are you a trustee, and which key the server has for you ----
  r.get('/books/me', async (ctx) => {
    const me = requireUser(ctx);
    const trustee = await isTrustee(ctx.db, me.id);
    const k = await ctx.db.one<{ key_id: string; public_key: unknown }>('SELECT key_id, public_key FROM books_keys WHERE user_id = $1 AND retired_at IS NULL', [me.id]);
    return json({ trustee, staff: me.role === 'staff', can_draft: trustee || me.role === 'staff', key: trustee && k ? k : null });
  });

  // A trustee publishes the public half of the signing key made in their browser. A new key retires the old one.
  r.put('/books/key', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    if (!(await isTrustee(ctx.db, me.id))) return fail(403, 'not_trustee', 'Only trustees have a signing key');
    const b = await ctx.json<Record<string, unknown>>();
    const jwk = publicJwk(b.public_key) ?? bad('public_key', 'must be the public half of a P-256 key (JWK)');
    const id = keyId(jwk);
    if (await ctx.db.one('SELECT 1 FROM books_keys WHERE key_id = $1', [id])) return fail(409, 'key_used', 'This key is already published; make a new one');
    await ctx.db.tx(async (tx) => {
      const old = await tx.query<{ key_id: string }>('UPDATE books_keys SET retired_at = now() WHERE user_id = $1 AND retired_at IS NULL RETURNING key_id', [me.id]);
      // signatures made with a retired key on drafts still waiting no longer count
      for (const o of old) await tx.query('DELETE FROM books_draft_sigs WHERE key_id = $1', [o.key_id]);
      await tx.query('INSERT INTO books_keys (key_id, user_id, handle, public_key) VALUES ($1, $2, $3, $4::jsonb)', [id, me.id, me.handle, JSON.stringify(jwk)]);
    });
    return json({ key: { key_id: id, public_key: jwk } }, 201);
  });

  // ---- Staff: appoint and end trustees, the signing limit, budgets ----
  r.post('/books/trustees', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const handle = str(b.handle, 'handle', { max: 30 }).replace(/^@/, '').toLowerCase();
    const u = await ctx.db.one<{ id: string; status: string }>('SELECT id, status FROM users WHERE handle = $1', [handle]);
    if (!u || u.status !== 'active') return fail(404, 'not_found', 'No active member with that handle');
    const row = await ctx.db.one(`INSERT INTO books_trustees (user_id, appointed_by) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET appointed_by = $2, appointed_at = now(), ended_at = NULL WHERE books_trustees.ended_at IS NOT NULL RETURNING 1`, [u.id, me.id]);
    if (!row) return fail(409, 'already_trustee', 'Already a trustee');
    return json({ trustee: { handle, appointed_by: me.handle } }, 201);
  });

  r.delete('/books/trustees/:handle', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    const u = await ctx.db.one<{ id: string }>('SELECT id FROM users WHERE handle = $1', [ctx.params.handle]);
    if (!u) return fail(404, 'not_found', 'No such trustee');
    const ok = await ctx.db.tx(async (tx) => {
      const t = await tx.one('UPDATE books_trustees SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL RETURNING 1', [u.id]);
      if (!t) return false;
      const old = await tx.query<{ key_id: string }>('UPDATE books_keys SET retired_at = now() WHERE user_id = $1 AND retired_at IS NULL RETURNING key_id', [u.id]);
      for (const o of old) await tx.query('DELETE FROM books_draft_sigs WHERE key_id = $1', [o.key_id]);
      return true;
    });
    return ok ? noContent() : fail(404, 'not_found', 'Not a trustee');
  });

  r.put('/books/rule', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const v = int(b.two_sig_over, 'two_sig_over', 0, MAX_AMOUNT);
    await ctx.db.query('INSERT INTO books_rules (two_sig_over, set_by) VALUES ($1, $2)', [v, me.handle]);
    return json({ rule: await currentRule(ctx.db) });
  });

  r.post('/books/budgets', async (ctx) => {
    const me = requireStaff(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const year = int(b.year, 'year', 2026, 2100);
    const category = oneOf(b.category, 'category', CATEGORIES);
    const amount = int(b.amount, 'amount', 0, MAX_AMOUNT);
    await ctx.db.query('INSERT INTO books_budgets (year, category, amount, set_by) VALUES ($1, $2, $3, $4)', [year, category, amount, me.handle]);
    return json({ budgets: { year, items: await budgets(ctx.db, year) } }, 201);
  });

  // ---- Trustees and staff: drafts ----
  r.post('/books/drafts', async (ctx) => {
    const me = await requireKeeper(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const rule = await currentRule(ctx.db);
    const rows = await ctx.db.query<{ entry: Entry }>('SELECT entry FROM books_entries ORDER BY seq');
    const description = str(b.description, 'description', { min: 3, max: 200 });
    const date = dateIn(b.date, 'date');
    const assisted = bool(b.assisted);
    const base = { v: 1 as const, id: randomUUID(), currency: 'PHP' as const, date, description, assisted, two_sig_over: rule.two_sig_over, drafted_by: me.handle, drafted_at: new Date().toISOString() };
    let body: Body;
    if (b.reverses !== undefined && b.reverses !== null) {
      // A correction: the exact opposite of an earlier entry. Never an edit.
      const seq = int(b.reverses, 'reverses', 1, 1_000_000_000);
      const o = rows[seq - 1]?.entry;
      if (!o) return bad('reverses', 'is not an entry in the ledger');
      if (o.body.reverses !== undefined) return bad('reverses', 'a correction cannot itself be reversed: draft a new entry instead');
      if (rows.some((r) => r.entry.body.reverses === seq)) return fail(409, 'already_reversed', 'That entry has already been reversed');
      body = { ...base, kind: o.body.kind === 'in' ? 'out' : 'in', amount: o.body.amount, category: o.body.category, party: o.body.party,
        ...(o.body.related_note ? { related_note: o.body.related_note } : {}), evidence: evidence(b.evidence), reverses: seq };
    } else {
      const kind = oneOf(b.kind, 'kind', ['in', 'out'] as const);
      const p = party(b.party, kind);
      body = { ...base, kind, amount: amountIn(b.amount), category: oneOf(b.category, 'category', CATEGORIES), party: p, evidence: evidence(b.evidence) };
      // A related party (a trustee, staff, or a company tied to them) needs the reason it was fair, in public.
      if (p.kind === 'related_party') body.related_note = str(b.related_note, 'related_note', { min: 10, max: 300 });
    }
    if (balanceOf(rows.map((r) => r.entry)) + signed(body) < 0) return fail(409, 'balance', 'The balance cannot cover this payment');
    await ctx.db.query('INSERT INTO books_drafts (id, body, drafted_by) VALUES ($1, $2::jsonb, $3)', [body.id, JSON.stringify(body), me.id]);
    return json({ draft: (await draftsOut(ctx.db)).find((d) => d.id === body.id) }, 201);
  });

  r.delete('/books/drafts/:id', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such draft');
    const d = await ctx.db.one<{ drafted_by: string }>('SELECT drafted_by FROM books_drafts WHERE id = $1', [ctx.params.id]);
    if (!d) return fail(404, 'not_found', 'No such draft');
    if (d.drafted_by !== me.id && me.role !== 'staff') return fail(403, 'not_yours', 'Only the person who drafted it, or staff, can withdraw a draft');
    await ctx.db.query('DELETE FROM books_drafts WHERE id = $1', [ctx.params.id]);
    return noContent();
  });

  r.post('/books/drafts/:id/conflict', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    if (!(await isTrustee(ctx.db, me.id))) return fail(403, 'not_trustee', 'Only trustees declare conflicts');
    if (!isUuid(ctx.params.id) || !(await ctx.db.one('SELECT 1 FROM books_drafts WHERE id = $1', [ctx.params.id]))) return fail(404, 'not_found', 'No such draft');
    const b = await ctx.json<Record<string, unknown>>();
    const note = str(b.note, 'note', { max: 200, optional: true });
    await ctx.db.tx(async (tx) => {
      await tx.query(`INSERT INTO books_draft_conflicts (draft_id, user_id, handle, note) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [ctx.params.id, me.id, me.handle, note]);
      await tx.query('DELETE FROM books_draft_sigs WHERE draft_id = $1 AND user_id = $2', [ctx.params.id, me.id]);
    });
    return json({ draft: (await draftsOut(ctx.db)).find((d) => d.id === ctx.params.id) });
  });

  r.post('/books/drafts/:id/sign', async (ctx) => {
    const me = requireUser(ctx);
    limit(limits.write, me.id);
    if (!(await isTrustee(ctx.db, me.id))) return fail(403, 'not_trustee', 'Only trustees sign');
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such draft');
    const d = await ctx.db.one<{ body: Body; drafted_by: string }>('SELECT body, drafted_by FROM books_drafts WHERE id = $1', [ctx.params.id]);
    if (!d) return fail(404, 'not_found', 'No such draft');
    if (d.drafted_by === me.id || d.body.drafted_by === me.handle) return fail(403, 'own_draft', 'Nobody signs their own draft');
    if (await ctx.db.one('SELECT 1 FROM books_draft_conflicts WHERE draft_id = $1 AND user_id = $2', [ctx.params.id, me.id])) return fail(403, 'conflicted', 'You declared a conflict on this draft');
    const k = await ctx.db.one<{ key_id: string; public_key: unknown }>('SELECT key_id, public_key FROM books_keys WHERE user_id = $1 AND retired_at IS NULL', [me.id]);
    if (!k) return fail(409, 'no_key', 'Set up your signing key first');
    const b = await ctx.json<Record<string, unknown>>();
    if (b.key_id !== k.key_id) return fail(409, 'key_changed', 'This browser\'s key is not your published key');
    const jwk = publicJwk(k.public_key)!;
    if (!(await verifySig(jwk, d.body, b.sig as string))) return bad('sig', 'does not check against your key for this draft');
    // Only while the draft still waits: another trustee's signature may have sealed it a moment ago.
    const ins = await ctx.db.one(`INSERT INTO books_draft_sigs (draft_id, user_id, key_id, sig) SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM books_drafts WHERE id = $1)
      ON CONFLICT DO NOTHING RETURNING 1`, [ctx.params.id, me.id, k.key_id, b.sig]);
    if (!ins) {
      if (!(await ctx.db.one('SELECT 1 FROM books_drafts WHERE id = $1', [ctx.params.id]))) return fail(409, 'already_sealed', 'This draft was just sealed with the signatures it needed');
      return fail(409, 'already_signed', 'You have already signed this draft');
    }
    return afterSign(ctx, ctx.params.id);
  });

  // Seal again later, for a draft that had its signatures but was waiting for the balance.
  r.post('/books/drafts/:id/seal', async (ctx) => {
    const me = await requireKeeper(ctx);
    limit(limits.write, me.id);
    if (!isUuid(ctx.params.id)) return fail(404, 'not_found', 'No such draft');
    const s = await seal(ctx.db, ctx.params.id);
    if (!s) return fail(409, 'needs_signatures', 'This draft does not have its signatures yet');
    return json({ sealed: s }, 201);
  });

  // ---- Trustees and staff: the proof ----
  r.post('/books/anchors', async (ctx) => {
    const me = await requireKeeper(ctx);
    limit(limits.write, me.id);
    const rows = await ctx.db.query<{ seq: number; hash: string }>('SELECT seq, hash FROM books_entries ORDER BY seq');
    const last = await ctx.db.one<{ upto_seq: number }>('SELECT upto_seq FROM books_anchors ORDER BY id DESC LIMIT 1');
    if (!rows.length || (last && last.upto_seq >= rows.length)) return fail(409, 'nothing_new', 'There are no new entries to anchor');
    const root = merkleRoot(rows.map((r) => r.hash));
    const a = await ctx.db.one<{ id: number }>('INSERT INTO books_anchors (upto_seq, root, made_by) VALUES ($1, $2, $3) RETURNING id', [rows.length, root, me.handle]);
    return json({ anchor: { id: a!.id, upto_seq: rows.length, root, stamped: false } }, 201);
  });

  // Attach the OpenTimestamps proof for an anchor's root (made by `npm run books:stamp`, or by hand). Once.
  r.put('/books/anchors/:id/proof', async (ctx) => {
    const me = await requireKeeper(ctx);
    limit(limits.write, me.id);
    const id = Number(ctx.params.id);
    const a = Number.isInteger(id) ? await ctx.db.one<{ root: string; stamped: boolean }>('SELECT root, ots IS NOT NULL AS stamped FROM books_anchors WHERE id = $1', [id]) : null;
    if (!a) return fail(404, 'not_found', 'No such anchor');
    if (a.stamped) return fail(409, 'stamped', 'This anchor already has its proof');
    const b = await ctx.json<Record<string, unknown>>();
    const ots = typeof b.ots === 'string' && b.ots.length <= 40_000 ? Buffer.from(b.ots, 'base64') : bad('ots', 'must be the .ots file in base64');
    if (!otsCovers(ots, a.root)) return bad('ots', 'is not an OpenTimestamps proof of this anchor\'s root');
    await attachProof(ctx.db, id, ots);
    return json({ anchor: { id, stamped: true } });
  });

  r.post('/books/reconciliations', async (ctx) => {
    const me = await requireKeeper(ctx);
    limit(limits.write, me.id);
    const b = await ctx.json<Record<string, unknown>>();
    const date = dateIn(b.statement_date, 'statement_date');
    const bank = int(b.bank_balance, 'bank_balance', -MAX_AMOUNT, MAX_AMOUNT);
    const h = b.statement_sha256 === undefined || b.statement_sha256 === null || b.statement_sha256 === '' ? null
      : typeof b.statement_sha256 === 'string' && HEX64.test(b.statement_sha256) ? b.statement_sha256 : bad('statement_sha256', 'must be a SHA-256 in hex');
    const note = str(b.note, 'note', { max: 200, optional: true });
    const rows = await ctx.db.query<{ entry: Entry }>('SELECT entry FROM books_entries ORDER BY seq');
    const ledger = balanceOf(rows.map((r) => r.entry).filter((e) => e.body.date <= date));
    const x = await ctx.db.one<{ id: number }>(`INSERT INTO books_reconciliations (statement_date, bank_balance, ledger_balance, statement_sha256, note, made_by)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [date, bank, ledger, h, note, me.handle]);
    return json({ reconciliation: { id: x!.id, statement_date: date, bank_balance: bank, ledger_balance: ledger, matched: bank === ledger } }, 201);
  });
}

async function afterSign(ctx: Ctx, draftId: string) {
  try {
    const s = await seal(ctx.db, draftId);
    if (s) return json({ sealed: s }, 201);
  } catch (e) {
    const code = (e as { code?: string }).code;
    // Sealed a moment ago by another signature (the draft is gone): this signature was not needed.
    if (code === 'not_found') return fail(409, 'already_sealed', 'This draft was just sealed with the signatures it needed');
    // Signed, but the balance cannot cover it yet: the signature stays, the draft waits.
    if (code !== 'balance') throw e;
    return json({ draft: (await draftsOut(ctx.db)).find((d) => d.id === draftId), waiting: 'balance' });
  }
  return json({ draft: (await draftsOut(ctx.db)).find((d) => d.id === draftId) });
}

/** Does this .ots file start with the OpenTimestamps header, version 1, SHA-256, then this root? */
export function otsCovers(ots: Buffer, rootHex: string): boolean {
  const n = OTS_MAGIC.length;
  return ots.length > n + 34 && ots.subarray(0, n).equals(OTS_MAGIC) && ots[n] === 0x01 && ots[n + 1] === 0x08
    && ots.subarray(n + 2, n + 34).toString('hex') === rootHex;
}

export async function attachProof(db: Db, id: number, ots: Buffer): Promise<void> {
  await db.query('UPDATE books_anchors SET ots = $2, stamped_at = now() WHERE id = $1 AND ots IS NULL', [id, ots]);
}
