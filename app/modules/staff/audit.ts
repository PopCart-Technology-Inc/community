// The staff audit log (decision 0009, point 12): every staff action, append-only. The database refuses
// to change or delete a row (migration 0010), so this file only ever inserts and reads.
import type { Db } from '../../db/index.ts';

export const KINDS = ['session', 'staff', 'role', 'invite', 'report', 'appeal', 'account', 'switch', 'approval', 'vault', 'audit'] as const;
export type Kind = (typeof KINDS)[number];

export interface Actor { id: string | null; handle: string }

/** Write one entry. `actor` is the staff member, or { id: null, handle: 'system' } for the server itself. */
export async function logStaff(db: Db, actor: Actor, kind: Kind, text: string, subject?: { id: string | null; handle: string } | null, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query(
    `INSERT INTO staff_actions (actor_id, actor_handle, kind, text, subject_id, subject_handle, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.id, actor.handle, kind, text.slice(0, 500), subject?.id ?? null, subject?.handle ?? null, JSON.stringify(detail)]);
}

export interface Entry { id: string; at: string; who: string; kind: string; text: string; subject: string | null; detail: Record<string, unknown> }

/** Newest first, filtered by who did it, the kind, and words in the text. Paged by time. */
export async function readLog(db: Db, f: { who?: string | null; kind?: string | null; q?: string | null; before?: string | null; limit: number }): Promise<Entry[]> {
  const where: string[] = [], vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('$?', `$${vals.length}`)); };
  if (f.who) add('actor_handle = $?', f.who.replace(/^@/, '').toLowerCase());
  if (f.kind) add('kind = $?', f.kind);
  if (f.q) {
    vals.push(`%${f.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    where.push(`(text ILIKE $${vals.length} ESCAPE '\\' OR coalesce(subject_handle, '') ILIKE $${vals.length} ESCAPE '\\')`);
  }
  if (f.before) add('at < $?', f.before);
  vals.push(f.limit);
  return db.query<Entry>(
    `SELECT id, at, actor_handle AS who, kind, text, subject_handle AS subject, detail FROM staff_actions
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT $${vals.length}`, vals);
}
