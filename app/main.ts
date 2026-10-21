// npm start: connect, migrate, listen.
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { connectPg } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './server.ts';
import { sweepReviews } from './modules/review/routes.ts';

const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
if (!config.emailKey || config.emailKey.length < 32) throw new Error('EMAIL_HASH_KEY is not set (at least 32 random characters)');
if (config.resendKey && !config.mailFrom) throw new Error('MAIL_FROM is not set (needed with RESEND_API_KEY)');
mkdirSync(config.mediaDir, { recursive: true });
const db = await connectPg(config.databaseUrl);
await migrate(db, (s) => console.log(JSON.stringify({ level: 'info', msg: s })));
const { server } = createApp(db, config);
server.listen(config.port, () => console.log(JSON.stringify({ level: 'info', msg: 'listening', port: config.port, origin: config.origin })));
// review entries are deleted 90 days after they were sent, whether or not anyone visits
const sweep = () => sweepReviews(db).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'review sweep failed', err: String(e) })));
sweep();
setInterval(sweep, 3600_000).unref();
const stop = () => server.close(() => db.close().then(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
