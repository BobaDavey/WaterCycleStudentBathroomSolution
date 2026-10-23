import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { cookieName } from '../../src/lib/auth';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDatabase, type Database, type SQL } from '../../src/lib/db';
import { baselineSchema, migrations, latestMigrationVersion } from '../../src/lib/migrations';
import { applyManagedMigrations, schemaStatus } from '../../src/lib/managed-database';
import { bootstrapAdministrator } from '../../src/lib/bootstrap-admin';
import { hashPassword,userFrom } from '../../src/lib/auth';
import { WaterCycle } from '../../src/lib/domain';
import { bootstrapDevelopmentAdministrator } from '../../src/lib/development-admin';
import type { DatabaseBinding } from '../../src/lib/database-policy';
const base=process.env.WATERCYCLE_POSTGRES_TEST_URL!;
const container=process.env.WATERCYCLE_POSTGRES_CONTAINER!;
const root=process.env.WATERCYCLE_POSTGRES_FIXTURE_ROOT!;
// No supplied production connection can be used by this suite.
assert.match(container??'',/^watercycle-persistence-/);assert.equal(new URL(base).hostname,'127.0.0.1');assert.ok(path.basename(root).startsWith('watercycle-postgres-'));
const production:DatabaseBinding={environment:'production',databaseId:randomUUID()};const preview:DatabaseBinding={environment:'preview',databaseId:randomUUID()};
const credentials={admin:randomBytes(24).toString('hex'),temporary:randomBytes(24).toString('hex'),teacher:randomBytes(24).toString('hex'),student:randomBytes(24).toString('hex')};
const rolePassword=randomBytes(24).toString('hex');
const databases=['wc_production','wc_preview','wc_restore','wc_legacy','wc_empty','wc_broken'];
const tables=['classrooms','users','sessions','questions','quizzes','visits','enrollments','rate_limits','student_status_events','break_corrections','problem_reports','problem_report_events','student_username_counters'];
let owner:Pool,saved:Record<string,string>;
function urlFor(name:string,runtime=false){assert.ok(databases.includes(name));const url=new URL(base);url.pathname=`/${name}`;if(runtime){url.username='wc_runtime';url.password=rolePassword;}return url.toString();}
function poolFor(name:string){return new Pool({connectionString:urlFor(name),max:2});}
async function transaction<T>(pool:Pool,fn:(tx:SQL)=>Promise<T>){const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client as SQL);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
function adapter(pool:Pool):Database{return{query:pool.query.bind(pool) as SQL['query'],transaction:fn=>transaction(pool,fn),close:async()=>{}};}
async function snapshot(name:string){const pool=poolFor(name);try{const output:Record<string,unknown[]>={};for(const table of tables){const exists=(await pool.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name;output[table]=exists?(await pool.query(`SELECT to_jsonb(t) AS record FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows:[];}return output;}finally{await pool.end();}}
async function grantRuntime(name:string){const pool=poolFor(name);try{await pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');await pool.query('GRANT USAGE ON SCHEMA public TO wc_runtime');for(const table of tables)await pool.query(`GRANT SELECT,INSERT,UPDATE ON TABLE public.${table} TO wc_runtime`);await pool.query('GRANT DELETE ON public.sessions TO wc_runtime');await pool.query('GRANT SELECT ON public.watercycle_migrations,public.watercycle_database_identity,public.watercycle_migration_runs TO wc_runtime');}finally{await pool.end();}}
async function migrate(name:string,binding:DatabaseBinding,expectedVersion=0,backupReference='verified-isolated-fixture-snapshot'){const db=await createDatabase({url:urlFor(name),binding,bootstrapAdmin:false,migration:{expectedVersion,backupReference}});await db.close();}
async function run(args:string[],extra:Record<string,string|undefined>={},input?:Buffer){const child=spawn(process.execPath,args,{env:{...process.env,...extra} as NodeJS.ProcessEnv,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.stdin.end(input);const code=await new Promise<number|null>(resolve=>{child.once('error',()=>resolve(-1));child.once('exit',resolve);});return{code,stdout,stderr};}
function deploymentEnv(name='wc_production',binding=production){return{DATABASE_URL:urlFor(name,true),WATERCYCLE_ENVIRONMENT:binding.environment,WATERCYCLE_DATABASE_ID:binding.databaseId,VERCEL:'1',VERCEL_ENV:binding.environment,NODE_ENV:'production',LOCAL_DATABASE:'',DEMO_MODE:'',LOCAL_DATABASE_PATH:'',ADMIN_INITIAL_PASSWORD:randomBytes(24).toString('hex'),WATERCYCLE_TEST_CREDENTIALS:JSON.stringify(credentials),WATERCYCLE_TEST_SAVED:JSON.stringify(saved)};}

describe('Real PostgreSQL deployment persistence and recovery',()=>{
 before(async()=>{
  owner=new Pool({connectionString:base,max:2});await owner.query(`CREATE ROLE wc_runtime LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  for(const name of databases)await owner.query(`CREATE DATABASE ${name}`);
  await migrate('wc_production',production);await grantRuntime('wc_production');
  const pool=poolFor('wc_production');try{await bootstrapAdministrator(adapter(pool),credentials.admin);}finally{await pool.end();}
 });
 after(async()=>await owner?.end());
 it('creates real classroom data through one application process and preserves every row through three fresh deployment processes',async()=>{
  const created=await run(['--import','tsx','tests/postgres/deployment-worker.ts','create'],deploymentEnv());assert.equal(created.code,0,created.stderr);saved=JSON.parse(created.stdout.trim());
  const original=await snapshot('wc_production');assert.ok(tables.filter(table=>table!=='rate_limits').every(table=>original[table].length>0));
  for(let deploy=0;deploy<3;deploy++){const result=await run(['--import','tsx','tests/postgres/deployment-worker.ts','verify'],deploymentEnv());assert.equal(result.code,0,result.stderr);assert.deepEqual(await snapshot('wc_production'),original);}
 });
 it('serves existing student and teacher sessions through two production Next.js server restarts',async()=>{
  await stat('.next/BUILD_ID');
  const original=await snapshot('wc_production');let teacherCookie='';let firstSnapshot:Awaited<ReturnType<typeof snapshot>>|undefined;
  for(let deployment=0;deployment<2;deployment++){
   const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const address=listener.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
   const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,...deploymentEnv()} as NodeJS.ProcessEnv,stdio:['ignore','pipe','pipe']});server.stdout.resume();server.stderr.resume();
   const exited=once(server,'exit');
   try{
    const origin=`http://127.0.0.1:${port}`;let healthy=false;
    for(let attempt=0;attempt<150;attempt++){if(server.exitCode!==null)break;try{const response=await fetch(`${origin}/api/health`);if(response.ok){assert.deepEqual(await response.json(),{ok:true});healthy=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}
    assert.equal(healthy,true,'isolated production server must become healthy');
    const studentCookie=`${cookieName}=${saved.session}`;
    const auth=await fetch(`${origin}/api/auth/me`,{headers:{Cookie:studentCookie}});assert.equal(auth.status,200);assert.equal((await auth.json()).user.id,saved.studentId);
    const student=await fetch(`${origin}/api/student/state`,{headers:{Cookie:studentCookie}});assert.equal(student.status,200);assert.equal((await student.json()).activeQuiz.correctCount,1);
    if(!teacherCookie){const login=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{Origin:origin.replace('http:','https:'),'X-Forwarded-Proto':'https','Content-Type':'application/json'},body:JSON.stringify({username:'persistenceteacher',password:credentials.teacher,role:'teacher'})});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie')!,/;\s*Secure/i);teacherCookie=login.headers.get('set-cookie')!.split(';')[0];}
    const teacher=await fetch(`${origin}/api/teacher/state`,{headers:{Cookie:teacherCookie}});assert.equal(teacher.status,200);assert.equal((await teacher.json()).students.length,2);
    const after=await snapshot('wc_production');for(const table of tables.filter(table=>!['sessions','rate_limits'].includes(table)))assert.deepEqual(after[table],original[table]);
    if(firstSnapshot)assert.deepEqual(after,firstSnapshot);else firstSnapshot=after;
   }finally{if(server.exitCode===null)server.kill('SIGTERM');await exited;}
  }
 });
 it('retains administrator password hashes when initialization is repeated with a different secret and when runtime restarts',async()=>{
  const before=await snapshot('wc_production');const pool=poolFor('wc_production');try{assert.equal(await bootstrapAdministrator(adapter(pool),randomBytes(24).toString('hex')),'exists');}finally{await pool.end();}assert.deepEqual(await snapshot('wc_production'),before);
 });
 it('never provisions development accounts into managed production or accepts absent public demos',async()=>{
  const before=await snapshot('wc_production');
  const db=await createDatabase({url:urlFor('wc_production',true),binding:production});
  try{
   await assert.rejects(()=>bootstrapDevelopmentAdministrator(db,randomBytes(24).toString('hex')));
   const app=new WaterCycle(db);
   for(const [username,role] of [['teststudent','student'],['teachertest','teacher']] as const)await assert.rejects(()=>app.login({username,role,password:'1234567890'}),/incorrect/);
  }finally{await db.close();}
  assert.deepEqual(await snapshot('wc_production'),before);
 });
 it('uses a non-owner runtime role that cannot drop, truncate, recreate, or rewrite schema metadata',async()=>{
  const db=await createDatabase({url:urlFor('wc_production',true),binding:production});try{
   for(const query of ['DROP TABLE public.visits','DELETE FROM public.visits','DELETE FROM public.users','DELETE FROM public.problem_reports','TRUNCATE public.users CASCADE','CREATE TABLE public.accidental_reset(id TEXT)',"DELETE FROM public.watercycle_migrations","UPDATE public.watercycle_database_identity SET environment='preview'"]){await assert.rejects(()=>db.query(query),(error:unknown)=>(error as {code:string}).code==='42501');}
  }finally{await db.close();}
  await assert.rejects(()=>createDatabase({url:urlFor('wc_production'),binding:production}),/restricted non-owner/);
 });
 it('refuses an empty or wrong database at startup without creating tables or accounts',async()=>{
  await assert.rejects(()=>createDatabase({url:urlFor('wc_empty'),binding:production}),/setup or migrations/);
  const pool=poolFor('wc_empty');try{assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);}finally{await pool.end();}
  await assert.rejects(()=>createDatabase({url:urlFor('wc_production',true),binding:{...production,databaseId:randomUUID()}}),/identity mismatch/);
 });
 it('rejects preview access to the production database before any write, including migration attempts',async()=>{
  const original=await snapshot('wc_production');
  for(const binding of [preview,{...production,environment:'preview' as const}]){
   await assert.rejects(()=>createDatabase({url:urlFor('wc_production',true),binding}),/identity mismatch/);
   await assert.rejects(()=>createDatabase({url:urlFor('wc_production'),binding,migration:{expectedVersion:latestMigrationVersion,backupReference:'isolated-snapshot'}}),/identity mismatch/);
  }
  assert.deepEqual(await snapshot('wc_production'),original);
  await migrate('wc_preview',preview);await grantRuntime('wc_preview');const db=await createDatabase({url:urlFor('wc_preview',true),binding:preview});try{assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n,0);}finally{await db.close();}
 });
 it('allocates duplicate-name usernames concurrently through the restricted PostgreSQL role and isolates multi-teacher approvals',async()=>{
  const db=await createDatabase({url:urlFor('wc_preview',true),binding:preview});
  try{
   const app=new WaterCycle(db,()=>new Date('2026-07-06T12:30:00Z'));
   const owner=async(name:string)=>userFrom((await db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES($1,'teacher',$2,'Teacher',$2) RETURNING *",[randomUUID(),name])).rows[0]);
   const one=await owner('pgteacherone'),two=await owner('pgteachertwo');
   const room=await app.createClass(one,{name:'First',code:'PG001',startTime:'08:00',endTime:'09:30'}),other=await app.createClass(two,{name:'Other',code:'PG002',startTime:'08:00',endTime:'09:30'});
   const students=await Promise.all(Array.from({length:12},()=>app.signup({firstName:'Alex',lastName:'Best',password:randomBytes(24).toString('hex')})));
   assert.deepEqual(students.map(s=>s.username).sort(),Array.from({length:12},(_,i)=>'alexbest'+String(i+1).padStart(2,'0')));
   const student=students[0];await Promise.all([app.enrollStudent(student,'PG001'),app.enrollStudent(student,'PG002')]);
   await app.updateRoster(one,student.id,{accountStatus:'active'},room.id);
   const state=await app.studentState(student);assert.equal(state.enrollments.find(e=>e.classroom.id===room.id)?.status,'approved');assert.equal(state.enrollments.find(e=>e.classroom.id===other.id)?.status,'pending');
   await assert.rejects(()=>app.updateRoster(one,student.id,{accountStatus:'active'},other.id),/not found/);
   await assert.rejects(()=>app.newQuiz(student,'water',other.id),/approval/);
   const original=await app.newQuiz(student,'water',room.id);await app.cancelQuiz(student,original.id);await app.updateRoster(two,student.id,{accountStatus:'active'},other.id);
   const competing=await Promise.allSettled([app.newQuiz(student,'water',room.id),app.newQuiz(student,'water',other.id)]);assert.equal(competing.filter(result=>result.status==='fulfilled').length,1);assert.equal((await db.query('SELECT id FROM quizzes WHERE student_id=$1 AND used=FALSE',[student.id])).rows.length,1);
  }finally{await db.close();}
 });
 it('requires a backup reference and reviewed version before adopting/migrating an existing schema, preserving original fields',async()=>{
  const pool=poolFor('wc_legacy');try{
   await pool.query(baselineSchema);for(const migration of migrations.filter(m=>m.version<=4)){await pool.query(migration.sql);await pool.query('INSERT INTO watercycle_migrations(version) VALUES($1)',[migration.version]);}
   const hash=await hashPassword(randomBytes(24).toString('hex'));
   await pool.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES('legacy-teacher','teacher','Existing','Teacher','existingteacher',$1)",[hash]);await pool.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('legacy-class','legacy-teacher','Existing biology','00123')");
   await pool.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id,account_status) VALUES('legacy-student','student','Existing','Student','existingstudent',$1,'legacy-class','active')",[hash]);await pool.query("INSERT INTO enrollments(id,student_id,classroom_id) VALUES('legacy-enrollment','legacy-student','legacy-class')");
   await pool.query("INSERT INTO visits(id,classroom_id,student_id,status,left_at,returned_at,purpose) VALUES('legacy-visit','legacy-class','legacy-student','returned',statement_timestamp()-INTERVAL '15 minutes',statement_timestamp(),'water')");
   await pool.query("INSERT INTO quizzes(id,student_id,classroom_id,questions,expires_at,purpose,correct_count,current_index,question_token) VALUES('legacy-quiz','legacy-student','legacy-class','[]',statement_timestamp()+INTERVAL '10 minutes','water',1,0,'preserved-token')");
   await pool.query("INSERT INTO problem_reports(id,teacher_id,request_id,teacher_name,email,description) VALUES('legacy-ticket','legacy-teacher','legacy-request','Existing Teacher','existing@school.test','Preserve this report')");
   const before=await snapshot('wc_legacy');
   await assert.rejects(()=>createDatabase({url:urlFor('wc_legacy'),binding:production,migration:{expectedVersion:4}}),/backup/);
   await assert.rejects(()=>migrate('wc_legacy',production,3),/version changed/);assert.deepEqual(await snapshot('wc_legacy'),before);
   // Inject a failure after DDL, ledger and identity changes; all must roll back.
   await assert.rejects(()=>transaction(pool,tx=>applyManagedMigrations({async query<T>(sql:string,params?:unknown[]){if(sql.startsWith('INSERT INTO public.watercycle_migration_runs'))throw new Error('isolated migration failure');return tx.query<T>(sql,params);}},production,{expectedVersion:4,backupReference:'verified-fixture-backup'})),/isolated migration failure/);
   assert.equal((await schemaStatus(pool as SQL,production)).versions.at(-1),4);assert.deepEqual(await snapshot('wc_legacy'),before);
   const concurrent=await Promise.allSettled([migrate('wc_legacy',production,4),migrate('wc_legacy',production,4)]);assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1);
   const after=await snapshot('wc_legacy');for(const table of tables)for(let i=0;i<before[table].length;i++)for(const [key,value] of Object.entries((before[table][i] as {record:Record<string,unknown>}).record))assert.deepEqual((after[table][i] as {record:Record<string,unknown>}).record[key],value);assert.equal((await schemaStatus(pool as SQL,production)).versions.at(-1),latestMigrationVersion);
   await migrate('wc_legacy',production,latestMigrationVersion,'');assert.deepEqual(await snapshot('wc_legacy'),after);assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM watercycle_migration_runs')).rows[0].n,1);
  }finally{await pool.end();}
 });
 it('refuses to recreate missing application tables when the schema ledger already says they exist',async()=>{
  await migrate('wc_broken',preview);const pool=poolFor('wc_broken');try{await pool.query('DROP TABLE problem_report_events');await assert.rejects(()=>createDatabase({url:urlFor('wc_broken'),binding:preview,migration:{expectedVersion:latestMigrationVersion,backupReference:'fixture-backup'}}),/tables are missing/);assert.equal((await pool.query("SELECT to_regclass('public.problem_report_events') AS table_name")).rows[0].table_name,null);}finally{await pool.end();}
 });
 it('creates a private pg_dump backup, protects existing files, and restores all records into a separate empty database',async()=>{
  const bin=path.join(root,'bin');await mkdir(bin,{mode:0o700});
  const wrapper=`#!/usr/bin/env node\nconst {spawn}=require('node:child_process');const child=spawn('docker',['exec','-i','-e','PGUSER','-e','PGPASSWORD','-e','PGDATABASE','-e','PGHOST=127.0.0.1','-e','PGPORT=5432','-e','PGSSLMODE=verify-full','-e','PGSSLROOTCERT=/tmp/server.crt',${JSON.stringify(container)},'pg_dump',...process.argv.slice(2)],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));\n`;
  await writeFile(path.join(bin,'pg_dump'),wrapper,{mode:0o700});
  const backup=path.join(root,'private.dump');const env={...deploymentEnv(),DATABASE_URL:'',MIGRATION_DATABASE_URL:urlFor('wc_production'),PATH:`${bin}:${process.env.PATH}`};
  const result=await run(['--import','tsx','scripts/backup-database.ts','--output',backup],env);assert.equal(result.code,0,result.stderr);assert.equal((await stat(backup)).mode&0o777,0o600);const data=await readFile(backup);assert.ok(data.length>1000);assert.ok(result.stdout.includes(createHash('sha256').update(data).digest('hex')));
  assert.notEqual((await run(['--import','tsx','scripts/backup-database.ts','--output',backup],env)).code,0);assert.deepEqual(await readFile(backup),data);
  const restore=spawn('docker',['exec','-i',container,'pg_restore','--username=fixture_owner','--dbname=wc_restore','--no-owner','--no-acl'],{stdio:['pipe','ignore','pipe']});restore.stderr.resume();restore.stdin.end(data);assert.equal(await new Promise(resolve=>restore.once('exit',resolve)),0);
  assert.deepEqual(await snapshot('wc_restore'),await snapshot('wc_production'));await grantRuntime('wc_restore');const verify=await run(['--import','tsx','tests/postgres/deployment-worker.ts','verify'],deploymentEnv('wc_restore'));assert.equal(verify.code,0,verify.stderr);
 });
});
