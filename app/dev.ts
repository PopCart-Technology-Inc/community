// npm run dev:memory: the real server on an in-memory Postgres (PGlite), for trying the app on your own
// machine with no database server. It starts empty (no sample data) and prints a one-time staff invite.
// Everything is lost when it stops. Never use this for real people's data.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { memoryDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './server.ts';
import { createInvite } from './modules/accounts/routes.ts';

const config = { ...loadConfig(), mediaDir: process.env.MEDIA_DIR || mkdtempSync(join(tmpdir(), 'community-media-')) };
const db = await memoryDb();
await migrate(db);
if (process.env.PLACES_CSV) {
  const { readFileSync } = await import('node:fs');
  const { parsePsgc, buildAreas, importAreas } = await import('./modules/places/import.ts');
  const n = await importAreas(db, buildAreas(parsePsgc(readFileSync(process.env.PLACES_CSV, 'utf8')).rows), { edition: process.env.PLACES_EDITION });
  console.log(`dev: imported ${n} areas`);
}
const { server } = createApp(db, config);
server.listen(config.port, async () => {
  const code = await createInvite(db, { role: 'staff', days: 1, note: 'dev' });
  console.log(`dev: ${config.origin} (in-memory database, empty)`);
  console.log(`dev: staff invite ${config.origin}/join?code=${code}`);
});
