// npm run invite -- [--staff] [--days 7] [--note "first staff account"]
// Prints a one-time invite link. Run it on the server to create the first staff account.
import { loadConfig } from '../../config.ts';
import { connectPg } from '../../db/index.ts';
import { migrate } from '../../db/migrate.ts';
import { createInvite } from './routes.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
const db = await connectPg(config.databaseUrl);
await migrate(db);
const code = await createInvite(db, { role: args.includes('--staff') ? 'staff' : 'member', days: Number(opt('--days') || 7), note: opt('--note') || '' });
console.log(`${config.origin}/join?code=${code}`);
await db.close();
