// npm run migrate   (needs DATABASE_URL)
import { loadConfig } from '../config.ts';
import { connectPg } from './index.ts';
import { migrate } from './migrate.ts';

const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
const db = await connectPg(config.databaseUrl);
const applied = await migrate(db, console.log);
console.log(applied.length ? `migrate: ${applied.length} applied` : 'migrate: up to date');
await db.close();
