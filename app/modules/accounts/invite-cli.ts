// npm run invite -- --email person@example.org [--staff] [--days 7] [--note "first staff account"]
// Emails a one-time invite to that address. Run it on the server to create the first staff account.
// Joining then needs that address and the code sent to it (decision 0008); the address is not stored.
import { loadConfig } from '../../config.ts';
import { connectPg } from '../../db/index.ts';
import { migrate } from '../../db/migrate.ts';
import { emailOf, inviteByEmail } from './routes.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
if (!opt('--email')) throw new Error('--email is required: invites go to an email address');
const email = emailOf(opt('--email'));
const db = await connectPg(config.databaseUrl);
await migrate(db);
const r = await inviteByEmail(db, config, { email, role: args.includes('--staff') ? 'staff' : 'member', days: Number(opt('--days') || 7), note: opt('--note') || '' });
console.log(`invite ${r.renewed ? 'renewed and sent again' : 'sent'}; open until ${r.expiresAt}. They join at ${config.origin}/join with that address.`);
await db.close();
