import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createDatabase } from '../src/lib/db';

test('persistent local database refuses a second opener, saves data, and releases its lock on close',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'watercycle-lock-'));
 const directory=path.join(root,'data');
 try {
  const first=await createDatabase({directory});
  await first.query("INSERT INTO classrooms(id,name,code) VALUES('test','Persistence test','LOCK123')");
  await assert.rejects(createDatabase({directory}),/already open in another process/);
  const child=spawnSync(process.execPath,['--import','tsx','-e',`const {createDatabase}=require(${JSON.stringify(path.resolve('src/lib/db.ts'))});createDatabase({directory:${JSON.stringify(directory)}}).then(async db=>{await db.close();process.exitCode=0}).catch(error=>{console.error(error.message);process.exitCode=7});`],{encoding:'utf8'});
  assert.equal(child.status,7,child.stderr);
  assert.match(child.stderr,/already open in another process/);
  await first.close();
  await assert.rejects(access(`${directory}.watercycle.lock`));
  const reopened=await createDatabase({directory});
  assert.equal((await reopened.query('SELECT name FROM classrooms')).rows[0].name,'Persistence test');
  await reopened.close();
 } finally {await rm(root,{recursive:true,force:true});}
});
test('reclaims a valid lock left by a dead process or restored snapshot',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'watercycle-stale-'));
 const directory=path.join(root,'data');
 try {
  await writeFile(`${directory}.watercycle.lock`,JSON.stringify({pid:99999999,token:'dead-owner',boot:null,start:null}));
  const db=await createDatabase({directory});
  assert.equal((await db.query('SELECT 1 AS n')).rows[0].n,1);
  await db.close();
  await assert.rejects(access(`${directory}.watercycle.lock`));
 } finally {await rm(root,{recursive:true,force:true});}
});
