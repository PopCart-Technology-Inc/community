// Test harness: a fresh in-memory Postgres (PGlite) with the real migrations, the real server on a
// random port, and helpers to make people and call the API as them. Test-only fixture data.
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../app/config.ts';
import { memoryDb, type Db } from '../app/db/index.ts';
import { migrate } from '../app/db/migrate.ts';
import { createApp, type AppDeps } from '../app/server.ts';
import { startStaffSession } from '../app/http/staff-session.ts';

export interface TestApp {
  db: Db;
  config: Config;
  base: string;
  /** The port the server listens on (for requests with another Host header, such as the staff host). */
  port: number;
  close(): Promise<void>;
  /**
   * A signed-in person (session row inserted directly). `role: 'staff'` makes an Overseer (every scope);
   * `staffRole` gives that role instead, optionally ending at `staffEnds`.
   */
  person(p?: Partial<{ handle: string; first_name: string; trade: string; home_area: string; role: 'member' | 'staff'; staffRole: string; staffEnds: Date }>): Promise<Person>;
  /** Anonymous request. */
  call(method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; body: any; headers: Headers }>;
}

export interface Person {
  id: string;
  handle: string;
  cookie: string;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }>;
  /** Staff only: a call to the staff host with a staff session (the test staff host runs without the gate). */
  staff(method: string, path: string, body?: unknown): Promise<HostReply>;
}

export interface HostReply { status: number; body: any; headers: Record<string, string | string[] | undefined> }

/** The test staff host: on this machine, so it runs without the gate (decision 0009). */
export const TEST_STAFF_ORIGIN = 'http://staff.localhost:8081';

/** A request with a Host header of our choosing (fetch can't set Host), e.g. to the staff host. */
export function hostCall(port: number, origin: string, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<HostReply> {
  const headers: Record<string, string> = { Host: new URL(origin).host, Origin: origin, ...opts.headers };
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload) headers['Content-Type'] = 'application/json';
  return new Promise((ok, bad) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        ok({ status: res.statusCode || 0, body, headers: res.headers });
      });
    });
    r.on('error', bad);
    r.end(payload);
  });
}

let seq = 0;

/** `env` adds to the test config (e.g. STAFF_ORIGIN); `deps` swaps parts such as the Access checker. */
export async function startApp(opts: { env?: Record<string, string>; deps?: AppDeps } = {}): Promise<TestApp> {
  const db = await memoryDb();
  await migrate(db);
  const port = 0;
  const config = { ...loadConfig({ COMMUNITY_ORIGIN: 'http://localhost:8080', MEDIA_DIR: mkdtempSync(join(tmpdir(), 'cm-media-')), EMAIL_HASH_KEY: randomBytes(32).toString('hex'), STAFF_ORIGIN: TEST_STAFF_ORIGIN, ...opts.env }), port };
  const { server } = createApp(db, config, opts.deps);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const listening = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${listening}`;

  const call: TestApp['call'] = async (method, path, body, cookie) => {
    const headers: Record<string, string> = { Origin: config.origin };
    if (cookie) headers.Cookie = cookie;
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) { payload = body as unknown as BodyInit; headers['Content-Type'] = 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const r = await fetch(base + '/api' + path, { method, headers, body: payload });
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: r.status, body: parsed, headers: r.headers };
  };

  const person: TestApp['person'] = async (p = {}) => {
    seq++;
    const handle = p.handle || `test.person${seq}`;
    const u = await db.one<{ id: string }>(
      `INSERT INTO users (handle, first_name, trade, home_area, terms_version, terms_accepted_at)
       VALUES ($1, $2, $3, $4, '2026-10-19', now()) RETURNING id`,
      [handle, p.first_name || `Test${seq}`, p.trade || 'other', p.home_area || null]);
    const staffRole = p.staffRole || (p.role === 'staff' ? 'Overseer' : null);
    if (staffRole) await db.query('INSERT INTO staff_members (user_id, role, ends_at) VALUES ($1, $2, $3)', [u!.id, staffRole, p.staffEnds || null]);
    const v = randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
      [createHash('sha256').update(v).digest(), u!.id]);
    const cookie = `cs=${v}`;
    const staffCookie = staffRole ? (await startStaffSession(db, u!.id)).split(';')[0]! : null;
    const staff: Person['staff'] = (m, path, body) => {
      if (!staffCookie) throw new Error('not staff');
      return hostCall(listening, config.staffOrigin!, m, '/api' + path, { body, headers: { Cookie: staffCookie } });
    };
    return { id: u!.id, handle, cookie, call: (m, path, body) => call(m, path, body, cookie), staff };
  };

  return { db, config, base, port: listening, call, person, close: async () => { await new Promise((ok) => server.close(ok)); await db.close(); } };
}

/** Test-only areas: one country, region, city and two barangays, labelled as fixtures. */
export async function seedTestAreas(db: Db): Promise<void> {
  await db.query(`INSERT INTO areas (code, name, level, parent_code, city_code, region_code, country_code) VALUES
    ('PH', 'Philippines (test fixture)', 'country', 'WORLD', NULL, NULL, 'PH'),
    ('T-REG', 'Test Region', 'region', 'PH', NULL, NULL, 'PH'),
    ('T-CITY', 'Test City', 'city', 'T-REG', NULL, 'T-REG', 'PH'),
    ('T-CITY2', 'Other Test City', 'city', 'T-REG', NULL, 'T-REG', 'PH'),
    ('T-BRGY1', 'Test Barangay One', 'barangay', 'T-CITY', 'T-CITY', 'T-REG', 'PH'),
    ('T-BRGY2', 'Test Barangay Two', 'barangay', 'T-CITY', 'T-CITY', 'T-REG', 'PH'),
    ('XX', 'Elsewhere (test fixture)', 'country', 'WORLD', NULL, NULL, 'XX')
    ON CONFLICT DO NOTHING`);
}
