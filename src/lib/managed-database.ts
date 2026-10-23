import { randomUUID } from 'node:crypto';
import type { SQL } from './db';
import type { DatabaseBinding } from './database-policy';
import { DatabaseConfigurationError } from './database-policy';
import { latestMigrationVersion, migrateDatabase, migrations } from './migrations';
export const initializationLock = 874103921;
export interface SchemaStatus { versions:number[]; pending:number[]; initialized:boolean; bound:boolean; }
const fail=(message:string):never=>{throw new DatabaseConfigurationError(message);};
export async function schemaStatus(tx:SQL,binding:DatabaseBinding):Promise<SchemaStatus> {
 const {rows:[tables]}=await tx.query("SELECT to_regclass('public.watercycle_migrations') AS migrations,to_regclass('public.watercycle_database_identity') AS identity");
 const versions=tables.migrations?(await tx.query<{version:number}>('SELECT version FROM public.watercycle_migrations ORDER BY version')).rows.map(row=>Number(row.version)):[];
 if(versions.some((version,index)=>version!==index+1)||versions.some(version=>version>latestMigrationVersion))fail('Database schema history is incompatible with this release. Do not downgrade or edit the migration ledger.');
 const base=['classrooms','users','sessions','questions','quizzes','visits','rate_limits'];
 const expected=[...base,...(versions.includes(1)?['enrollments']:[]),...(versions.includes(4)?['student_status_events','break_corrections','problem_reports','problem_report_events']:[]),...(versions.includes(5)?['watercycle_database_identity','watercycle_migration_runs']:[])];
 const {rows:present}=await tx.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])",[expected]);
 if((versions.length||present.length)&&expected.some(table=>!present.some(row=>row.tablename===table)))fail('Expected database tables are missing. Restore or reconcile the schema; initialization will not recreate missing classroom tables.');
 let bound=false;
 if(tables.identity){
  const {rows}=await tx.query('SELECT environment,database_id FROM public.watercycle_database_identity');
  if(rows.length){if(rows.length!==1||rows[0].environment!==binding.environment||rows[0].database_id!==binding.databaseId)fail('Database identity mismatch. This deployment is connected to a different environment or database. No records were changed.');bound=true;}
 }
 return{versions,pending:migrations.filter(m=>!versions.includes(m.version)).map(m=>m.version),initialized:Boolean(tables.migrations),bound};
}
export async function verifyRuntimeDatabase(tx:SQL,binding:DatabaseBinding,operator=false) {
 const status=await schemaStatus(tx,binding);
 if(status.pending.length||!status.bound)fail('Database setup or migrations are required. Run the reviewed database migration command before deploying; server startup never changes the schema.');
 if(operator)return;
 // The runtime must not own schema objects or have DDL/role-management powers.
 const {rows:[role]}=await tx.query(`SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
 OR has_schema_privilege(current_user,'public','CREATE')
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_has_role(current_user,c.relowner,'USAGE'))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND (has_table_privilege(current_user,c.oid,'TRUNCATE') OR (c.relname<>'sessions' AND has_table_privilege(current_user,c.oid,'DELETE')))) AS unsafe
 FROM pg_roles r WHERE r.rolname=current_user`);
 if(!role||role.unsafe)fail('Use a restricted non-owner runtime database role with data permissions only and no hard-delete or truncate privileges on classroom records. Keep migration/owner credentials outside Vercel.');
}
export async function applyManagedMigrations(tx:SQL,binding:DatabaseBinding,input:{expectedVersion:number;backupReference?:string}) {
 const status=await schemaStatus(tx,binding);
 const current=status.versions.at(-1)??0;
 if(current!==input.expectedVersion)fail('The reviewed schema version changed. Run db:status and review the migration plan again.');
 // A recorded backup/snapshot reference is an operator attestation, not an invented backup.
 if((status.pending.length||!status.bound)&&!input.backupReference?.trim())fail('A verified backup or provider snapshot reference is required before schema changes or environment binding.');
 if(input.backupReference && (input.backupReference.length>500||/[\r\n]|postgres(?:ql)?:\/\/|password=/i.test(input.backupReference)))fail('Use a short single-line backup reference; never include credentials.');
 if(!status.pending.length&&status.bound)return;
 await migrateDatabase(tx,async sql=>{await tx.query(sql);});
 await tx.query('INSERT INTO public.watercycle_database_identity(singleton,environment,database_id) VALUES(TRUE,$1,$2) ON CONFLICT(singleton) DO NOTHING',[binding.environment,binding.databaseId]);
 const after=await schemaStatus(tx,binding);
 await tx.query('INSERT INTO public.watercycle_migration_runs(id,environment,database_id,backup_reference,versions_before,versions_after) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),binding.environment,binding.databaseId,input.backupReference!.trim(),status.versions,after.versions]);
 if(!after.bound||after.pending.length)fail('The database could not be initialized safely. The transaction will roll back.');
}
