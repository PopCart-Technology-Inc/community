// Plain SQL migrations, applied in file-name order, each in its own transaction, recorded in
// schema_migrations. A migration that has run is never edited: add a new file instead.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './index.ts';

const DIR = join(import.meta.dirname, 'migrations');

export async function migrate(db: Db, log: (s: string) => void = () => {}): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(DIR, name), 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    applied.push(name);
    log(`migrate: applied ${name}`);
  }
  return applied;
}
