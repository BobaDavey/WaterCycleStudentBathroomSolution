import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';

// Exercise committed source in a separate clone with no shared dependencies/data/secrets.
const root=await mkdtemp(path.join(tmpdir(),'watercycle-fresh-codespace-'));
const checkout=path.join(root,'checkout');
const env={...process.env};
for(const key of Object.keys(env))if(/DATABASE|ADMIN|VERCEL|LOCAL_DATABASE|DEMO_MODE|WATERCYCLE|^NEXT_|^NODE_ENV$|^__NEXT/.test(key))delete env[key];
Object.assign(env,{CODESPACES:'true',NEXT_TELEMETRY_DISABLED:'1'});
const password=process.env.WATERCYCLE_FRESH_ADMIN_PASSWORD||randomBytes(24).toString('base64url');
env.ADMIN_INITIAL_PASSWORD=password;
const safe=value=>String(value).split(password).join('[private secret]');
let server;
async function run(command,args,extra={},success=true,cwd=checkout){
 const child=spawn(command,args,{cwd,env:{...env,...extra},stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 const [code]=await once(child,'exit');
 if(success)assert.equal(code,0,safe(`${command} ${args.join(' ')} failed:\n${output}`));else assert.notEqual(code,0,output);
 return output;
}
async function fingerprint(){return (await run(process.execPath,['--import','tsx','tests/fresh-development-fingerprint.ts'])).trim();}
async function stop(){
 if(!server)return;
 const child=server;server=undefined;const closed=once(child,'exit');
 if(child.exitCode===null){try{process.kill(-child.pid,'SIGTERM');}catch{}await closed;}
 for(let i=0;i<200;i++){
  try{
   const owner=JSON.parse(await readFile(path.join(checkout,(env.LOCAL_DATABASE_PATH||'.local/data')+'.watercycle.lock'),'utf8'));
   const stat=await readFile('/proc/'+owner.pid+'/stat','utf8');
   if(['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]))break;
  }catch{break;}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
}
async function start(){
 const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 let logs='';server=spawn('npm',['run','dev','--','--port',String(port)],{cwd:checkout,env,detached:true,stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',chunk=>logs+=chunk);server.stderr.on('data',chunk=>logs+=chunk);
 const origin=`http://127.0.0.1:${port}`;
 for(let i=0;i<240;i++){
  if(server.exitCode!==null)throw new Error(`Fresh preview exited: ${logs}`);
  try{if((await fetch(origin+'/api/health')).ok)return origin;}catch{}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw new Error(`Fresh preview did not become ready: ${logs}`);
}
function client(origin){
 let cookie='';
 return async(route,body,method=body?'POST':'GET')=>{
  const response=await fetch(origin+'/api/'+route,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});
  const next=response.headers.get('set-cookie');if(next)cookie=next.split(';')[0];
  return{status:response.status,body:await response.json()};
 };
}
try{
 await run('git',['clone','--no-hardlinks',process.cwd(),checkout],{},true,root);
 for(const file of ['.env.local','.local/data','node_modules'])await assert.rejects(()=>access(path.join(checkout,file)));
 const container=JSON.parse(await readFile(path.join(checkout,'.devcontainer/devcontainer.json'),'utf8'));
 Object.assign(env,container.containerEnv,{NODE_OPTIONS:'--import='+path.join(checkout,'tests/school-day-clock.mjs'),WATERCYCLE_TEST_CLOCK_OFFSET_MS:String(Date.parse('2026-07-06T12:30:00Z')-Date.now())});
 assert.equal(container.postCreateCommand,'npm install && npm run dev:setup');
 await run('sh',['-c',container.postCreateCommand]);
 assert.match(await run('npm',['run','dev:doctor']),/PASS:/);
 const first=await fingerprint();await run('npm',['run','dev:setup']);assert.equal(await fingerprint(),first,'repeat setup preserves every row');
 let origin=await start();let teacher=client(origin),student=client(origin),anonymous=client(origin);
 assert.equal((await anonymous('auth/me')).body.adminProvisioned,true);
 const admin=client(origin);assert.equal((await admin('auth/login',{username:'davidanzezhang',password,role:'admin'})).status,200);
 assert.equal((await admin('admin/state')).body.user.username,'davidanzezhang');
 assert.equal((await teacher('auth/login',{username:'teachertest',password:'1234567890',role:'teacher'})).status,200);
 assert.equal((await student('auth/login',{username:'teststudent',password:'1234567890',role:'student'})).status,200);
 const studentState=(await student('student/state')).body;const teacherState=(await teacher('teacher/state?classroomId='+studentState.classroom.id)).body;
 assert.equal(studentState.user.accountStatus,'active');assert.deepEqual(teacherState.classes.map(c=>[c.code,c.name,c.timeZone,c.startTime,c.endTime,c.scheduleDays]).sort((a,b)=>a[0].localeCompare(b[0])),[['DEMO1','Demo Biology Morning','America/New_York','07:00','13:00',[1,2,3,4,5]],['DEMO2','Demo Chemistry Afternoon','America/New_York','13:00','18:00',[1,2,3,4,5]]]);assert.ok(teacherState.classes.every(c=>c.teacherId===teacherState.user.id));assert.deepEqual(studentState.enrollments.map(e=>e.classroom.code).sort(),['DEMO1','DEMO2']);assert.ok(studentState.enrollments.every(e=>e.status==='approved'));
 assert.equal(teacherState.classroom.id,studentState.classroom.id);assert.ok(teacherState.students.some(s=>s.username==='teststudent'&&s.accountStatus==='active'));
 assert.equal((await teacher('admin/state')).status,403);assert.equal((await student('admin/state')).status,403);
 assert.equal((await anonymous('admin/state')).status,401);
 assert.equal((await anonymous('auth/login',{username:'teachertest',password:'incorrect',role:'teacher'})).status,401);
 let quiz=(await student('student/quiz',{purpose:'restroom'})).body;
 for(let i=0;i<2;i++){
  const key=teacherState.questions.find(q=>q.id===quiz.question.id);assert.ok(key);
  const answer=await student('student/quiz/answer',{quizId:quiz.id,questionId:quiz.question.id,questionToken:quiz.questionToken,answer:key.correctIndex});
  assert.equal(answer.status,200);if(i===0)quiz=answer.body.quiz;else{assert.equal(answer.body.passed,true);assert.equal(answer.body.visit.status,'out');assert.ok(answer.body.visit.leftAt);}
 }
 assert.equal((await student('student/return',{})).status,200);
 assert.ok((await student('student/state')).body.recentVisits[0].returnedAt);
 const pending=client(origin);
 assert.equal((await pending('auth/signup',{firstName:'Fresh',lastName:'Pending',password:'DevelopmentOnly123!'})).body.user.accountStatus,'active');
 assert.equal((await pending('student/enroll',{classroomCode:'DEMO1'})).status,200);assert.equal((await pending('student/state')).body.enrollments[0].status,'pending');
 assert.equal((await pending('student/quiz',{purpose:'water'})).status,403);
 const changedPassword=randomBytes(24).toString('base64url');
 assert.equal((await teacher('auth/password',{currentPassword:'1234567890',newPassword:changedPassword})).status,200);
 assert.equal((await teacher('teacher/roster/'+studentState.user.id+'?classroomId='+studentState.classroom.id,{accountStatus:'deactivated'},'PATCH')).status,200);
 await stop();
 const preserved=await fingerprint();await run('npm',['run','dev:setup']);assert.equal(await fingerprint(),preserved,'changed password/status/history are never reset');
 assert.match(await run('npm',['run','dev:doctor'],{},false),/password has changed/);

 const withAdmin=await fingerprint();await run('npm',['run','dev:admin'],{DEV_ADMIN_INITIAL_PASSWORD:randomBytes(24).toString('hex')});assert.equal(await fingerprint(),withAdmin);
 for(const extra of [{DATABASE_URL:'postgresql://not-real.invalid/production'},{MIGRATION_DATABASE_URL:'postgresql://not-real.invalid/production'},{VERCEL:'1'},{WATERCYCLE_ENVIRONMENT:'production'},{NODE_ENV:'production'}])await run('npm',['run','dev:setup'],extra,false);
 assert.equal(await fingerprint(),withAdmin,'unsafe setup attempts cannot change data');
 origin=await start();const restartedAdmin=client(origin);teacher=client(origin);student=client(origin);
 assert.equal((await restartedAdmin('auth/login',{username:'davidanzezhang',password,role:'admin'})).status,200);
 assert.equal((await restartedAdmin('admin/state')).body.user.firstName,'Development');
 assert.equal((await teacher('auth/login',{username:'teachertest',password:changedPassword,role:'teacher'})).status,200);
 assert.equal((await student('auth/login',{username:'teststudent',password:'1234567890',role:'student'})).status,200);
 assert.equal((await student('student/state')).body.enrollments.find(e=>e.classroom.id===studentState.classroom.id).status,'deactivated');
 assert.equal((await student('student/quiz',{purpose:'water',classroomId:studentState.classroom.id})).status,403);
 await stop();
 const noSecret={...env,ADMIN_INITIAL_PASSWORD:'',DEV_ADMIN_INITIAL_PASSWORD:'',LOCAL_DATABASE_PATH:'.local/no-secret'};
 await run('npm',['run','dev:setup'],noSecret);
 assert.match(await run('npm',['run','dev:check'],noSecret,false),/Developer account not initialized/);
 // Test the no-secret demo using the same actual npm run dev launch path.
 const previousEnv={...env};Object.assign(env,noSecret);
 origin=await start();teacher=client(origin);student=client(origin);
 assert.equal((await teacher('auth/login',{username:'teachertest',password:'1234567890',role:'teacher'})).status,200);
 assert.equal((await student('auth/login',{username:'teststudent',password:'1234567890',role:'student'})).status,200);
 assert.equal((await client(origin)('auth/me')).body.developmentSetup,'missing-secret');
 await stop();Object.assign(env,previousEnv);
 // A private secret arriving after prebuild must provision automatically on launch.
 env.LOCAL_DATABASE_PATH='.local/no-secret';
 origin=await start();const lateAdmin=client(origin);
 assert.equal((await lateAdmin('auth/login',{username:'davidanzezhang',password,role:'admin'})).status,200);
 await stop();delete env.LOCAL_DATABASE_PATH;
 console.log('PASS: independent fresh clone and npm install; automatic Codespaces setup; exact demo logins, Active enrollment/roster, questions/departure/return, pending approval, automatic private-secret Developer account, RBAC, repeat initialization, preserved password/status/history across restarts, no-secret demos, late secret injection, and production isolation.');
}catch(error){throw new Error(safe(error instanceof Error?error.message:'Fresh development verification failed.'));}
finally{
 await stop();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
