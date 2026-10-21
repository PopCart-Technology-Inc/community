// npm run dev:memory: the real server on an in-memory Postgres (PGlite), for trying the app on your own
// machine with no database server. It starts empty (no sample data) and invites one staff address
// (DEV_EMAIL, default you@example.com). With no RESEND_API_KEY, emails are printed here instead of
// sent, so the join code shows in this window. Everything is lost when it stops. Never use this for
// real people's data.
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { memoryDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './server.ts';
import { inviteByEmail } from './modules/accounts/routes.ts';

const base = loadConfig();
// A staff host on this machine (no gate), unless STAFF_ORIGIN says otherwise.
const staffOrigin = base.staffOrigin || `http://staff.localhost:${base.port}`;
const config = { ...base, staffOrigin, staffRpId: base.staffRpId || new URL(staffOrigin).hostname, mediaDir: process.env.MEDIA_DIR || mkdtempSync(join(tmpdir(), 'community-media-')), emailKey: base.emailKey || randomBytes(32).toString('hex') };
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
  const email = process.env.DEV_EMAIL || 'you@example.com';
  await inviteByEmail(db, config, { email, role: 'staff', days: 1, note: 'dev' });
  console.log(`dev: ${config.origin} (in-memory database, empty); staff panel: ${config.staffOrigin} (no gate on this machine)`);
  console.log(`dev: staff invite for ${email}: open ${config.origin}/join and type that address; the code prints here`);
});
