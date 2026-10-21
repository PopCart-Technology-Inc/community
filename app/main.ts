// npm start: connect, migrate, listen.
import { mkdirSync } from 'node:fs';
import { loadConfig, staffConfigProblem } from './config.ts';
import { connectPg } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './server.ts';

const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
if (!config.emailKey || config.emailKey.length < 32) throw new Error('EMAIL_HASH_KEY is not set (at least 32 random characters)');
if (config.resendKey && !config.mailFrom) throw new Error('MAIL_FROM is not set (needed with RESEND_API_KEY)');
const staffProblem = staffConfigProblem(config);
if (staffProblem) throw new Error(staffProblem);
mkdirSync(config.mediaDir, { recursive: true });
const db = await connectPg(config.databaseUrl);
await migrate(db, (s) => console.log(JSON.stringify({ level: 'info', msg: s })));
const { server } = createApp(db, config);
server.listen(config.port, () => console.log(JSON.stringify({ level: 'info', msg: 'listening', port: config.port, origin: config.origin })));
const stop = () => server.close(() => db.close().then(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
