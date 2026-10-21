// npm run handles:check
// Lists accounts whose username breaks the rule made in 0.6.1 (decision 0009): a reserved name, a shape
// the rule no longer allows, or a look-alike of another account. Nothing is changed: staff decide each
// case with the person. Prints usernames only.
import { loadConfig } from '../../config.ts';
import { connectPg } from '../../db/index.ts';
import { migrate } from '../../db/migrate.ts';
import { handleProblem } from './handles.ts';

const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
const db = await connectPg(config.databaseUrl);
await migrate(db);
const rows = await db.query<{ handle: string; handle_key: string }>(`SELECT handle, handle_key FROM users WHERE status <> 'deleted' ORDER BY created_at`);
const byKey = new Map<string, string[]>();
for (const r of rows) byKey.set(r.handle_key, [...(byKey.get(r.handle_key) || []), r.handle]);
let n = 0;
for (const r of rows) {
  const p = await handleProblem(r.handle);
  const twins = (byKey.get(r.handle_key) || []).filter((h) => h !== r.handle);
  if (p) { n++; console.log(`@${r.handle}: ${p === 'reserved' ? 'a reserved name' : 'breaks the username rule'}`); }
  else if (twins.length) { n++; console.log(`@${r.handle}: looks like ${twins.map((h) => '@' + h).join(', ')}`); }
}
console.log(n ? `${n} username${n === 1 ? '' : 's'} to look at.` : 'Every username follows the rule.');
await db.close();
