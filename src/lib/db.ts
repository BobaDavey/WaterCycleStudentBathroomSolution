import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { lockLocalDatabase } from './local-database-lock';
import { migrateDatabase } from './migrations';
import { DatabaseConfigurationError, assertLocalDatabaseAllowed, hosted, managedConfiguration, validatePostgresUrl, type DatabaseBinding } from './database-policy';
import { applyManagedMigrations, initializationLock, verifyRuntimeDatabase } from './managed-database';

export interface SQL { readonly localDevelopment?: boolean; query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; }
export interface Database extends SQL { transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>; close(): Promise<void>; }

export async function createDatabase(options: { url?: string; directory?: string; bootstrapAdmin?: boolean; binding?: DatabaseBinding; operator?: boolean; migration?: {expectedVersion:number;backupReference?:string} } = {}): Promise<Database> {
 if (options.url) {
  if(process.env.CODESPACES==='true')throw new DatabaseConfigurationError('Codespaces use isolated local databases. Remove managed database URLs and run npm run dev:setup.');
  if(!options.binding)throw new Error('Managed database connections require an explicit environment and database identity.');
  validatePostgresUrl(options.url,hosted(process.env));
  const pool = new Pool({ connectionString: options.url, options:'-c search_path=public', max: 4, idleTimeoutMillis: 20000, connectionTimeoutMillis: 15000 });
  try {
   const setup = await pool.connect();
   try {
    await setup.query(options.migration?'BEGIN':'BEGIN READ ONLY');
    const tx:SQL={async query<T>(sql:string,params:unknown[]=[]){const result=await setup.query(sql,params);return{rows:result.rows as T[]};}};
    if(options.migration){await setup.query('SELECT pg_advisory_xact_lock($1)',[initializationLock]);await applyManagedMigrations(tx,options.binding!,options.migration);}
    else await verifyRuntimeDatabase(tx,options.binding!,options.operator===true);
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
  return database;
 }
 assertLocalDatabaseAllowed(process.env);
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
  localDevelopment: true,
  async query<T>(sql: string, params: unknown[] = []) { const result = await db.query<T>(sql, params); return { rows: result.rows }; },
  async transaction<T>(fn: (tx: SQL) => Promise<T>) { return db.transaction(async tx => fn({ localDevelopment: true, async query<T>(sql: string, params: unknown[] = []) { const result = await tx.query<T>(sql, params); return { rows: result.rows }; } })); },
  async close() { await close(); }
 };
 return database;
}

declare global { var watercycleDatabase: Promise<Database> | undefined; }
export function getDatabase(): Promise<Database> {
 if (!globalThis.watercycleDatabase) {
  if(process.env.MIGRATION_DATABASE_URL&&!process.env.DATABASE_URL)throw new DatabaseConfigurationError('DATABASE_URL is required for the application. Maintenance credentials never enable local fallback or substitute for runtime credentials.');
  let options:Parameters<typeof createDatabase>[0];
  if(hosted(process.env)||process.env.DATABASE_URL){const config=managedConfiguration(process.env);options={url:config.url,binding:config.binding,bootstrapAdmin:false};}
  else {
   if(process.env.NODE_ENV==='production'&&process.env.LOCAL_DATABASE!=='true')throw new Error('DATABASE_URL is required for production. No local database was opened.');
   options={directory:process.env.LOCAL_DATABASE_PATH};
  }
  globalThis.watercycleDatabase=createDatabase(options).catch(error=>{globalThis.watercycleDatabase=undefined;throw error;});
 }
 return globalThis.watercycleDatabase;
}
