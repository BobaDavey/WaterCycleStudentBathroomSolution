import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { lockLocalDatabase } from './local-database-lock';

export interface SQL { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; }
export interface Database extends SQL { transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>; close(): Promise<void>; }
const schema = `
CREATE TABLE IF NOT EXISTS classrooms (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, capacity INTEGER NOT NULL DEFAULT 2 CHECK(capacity = 2)
);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('teacher','student')), first_name TEXT NOT NULL, last_name TEXT NOT NULL,
 username TEXT NOT NULL UNIQUE, password_hash TEXT, classroom_id TEXT NOT NULL REFERENCES classrooms(id), enabled BOOLEAN NOT NULL DEFAULT TRUE,
 must_change_password BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS questions (
 id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id), prompt TEXT NOT NULL, options JSONB NOT NULL,
 correct_index INTEGER NOT NULL, topic TEXT NOT NULL, explanation TEXT NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE,
 deleted BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS quizzes (
 id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id), questions JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 used BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS visits (
 id TEXT PRIMARY KEY, classroom_id TEXT NOT NULL REFERENCES classrooms(id), student_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN ('waiting','ready','out','returned','cancelled')),
 requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, ready_at TIMESTAMPTZ, left_at TIMESTAMPTZ, returned_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_visit ON visits(student_id) WHERE status IN ('waiting','ready','out');
CREATE INDEX IF NOT EXISTS visits_classroom ON visits(classroom_id, requested_at);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at TIMESTAMPTZ NOT NULL);
`;

export async function createDatabase(options: { url?: string; directory?: string } = {}): Promise<Database> {
 if (options.url) {
  const pool = new Pool({ connectionString: options.url, max: 4, idleTimeoutMillis: 20000, connectionTimeoutMillis: 15000 });
  const setup = await pool.connect();
  try {
   await setup.query('BEGIN');
   await setup.query('SELECT pg_advisory_xact_lock(874103921)');
   await setup.query(schema);
   await setup.query('COMMIT');
  } catch (error) { await setup.query('ROLLBACK'); throw error; }
  finally { setup.release(); }
  return {
   async query<T>(sql: string, params: unknown[] = []) { const result = await pool.query(sql, params); return { rows: result.rows as T[] }; },
   async transaction<T>(fn: (tx: SQL) => Promise<T>) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn({ async query<T>(sql: string, params: unknown[] = []) { const r = await client.query(sql, params); return { rows: r.rows as T[] }; } }); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
   },
   async close() { await pool.end(); }
  };
 }
 const directory = options.directory ?? path.join(process.cwd(), '.local', 'data');
 if (directory !== 'memory://') await mkdir(directory, { recursive: true });
 const release = directory === 'memory://' ? async () => {} : await lockLocalDatabase(directory);
 const db = new PGlite(directory);
 let closing: Promise<void> | undefined;
 const close = () => closing ??= (async () => {
  try { await db.close(); } finally {
   process.removeListener('SIGTERM',onTerm);
   process.removeListener('SIGINT',onInt);
   await release();
  }
 })();
 const onTerm = () => { process.exitCode=143; void close().catch(()=>{}); };
 const onInt = () => { process.exitCode=130; void close().catch(()=>{}); };
 if (directory !== 'memory://') {
  process.prependListener('SIGTERM',onTerm);
  process.prependListener('SIGINT',onInt);
 }
 try { await db.exec(schema); } catch(error) { await close().catch(()=>{}); throw error; }
 return {
  async query<T>(sql: string, params: unknown[] = []) { const result = await db.query<T>(sql, params); return { rows: result.rows }; },
  async transaction<T>(fn: (tx: SQL) => Promise<T>) { return db.transaction(async tx => fn({ async query<T>(sql: string, params: unknown[] = []) { const result = await tx.query<T>(sql, params); return { rows: result.rows }; } })); },
  async close() { await close(); }
 };
}

declare global { var watercycleDatabase: Promise<Database> | undefined; }
export function getDatabase(): Promise<Database> {
 if (!globalThis.watercycleDatabase) {
  if (!process.env.DATABASE_URL && process.env.NODE_ENV === 'production' && process.env.LOCAL_DATABASE !== 'true') {
   throw new Error('DATABASE_URL must be configured for production. Use a PostgreSQL database from your Vercel project.');
  }
  globalThis.watercycleDatabase = createDatabase({ url: process.env.DATABASE_URL, directory: process.env.LOCAL_DATABASE_PATH }).catch(error => { globalThis.watercycleDatabase = undefined; throw error; });
 }
 return globalThis.watercycleDatabase;
}
