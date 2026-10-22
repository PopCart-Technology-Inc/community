// npm run staff -- list
// npm run staff -- roles
// npm run staff -- grant <username> <role> [--days 90]
// npm run staff -- renew <username> [--days 90]
// npm run staff -- revoke <username>
// Staff roles from the server's command line (decision 0009). Until a second Overseer exists, this is
// where Overseers are made and removed. Prints usernames and roles only.
import { loadConfig } from '../../config.ts';
import { connectPg } from '../../db/index.ts';
import { migrate } from '../../db/migrate.ts';
import { HttpError } from '../../http/router.ts';
import { grantRole, listStaff, renewRole, revokeRole, roleNames } from './members.ts';

const [cmd, ...args] = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const days = opt('--days') ? Number(opt('--days')) : undefined;
const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
const db = await connectPg(config.databaseUrl);
await migrate(db);
const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : 'no end date');
try {
  if (cmd === 'list') {
    const rows = await listStaff(db);
    for (const r of rows) console.log(`@${r.handle}  ${r.role}  ${day(r.ends_at)}`);
    console.log(`${rows.length} staff.`);
  } else if (cmd === 'roles') {
    console.log((await roleNames(db)).join('\n'));
  } else if (cmd === 'grant' && args[0] && args[1]) {
    const r = await grantRole(db, { handle: args[0], role: args[1], days });
    console.log(`@${args[0]} is now ${args[1]} (${day(r.ends_at)}).`);
  } else if (cmd === 'renew' && args[0]) {
    console.log(`renewed until ${day((await renewRole(db, { handle: args[0], days })).ends_at)}.`);
  } else if (cmd === 'revoke' && args[0]) {
    console.log(`@${args[0]} is no longer ${(await revokeRole(db, args[0])).role}.`);
  } else {
    console.log('usage: npm run staff -- list | roles | grant <username> <role> [--days 90] | renew <username> [--days 90] | revoke <username>');
    process.exitCode = 1;
  }
} catch (e) {
  if (!(e instanceof HttpError)) throw e;
  console.error(`staff: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
