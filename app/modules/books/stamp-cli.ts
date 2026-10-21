// npm run books:stamp
// Stamps every Open Books anchor that has no proof yet on Bitcoin with OpenTimestamps (decision 0009).
// Only the anchor's 32-byte Merkle root is sent to the calendar: no amounts, names or personal data.
// The proof starts "pending"; anyone can complete and check it later with the standard `ots` tools.
import { loadConfig } from '../../config.ts';
import { connectPg } from '../../db/index.ts';
import { migrate } from '../../db/migrate.ts';
import { attachProof, OTS_MAGIC, otsCovers } from './routes.ts';

const CALENDAR = process.env.OTS_CALENDAR || 'https://a.pool.opentimestamps.org';
const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
const db = await connectPg(config.databaseUrl);
await migrate(db);
const todo = await db.query<{ id: number; root: string }>('SELECT id, root FROM books_anchors WHERE ots IS NULL ORDER BY id');
for (const a of todo) {
  const digest = Buffer.from(a.root, 'hex');
  const r = await fetch(CALENDAR + '/digest', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/vnd.opentimestamps.v1' }, body: digest });
  if (!r.ok) { console.error(`anchor ${a.id}: the calendar answered ${r.status}; try again later`); continue; }
  // The .ots file: header, version 1, SHA-256 op, the digest, then the calendar's timestamp.
  const ots = Buffer.concat([OTS_MAGIC, Buffer.from([0x01, 0x08]), digest, Buffer.from(await r.arrayBuffer())]);
  if (!otsCovers(ots, a.root)) { console.error(`anchor ${a.id}: the proof did not come out right; nothing attached`); continue; }
  await attachProof(db, a.id, ots);
  console.log(`anchor ${a.id}: stamped (pending Bitcoin confirmation, usually a few hours)`);
}
if (!todo.length) console.log('every anchor already has its proof');
await db.close();
