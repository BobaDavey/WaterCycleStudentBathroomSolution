import { access } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { loadDevelopmentEnvironment } from './development-environment.mjs';
import { assertDemoSeedAllowed } from '../src/lib/database-policy';
import { lockLocalDatabase } from '../src/lib/local-database-lock';
import { latestMigrationVersion } from '../src/lib/migrations';
import { developmentAdminSecret } from '../src/lib/development-admin';
import { DEVELOPMENT_ADMIN_USERNAME } from '../src/lib/bootstrap-admin';
import { verifyPassword } from '../src/lib/auth';

async function main(){
 loadDevelopmentEnvironment();assertDemoSeedAllowed(process.env);
 if(process.env.DEMO_MODE!=='true'||process.env.WATERCYCLE_ENVIRONMENT!=='development')throw new Error('Development configuration missing. Run npm run dev:setup.');
 const directory=path.resolve(process.env.LOCAL_DATABASE_PATH||'.local/data');
 try{await access(path.join(directory,'PG_VERSION'));}catch{throw new Error('Demo database not initialized. Run npm run dev:setup.');}
 const release=await lockLocalDatabase(directory);
 const db=new PGlite(directory);
 try{
  await db.query('BEGIN READ ONLY');
  const {rows:[ledger]}=await db.query<{ledger:string|null}>("SELECT to_regclass('public.watercycle_migrations')::text AS ledger");
  if(!ledger.ledger)throw new Error('Database migrations missing. Stop the server and run npm run dev:setup.');
  const {rows:versions}=await db.query<{version:number}>('SELECT version FROM watercycle_migrations ORDER BY version');
  if(versions.length!==latestMigrationVersion||versions.some((row,i)=>row.version!==i+1))throw new Error('Database migrations incomplete or incompatible. Preserve the database and review the version before running dev:setup.');
  const {rows:bindings}=await db.query('SELECT environment FROM watercycle_database_identity');
  if(bindings.length)throw new Error('Managed database identity detected. Development diagnostics refused.');
  for(const [username,role] of [['teachertest','teacher'],['teststudent','student']]){
   const {rows:[account]}=await db.query<Record<string,unknown>>('SELECT * FROM users WHERE username=$1 AND role=$2',[username,role]);
   if(!account)throw new Error(`Demo account ${username} not initialized. Run npm run dev:setup.`);
   if(!await verifyPassword('1234567890',account.password_hash as string|null))throw new Error(`The local ${username} password has changed. Setup preserves it; use the changed password or choose a new LOCAL_DATABASE_PATH for a fresh demo.`);
   if(!account.enabled||role==='student'&&account.account_status!=='active')throw new Error(`Local ${username} is ${role==='student'&&account.account_status==='pending'?'pending teacher approval':'deactivated'}. Sign in as its teacher to approve/reactivate; setup preserves status changes.`);
  }
  const {rows:[enrollment]}=await db.query<{n:number}>(`SELECT COUNT(*)::int AS n FROM users s JOIN enrollments e ON e.student_id=s.id AND e.active=TRUE JOIN classrooms c ON c.id=e.classroom_id AND c.id=s.classroom_id JOIN users t ON t.id=c.teacher_id WHERE s.username='teststudent' AND t.username='teachertest' AND t.enabled=TRUE AND c.archived=FALSE`);
  if(enrollment.n!==1)throw new Error('Demo enrollment or class changed. Review Class Roster as teachertest; setup never undoes transfers or removals.');
  console.log('PASS: isolated local database, current migrations, both demo passwords, Active student/teacher, and correct class enrollment.');
  const {rows:[admin]}=await db.query<Record<string,unknown>>("SELECT * FROM users WHERE role='admin'");
  const secret=developmentAdminSecret(process.env);
  if(!admin)throw new Error('Developer account not initialized. Configure the private Codespaces secret DEV_ADMIN_INITIAL_PASSWORD (or ADMIN_INITIAL_PASSWORD), restart the Codespace and run npm run dev. Demo student and teacher accounts are ready.');
  if(admin.username!==DEVELOPMENT_ADMIN_USERNAME)throw new Error('Existing local administrator has a legacy username and was preserved. Use a new LOCAL_DATABASE_PATH for the required fresh Developer account.');
  if(!admin.enabled)throw new Error('Local Developer account is not active. Preserve the database and contact its owner.');
  if(secret){
   if(!await verifyPassword(secret,admin.password_hash as string|null))throw new Error('Developer password does not match the configured private secret. Existing passwords are never reset. Use the current password, correct the secret, or choose a new LOCAL_DATABASE_PATH for a fresh demo.');
   console.log('PASS: exactly one Active Developer account and successful private-secret password verification.');
  }else console.log('WARN: Developer account exists, but no private secret is available for password verification. No password was inferred or reset.');
  await db.query('ROLLBACK');
  console.log('PASS: development checks complete. No records changed. Run npm run dev and open port 3000.');
 }finally{try{await db.close();}finally{await release();}}
}
main().catch(error=>{console.error(error instanceof Error&&['Error','DatabaseConfigurationError'].includes(error.name)?error.message:'Development database unavailable. Stop other servers, check local configuration and preserve the data directory. See README.md.');process.exitCode=1;});
