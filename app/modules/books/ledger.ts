// Open Books (decision 0009): the ledger's maths. Canonical JSON, SHA-256 hashes, ECDSA P-256
// signatures and Merkle roots, plus the full check anyone can run. The browser has its own copy in
// app/web/static/lib/ledger.js; the tests check that the two agree. The format is docs/open-books.md.
import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

/** Canonical JSON: object keys sorted at every level, no spaces. Only whole numbers are allowed. */
export function canon(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('canon: only whole numbers');
    return String(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  }
  throw new Error('canon: unsupported value');
}

export const sha256hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export interface PublicJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string }

/** The public parts of a P-256 JWK, or null when it is not one. */
export function publicJwk(v: unknown): PublicJwk | null {
  if (!v || typeof v !== 'object') return null;
  const k = v as Record<string, unknown>;
  const b64 = /^[A-Za-z0-9_-]{43}$/;
  if (k.kty !== 'EC' || k.crv !== 'P-256' || typeof k.x !== 'string' || typeof k.y !== 'string' || !b64.test(k.x) || !b64.test(k.y) || 'd' in k) return null;
  return { kty: 'EC', crv: 'P-256', x: k.x, y: k.y };
}

/** A key's id: the first 16 hex characters of the SHA-256 of its canonical public JWK. */
export const keyId = (jwk: PublicJwk): string => sha256hex(canon(jwk)).slice(0, 16);

/** Check an ECDSA P-256 / SHA-256 signature (64 bytes, base64url) over the canonical JSON of `body`. */
export async function verifySig(jwk: PublicJwk, body: unknown, sig: string): Promise<boolean> {
  if (typeof sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig, 'base64url'), new TextEncoder().encode(canon(body)));
  } catch {
    return false;
  }
}

/** Merkle root over entry hashes (hex). Pairs hash their 32-byte values joined; an odd last one pairs with itself. */
export function merkleRoot(hashes: string[]): string {
  if (!hashes.length) return GENESIS;
  let level: Buffer[] = hashes.map((x) => Buffer.from(x, 'hex'));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i] as Buffer, b = level[i + 1] ?? a;
      next.push(createHash('sha256').update(Buffer.concat([a, b])).digest());
    }
    level = next;
  }
  return (level[0] as Buffer).toString('hex');
}

export type PartyKind = 'company' | 'person_consented' | 'person_private' | 'donors' | 'related_party';

export interface Body {
  v: 1;
  id: string;
  kind: 'in' | 'out';
  amount: number;
  currency: 'PHP';
  date: string;
  category: string;
  description: string;
  party: { kind: PartyKind; name?: string; ref?: string };
  related_note?: string;
  evidence: { name: string; sha256: string }[];
  reverses?: number;
  assisted: boolean;
  two_sig_over: number;
  drafted_by: string;
  drafted_at: string;
}

export interface Sig { key_id: string; sig: string }

/** What is hashed for each sealed entry. */
export interface Entry { seq: number; prev: string; sealed_at: string; body: Body; sigs: Sig[]; conflicted: string[] }

/** Signatures an entry needs: two over the limit or for a related party, otherwise one. */
export const need = (b: Pick<Body, 'amount' | 'two_sig_over' | 'party'>): number => (b.party.kind === 'related_party' || b.amount > b.two_sig_over ? 2 : 1);

export const entryHash = (e: Entry): string => sha256hex(canon(e));

/** +amount for money in, -amount for money out. */
export const signed = (b: Pick<Body, 'kind' | 'amount'>): number => (b.kind === 'in' ? b.amount : -b.amount);

export interface KeyInfo { key_id: string; handle: string; public_key: PublicJwk; created_at: string; retired_at: string | null }
export interface AnchorInfo { id: number; upto_seq: number; root: string }
export interface LedgerFile { entries: (Entry & { hash: string })[]; keys: KeyInfo[]; anchors: AnchorInfo[] }

export interface Check { ok: boolean; entries: number; anchors: number; balance: number; problems: { seq?: number; anchor?: number; check: string; detail: string }[] }

/**
 * The full check: the chain links, every hash, every signature against a key that was live when the
 * entry was sealed, the signing rules, the balance never going below zero, reversals, and every anchor.
 */
export async function verifyLedger(file: LedgerFile): Promise<Check> {
  const problems: Check['problems'] = [];
  const keys = new Map(file.keys.map((k) => [k.key_id, k]));
  const hashes: string[] = [];
  const reversed = new Set<number>();
  const bySeq = new Map<number, Entry>();
  let prev = GENESIS, balance = 0;
  for (const [i, row] of file.entries.entries()) {
    const { hash, ...e } = row;
    const seq = i + 1;
    const p = (check: string, detail: string) => problems.push({ seq, check, detail });
    if (e.seq !== seq) p('order', `expected entry ${seq}, found ${e.seq}`);
    if (e.prev !== prev) p('link', 'does not point at the entry before it');
    const real = entryHash(e);
    if (real !== hash) p('hash', 'its contents do not match its hash');
    hashes.push(real);
    prev = hash;
    const signers = new Set<string>();
    for (const s of e.sigs) {
      const k = keys.get(s.key_id);
      if (!k) { p('signature', `unknown key ${s.key_id}`); continue; }
      const t = Date.parse(e.sealed_at);
      if (Date.parse(k.created_at) > t || (k.retired_at && Date.parse(k.retired_at) <= t)) p('signature', `key ${s.key_id} was not live when this was sealed`);
      if (keyId(k.public_key) !== k.key_id) p('signature', `key ${s.key_id} does not match its id`);
      if (!(await verifySig(k.public_key, e.body, s.sig))) p('signature', `signature by @${k.handle} does not check`);
      if (k.handle === e.body.drafted_by) p('rule', `@${k.handle} signed their own draft`);
      if (e.conflicted.includes(k.handle)) p('rule', `@${k.handle} signed despite a declared conflict`);
      if (signers.has(k.handle)) p('rule', `@${k.handle} signed twice`);
      signers.add(k.handle);
    }
    if (signers.size < need(e.body)) p('rule', `needs ${need(e.body)} signatures, has ${signers.size}`);
    if (e.body.reverses !== undefined) {
      const o = bySeq.get(e.body.reverses);
      if (!o) p('rule', `reverses entry ${e.body.reverses}, which is not before it`);
      else if (o.body.kind === e.body.kind || o.body.amount !== e.body.amount) p('rule', `does not exactly undo entry ${e.body.reverses}`);
      else if (reversed.has(e.body.reverses)) p('rule', `entry ${e.body.reverses} was already reversed`);
      reversed.add(e.body.reverses);
    }
    balance += signed(e.body);
    if (balance < 0) p('balance', 'takes the balance below zero');
    bySeq.set(seq, e);
  }
  for (const a of file.anchors) {
    if (a.upto_seq < 1 || a.upto_seq > hashes.length) { problems.push({ anchor: a.id, check: 'anchor', detail: `covers entries that do not exist` }); continue; }
    if (merkleRoot(hashes.slice(0, a.upto_seq)) !== a.root) problems.push({ anchor: a.id, check: 'anchor', detail: `entries 1-${a.upto_seq} no longer match this anchor` });
  }
  return { ok: problems.length === 0, entries: file.entries.length, anchors: file.anchors.length, balance, problems };
}
