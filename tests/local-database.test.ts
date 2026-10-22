import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { createDatabase } from '../src/lib/db';
import { lockLocalDatabase } from '../src/lib/local-database-lock';

test('persistent local database refuses a second opener, saves data, and releases its lock on close',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'watercycle-lock-'));
 const directory=path.join(root,'data');
 try {
  const first=await createDatabase({directory,bootstrapAdmin:false});
  await first.query("INSERT INTO users(id,role,first_name,last_name,username,classroom_id) VALUES('lock-teacher','teacher','Lock','Teacher','lockteacher',NULL)");
  await first.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('test','lock-teacher','Persistence test','01234')");
  await assert.rejects(createDatabase({directory,bootstrapAdmin:false}),/already open in another process/);
  const child=spawnSync(process.execPath,['--import','tsx','-e',`const {createDatabase}=require(${JSON.stringify(path.resolve('src/lib/db.ts'))});createDatabase({directory:${JSON.stringify(directory)},bootstrapAdmin:false}).then(async db=>{await db.close();process.exitCode=0}).catch(error=>{console.error(error.message);process.exitCode=7});`],{encoding:'utf8'});
  assert.equal(child.status,7,child.stderr);
  assert.match(child.stderr,/already open in another process/);
  await first.close();
  await assert.rejects(access(`${directory}.watercycle.lock`));
  const reopened=await createDatabase({directory,bootstrapAdmin:false});
  assert.equal((await reopened.query('SELECT name FROM classrooms')).rows[0].name,'Persistence test');
  await reopened.close();
 } finally {await rm(root,{recursive:true,force:true});}
});
test('reclaims a valid lock left by a dead process or restored snapshot',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'watercycle-stale-'));
 const directory=path.join(root,'data');
 try {
  await writeFile(`${directory}.watercycle.lock`,JSON.stringify({pid:99999999,token:'dead-owner',boot:null,start:null}));
  const db=await createDatabase({directory,bootstrapAdmin:false});
  assert.equal((await db.query('SELECT 1 AS n')).rows[0].n,1);
  await db.close();
  await assert.rejects(access(`${directory}.watercycle.lock`));
 } finally {await rm(root,{recursive:true,force:true});}
});

test('reclaims a terminated Linux owner even while its parent has not reaped it', {skip: process.platform !== 'linux', timeout: 10000}, async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'watercycle-zombie-'));
 const directory=path.join(root,'data');
 const parent=spawn(process.execPath,['-e',`const child=require('node:child_process').spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});process.stdout.write(String(child.pid)+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,8000);`],{stdio:['ignore','pipe','pipe']});
 try {
  const [data]=await once(parent.stdout,'data');
  const pid=Number(String(data).trim());
  let fields:string[]=[];
  for(let attempt=0;attempt<100;attempt++) {
   const stat=await readFile(`/proc/${pid}/stat`,'utf8');
   fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
   if(fields[0]==='Z') break;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(fields[0],'Z','fixture must be a terminated, unreaped process');
  const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
  await writeFile(`${directory}.watercycle.lock`,JSON.stringify({pid,token:'terminated-owner',boot,start:fields[19]}));
  const release=await lockLocalDatabase(directory);
  await release();
  await assert.rejects(access(`${directory}.watercycle.lock`));
 } finally {
  const exited=once(parent,'exit');
  parent.kill('SIGKILL');
  await exited;
  await rm(root,{recursive:true,force:true});
 }
});
