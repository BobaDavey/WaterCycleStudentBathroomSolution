import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from '@playwright/test';

const root=await mkdtemp(path.join(tmpdir(),'watercycle-clean-container-'));
const name=`watercycle-clean-login-${randomUUID()}`;
const password=process.env.WATERCYCLE_FRESH_ADMIN_PASSWORD||randomBytes(24).toString('base64url');
const safe=text=>String(text).split(password).join('[private secret]');
let created=false,browser;
async function command(binary,args,success=true){
 const child=spawn(binary,args,{stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
 const [code]=await once(child,'exit');
 if(success)assert.equal(code,0,safe(`${binary} failed: ${output}`));else assert.notEqual(code,0);
 return output;
}
const run=(args,success=true)=>command('docker',['exec','-w','/app',name,...args],success);
const fingerprint=async()=> (await run(['node','--import','tsx','tests/fresh-development-fingerprint.ts','--require-admin'])).trim();
async function start(){
 await run(['node','-e',`const {spawn}=require('node:child_process'),fs=require('node:fs');const log=fs.openSync('/tmp/watercycle-server.log','w');const child=spawn('npm',['run','dev'],{detached:true,stdio:['ignore',log,log]});fs.writeFileSync('/tmp/watercycle-server.pid',String(child.pid));child.unref();`]);
 for(let i=0;i<240;i++){
  try{if((await fetch(origin+'/api/health')).ok)return;}catch{}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw new Error('Clean container did not become ready: '+safe(await run(['cat','/tmp/watercycle-server.log'])));
}
async function stop(){
 await run(['node','-e',`try{process.kill(-Number(require('node:fs').readFileSync('/tmp/watercycle-server.pid','utf8')),'SIGTERM');}catch{}`]);
 for(let i=0;i<200;i++){
  const output=await run(['node','-e',`const fs=require('node:fs');try{const owner=JSON.parse(fs.readFileSync('/app/.local/data.watercycle.lock','utf8'));const stat=fs.readFileSync('/proc/'+owner.pid+'/stat','utf8');console.log(!['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]));}catch{console.log(false);}`]);
  if(output.trim()==='false')return;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw new Error('Clean container server did not release its local database.');
}
let origin;
try{
 const checkout=path.join(root,'checkout');
 await command('git',['clone','--no-hardlinks',process.cwd(),checkout]);
 for(const file of ['.local','.env.local','node_modules','.next'])await assert.rejects(()=>access(path.join(checkout,file)));
 const config=JSON.parse(await readFile(path.join(checkout,'.devcontainer/devcontainer.json'),'utf8'));
 await command('git',['-C',checkout,'archive','--format=tar','--output='+path.join(root,'source.tar'),'HEAD']);
 // The private value goes only into an ephemeral mode-0600 Docker env file.
 const environment={...config.containerEnv,NODE_OPTIONS:'--import=/app/tests/school-day-clock.mjs',WATERCYCLE_TEST_CLOCK_OFFSET_MS:String(Date.parse('2026-07-06T12:30:00Z')-Date.now()),CODESPACES:'true',NEXT_TELEMETRY_DISABLED:'1',ADMIN_INITIAL_PASSWORD:password};
 const ca=process.env.WATERCYCLE_FRESH_CA_FILE||process.env.NODE_EXTRA_CA_CERTS;
 if(ca)environment.NODE_EXTRA_CA_CERTS='/tmp/fixture-ca.crt';
 await writeFile(path.join(root,'container.env'),Object.entries(environment).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600});
 await command('docker',['create','--name',name,'--env-file',path.join(root,'container.env'),'-p','127.0.0.1::3000','-w','/app',process.env.WATERCYCLE_FRESH_IMAGE||'node:24-bookworm-slim','sh','-c','mkdir -p /app && tar -xf /tmp/source.tar -C /app && exec tail -f /dev/null']);created=true;
 await command('docker',['cp',path.join(root,'source.tar'),name+':/tmp/source.tar']);
 if(ca)await command('docker',['cp',ca,name+':/tmp/fixture-ca.crt']);
 await command('docker',['start',name]);
 await run(['sh','-c',config.postCreateCommand]);
 assert.match(await run(['npm','run','dev:check']),/successful private-secret password verification/);
 const pristine=await fingerprint();
 await run(['sh','-c',config.postStartCommand]);assert.equal(await fingerprint(),pristine);
 const port=(await command('docker',['port',name,'3000/tcp'])).trim().split(':').at(-1);
 origin=`http://127.0.0.1:${port}`;
 await start();
 const headers={Origin:origin,'Content-Type':'application/json'};
 const api=async(context,route,data,method=data?'POST':'GET')=>context.request.fetch(origin+'/api/'+route,{method,headers,...(data?{data}:{})});
 const executablePath=process.env.CHROMIUM_PATH||await access('/usr/bin/chromium').then(()=>'/usr/bin/chromium',()=>undefined);
 browser=await chromium.launch({executablePath,args:['--no-sandbox']});
 // No traces, screenshots, videos, storage-state files or credential request logs.
 for(let restart=0;restart<2;restart++){
  const teacherContext=await browser.newContext(),studentContext=await browser.newContext(),adminContext=await browser.newContext();
  try{
   for(const [context,username,secret,role] of [[teacherContext,'teachertest','1234567890','teacher'],[studentContext,'teststudent','1234567890','student'],[adminContext,'davidanzezhang',password,'admin']]){
    const page=await context.newPage();await page.goto(origin+(role==='admin'?'/admin/login':'/'));
    if(role!=='admin')await page.getByRole('button',{name:role==='teacher'?'I’m a teacher':'I’m a student',exact:true}).click();
    const field=page.getByLabel(role==='admin'?'Developer username':'Username',{exact:true});
    assert.equal(await field.inputValue(),'');assert.equal(await page.getByLabel('Password',{exact:true}).inputValue(),'');
    await field.fill(username);await page.getByLabel('Password',{exact:true}).fill(secret);
    await page.getByRole('button',{name:role==='admin'?'Developer Sign In':'Sign in',exact:true}).click();
    if(role==='admin')await page.waitForURL(/\/admin\/dashboard$/);
    await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();
   }
   const studentState=await(await api(studentContext,'student/state')).json();
   const teacherState=await(await api(teacherContext,'teacher/state?classroomId='+studentState.classroom.id)).json();
   assert.equal(studentState.user.accountStatus,'active');assert.deepEqual(teacherState.classes.map(c=>[c.code,c.name,c.timeZone,c.startTime,c.endTime,c.scheduleDays]).sort((a,b)=>a[0].localeCompare(b[0])),[['DEMO1','Demo Biology Morning','America/New_York','07:00','13:00',[1,2,3,4,5]],['DEMO2','Demo Chemistry Afternoon','America/New_York','13:00','18:00',[1,2,3,4,5]]]);assert.ok(teacherState.classes.every(c=>c.teacherId===teacherState.user.id));assert.deepEqual(studentState.enrollments.map(e=>e.classroom.code).sort(),['DEMO1','DEMO2']);assert.ok(studentState.enrollments.every(e=>e.status==='approved'));
   assert.equal(teacherState.classroom.id,studentState.classroom.id);assert.ok(teacherState.students.some(s=>s.id===studentState.user.id&&s.accountStatus==='active'));
   const teacher=teacherContext.pages()[0];await teacher.getByRole('button',{name:'Class Roster',exact:true}).click();await teacher.getByRole('article').filter({hasText:studentState.classroom.code}).getByRole('button',{name:'View Class',exact:true}).click();
   await teacher.getByRole('row').filter({hasText:'teststudent'}).waitFor();
   assert.equal((await api(teacherContext,'admin/state')).status(),403);assert.equal((await api(studentContext,'admin/state')).status(),403);
   const adminState=await(await api(adminContext,'admin/state')).json();assert.equal(adminState.user.username,'davidanzezhang');
   assert.equal((await api(adminContext,'admin/reports')).status(),200);
   let quiz=await(await api(studentContext,'student/quiz',{purpose:'water'})).json();
   for(let answer=0;answer<2;answer++){
    const key=teacherState.questions.find(q=>q.id===quiz.question.id);assert.ok(key);
    const response=await api(studentContext,'student/quiz/answer',{quizId:quiz.id,questionId:quiz.question.id,questionToken:quiz.questionToken,answer:key.correctIndex});assert.equal(response.status(),200);
    const result=await response.json();if(answer===0)quiz=result.quiz;else{assert.equal(result.passed,true);assert.equal(result.visit.status,'out');}
   }
   assert.equal((await api(studentContext,'student/return',{})).status(),200);
   assert.ok((await(await api(studentContext,'student/state')).json()).recentVisits[0].returnedAt);
  }finally{await teacherContext.close();await studentContext.close();await adminContext.close();}
  await stop();const before=await fingerprint();await run(['sh','-c',config.postStartCommand]);assert.equal(await fingerprint(),before,'every saved record survives repeated initialization');
  if(restart===0)await start();
 }
 assert.match(await run(['npm','run','dev:check']),/successful private-secret password verification/);
 console.log('PASS: fresh Git clone inside a clean Node 24 Debian container; actual post-create/post-start commands; all three blank-form browser logins with the supplied private secret; teacher roster, Active enrollment, break questions/departure/return, Developer management APIs, RBAC, single administrator and unchanged records through restart/reinitialization. This was a container simulation, not a GitHub Codespace.');
}catch(error){throw new Error(safe(error instanceof Error?error.message:'Clean container verification failed.'));}
finally{
 await browser?.close();
 if(created)await command('docker',['rm','-f','-v',name]);
 await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
