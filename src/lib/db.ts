import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { lockLocalDatabase } from './local-database-lock';
import { migrateDatabase } from './migrations';
import { bootstrapAdministrator } from './bootstrap-admin';

export interface SQL { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; }
export interface Database extends SQL { transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>; close(): Promise<void>; }

export async function createDatabase(options: { url?: string; directory?: string; bootstrapAdmin?: boolean } = {}): Promise<Database> {
 if (options.url) {
  const pool = new Pool({ connectionString: options.url, max: 4, idleTimeoutMillis: 20000, connectionTimeoutMillis: 15000 });
  try {
   const setup = await pool.connect();
   try {
    await setup.query('BEGIN');
    await setup.query('SELECT pg_advisory_xact_lock(874103921)');
    await migrateDatabase({ async query<T>(sql: string, params: unknown[] = []) { const result=await setup.query(sql,params); return {rows:result.rows as T[]}; } }, async sql=>{ await setup.query(sql); });
    await setup.query('COMMIT');
   } catch (error) { await setup.query('ROLLBACK').catch(()=>{}); throw error; }
   finally { setup.release(); }
  } catch (error) { await pool.end(); throw error; }
  const database: Database = {
   async query<T>(sql: string, params: unknown[] = []) { const result = await pool.query(sql, params); return { rows: result.rows as T[] }; },
   async transaction<T>(fn: (tx: SQL) => Promise<T>) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn({ async query<T>(sql: string, params: unknown[] = []) { const r = await client.query(sql, params); return { rows: r.rows as T[] }; } }); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
   },
   async close() { await pool.end(); }
  };
  try { if (options.bootstrapAdmin !== false && process.env.ADMIN_INITIAL_PASSWORD) await bootstrapAdministrator(database, process.env.ADMIN_INITIAL_PASSWORD); }
  catch (error) { await database.close(); throw error; }
  return database;
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
 try { await db.transaction(async tx => { await migrateDatabase({ async query<T>(sql:string,params:unknown[] = []) { const result=await tx.query<T>(sql,params); return {rows:result.rows}; } }, async sql=>{ await tx.exec(sql); }); }); } catch(error) { await close().catch(()=>{}); throw error; }
 const database: Database = {
  async query<T>(sql: string, params: unknown[] = []) { const result = await db.query<T>(sql, params); return { rows: result.rows }; },
  async transaction<T>(fn: (tx: SQL) => Promise<T>) { return db.transaction(async tx => fn({ async query<T>(sql: string, params: unknown[] = []) { const result = await tx.query<T>(sql, params); return { rows: result.rows }; } })); },
  async close() { await close(); }
 };
 try { if (options.bootstrapAdmin !== false && process.env.ADMIN_INITIAL_PASSWORD) await bootstrapAdministrator(database,process.env.ADMIN_INITIAL_PASSWORD); }
 catch(error) { await close().catch(()=>{}); throw error; }
 return database;
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
