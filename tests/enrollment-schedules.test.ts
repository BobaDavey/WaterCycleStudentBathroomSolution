import { after,before,describe,it,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createDatabase,type Database } from '../src/lib/db';
import { WaterCycle,classCreateSchema,signupSchema } from '../src/lib/domain';
import { AppError,userFrom,hashPassword } from '../src/lib/auth';
import { isClassInSession } from '../src/lib/class-schedule';
import { baselineSchema,migrations,migrateDatabase } from '../src/lib/migrations';
import type { User,Classroom,Quiz,Question } from '../src/lib/contracts';
const password='DevelopmentStudent2026!';
const failure=(status:number)=>(error:unknown)=>error instanceof AppError&&error.status===status;
const schedule={startTime:'08:00',endTime:'09:30',timeZone:'America/New_York',scheduleDays:[1,2,3,4,5]};
test('school schedules use class-local weekdays, DST, inclusive start and exclusive end',()=>{
 for(const [instant,expected] of [['2026-01-05T12:59:59Z',false],['2026-01-05T13:00:00Z',true],['2026-01-05T14:29:59Z',true],['2026-01-05T14:30:00Z',false],['2026-07-06T12:00:00Z',true],['2026-07-04T12:00:00Z',false]] as const)assert.equal(isClassInSession(schedule,new Date(instant)),expected,instant);
 for(const zone of ['Pacific/Honolulu','America/Phoenix'])for(const month of ['01','07']){
  const utcHour=zone==='Pacific/Honolulu'?'18':'15';
  assert.equal(isClassInSession({...schedule,timeZone:zone},new Date(`2026-${month}-${month==='01'?'05':'06'}T${utcHour}:00:00Z`)),true);
 }
 assert.equal(isClassInSession({...schedule,startTime:null},new Date('2026-07-06T12:00:00Z')),false);
});
test('registration omits usernames/codes and public class creation requires valid non-overnight times',()=>{
 assert.deepEqual(signupSchema.parse({firstName:'Alex',lastName:'Best',password,username:'chosen',classroomCode:'DEMO1'}),{firstName:'Alex',lastName:'Best',password});
 for(const times of [{},{startTime:'08:00',endTime:'08:00'},{startTime:'22:00',endTime:'01:00'},{startTime:'25:00',endTime:'26:00'}])assert.equal(classCreateSchema.safeParse({name:'Biology',code:'BIO01',...times}).success,false);
});
describe('permanent student accounts, independent enrollments, and scheduled breaks',()=>{
 let db:Database,app:WaterCycle,teacher:User,other:User,one:Classroom,two:Classroom,foreign:Classroom;
 let instant=new Date('2026-07-06T12:30:00Z');
 before(async()=>{
  db=await createDatabase({directory:'memory://'});app=new WaterCycle(db,()=>instant);
  async function owner(username:string){return userFrom((await db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES($1,'teacher',$2,'Teacher',$2) RETURNING *",[randomUUID(),username])).rows[0]);}
  teacher=await owner('ownteacher');other=await owner('otherteacher');
  one=await app.createClass(teacher,{name:'Morning biology',code:'SCH01',startTime:'08:00',endTime:'09:30'});
  two=await app.createClass(teacher,{name:'Overlapping science',code:'SCH02',startTime:'08:00',endTime:'10:00'});
  foreign=await app.createClass(other,{name:'Other teacher science',code:'SCH03',startTime:'08:00',endTime:'09:30'});
 });
 after(async()=>await db.close());
 async function student(firstName:string){return app.signup({firstName,lastName:'Best',password});}
 async function join(user:User,room:Classroom,owner:User=teacher){await app.enrollStudent(user,room.code!);await app.updateRoster(owner,user.id,{accountStatus:'active'},room.id);}
 async function answer(user:User,quiz:Quiz){const row=(await db.query<{questions:Question[]}>('SELECT questions FROM quizzes WHERE id=$1',[quiz.id])).rows[0];return app.answerQuiz(user,{quizId:quiz.id,questionId:quiz.question.id,questionToken:quiz.questionToken,answer:row.questions.find(q=>q.id===quiz.question.id)!.correctIndex});}
 async function request(user:User,room:Classroom){const first=await answer(user,await app.newQuiz(user,'restroom',room.id));return (await answer(user,first.quiz!)).visit!;}
 it('allocates globally unique sequential usernames atomically, including duplicate and normalized names',async()=>{
  const a=await student('Alex'),b=await student('Alex'),c=await student('Alex');assert.deepEqual([a.username,b.username,c.username],['alexbest01','alexbest02','alexbest03']);
  const concurrent=await Promise.all(Array.from({length:8},()=>student('Alex')));assert.equal(new Set(concurrent.map(s=>s.username)).size,8);
  assert.deepEqual(concurrent.map(s=>Number(s.username.slice(8))).sort((a,b)=>a-b),[4,5,6,7,8,9,10,11]);
  const normalized=await app.signup({firstName:'Á lex',lastName:'Be-st!',password});assert.equal(normalized.username,'alexbest12');
  await db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES($1,'teacher','Reserved','Name','reservedbest01')",[randomUUID()]);
  assert.equal((await student('Reserved')).username,'reservedbest02');
  await db.query("UPDATE users SET username='renamedteacher' WHERE username='reservedbest01'");assert.equal((await student('Reserved')).username,'reservedbest03');
  await db.query("INSERT INTO student_username_counters(base,next_number) VALUES('manybest',100)");assert.equal((await student('Many')).username,'manybest100');
  assert.equal((await app.login({username:a.username,password,role:'student'})).id,a.id);
  const long=await app.signup({firstName:'A'.repeat(50),lastName:'B'.repeat(50),password});assert.equal(long.username,'a'.repeat(50)+'b'.repeat(50)+'01');assert.equal((await app.login({username:long.username,password,role:'student'})).id,long.id);
  const state=await app.studentState(a);assert.equal(state.enrollments.length,0);assert.equal(state.classroom,null);assert.equal(state.canRequestPass,false);
 });
 it('joins multiple teachers with separate Pending statuses, scoped approval and private history',async()=>{
  const learner=await student('Independent');await app.enrollStudent(learner,'sch01');await app.enrollStudent(learner,'SCH03');
  const preview=await app.previewEnrollment(learner,'sch03');assert.equal(preview.teacherName,'otherteacher Teacher');
  assert.deepEqual((await app.studentState(learner)).enrollments.map(e=>e.status),['pending','pending']);
  await assert.rejects(()=>app.enrollStudent(learner,'SCH01'),failure(409));await assert.rejects(()=>app.enrollStudent(learner,'BAD'),failure(400));
  await assert.rejects(()=>app.updateRoster(other,learner.id,{accountStatus:'active'},one.id),failure(404));
  await app.updateRoster(teacher,learner.id,{accountStatus:'active'},one.id);
  const state=await app.studentState(learner);assert.equal(state.enrollments.find(e=>e.classroom.id===one.id)?.status,'approved');assert.equal(state.enrollments.find(e=>e.classroom.id===foreign.id)?.status,'pending');
  await assert.rejects(()=>app.newQuiz(learner,'water',foreign.id),failure(403));
  // A retained pre-migration account approval must not leak into another class.
  await db.query('UPDATE users SET approved_at=statement_timestamp(),approved_by=$2 WHERE id=$1',[learner.id,teacher.id]);assert.equal((await app.rosterDetail(other,learner.id,foreign.id)).student.approvedAt,null);
  const visit=await request(learner,one);await app.studentAction(learner,'return');
  assert.equal((await app.rosterDetail(other,learner.id,foreign.id)).visits.length,0);await assert.rejects(()=>app.rosterDetail(other,learner.id,one.id),failure(404));
  assert.equal((await app.rosterDetail(teacher,learner.id,one.id)).visits[0].id,visit.id);
  await app.updateRoster(other,learner.id,{accountStatus:'active'},foreign.id);assert.equal((await app.studentState(learner)).eligibleClassroomIds.length,2);
  await app.updateRoster(teacher,learner.id,{accountStatus:'deactivated'},one.id);assert.equal((await app.studentState(learner)).enrollments.find(e=>e.classroom.id===foreign.id)?.eligible,true);
  await app.updateRoster(teacher,learner.id,{accountStatus:'active'},one.id);
 });
 it('rechecks the confirmed classroom when a code changes before joining',async()=>{
  const learner=await student('Confirmed');const room=await app.createClass(teacher,{name:'Confirmed class',code:'CONF1',startTime:'08:00',endTime:'09:30'});
  const preview=await app.previewEnrollment(learner,'CONF1');await app.updateClass(teacher,room.id,{code:'CONF2'});
  await app.createClass(other,{name:'Reused code class',code:'CONF1',startTime:'08:00',endTime:'09:30'});
  await assert.rejects(()=>app.enrollStudent(learner,'CONF1',preview.id),failure(409));assert.equal((await app.studentState(learner)).enrollments.length,0);
 });
 it('requires an overlapping-class selection and prevents cross-class quizzes and active passes',async()=>{
  const learner=await student('Overlapping');await join(learner,one);await join(learner,two);
  await assert.rejects(()=>app.newQuiz(learner,'water'),failure(409));
  const quiz=await app.newQuiz(learner,'water',one.id);await assert.rejects(()=>app.newQuiz(learner,'water',two.id),failure(409));await app.cancelQuiz(learner,quiz.id);
  const results=await Promise.allSettled([request(learner,one),request(learner,two)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await db.query("SELECT id FROM visits WHERE student_id=$1 AND status IN ('out','ready','waiting')",[learner.id])).rows.length,1);
  await app.studentAction(learner,'return');
 });
 it('preserves active timers, cancels queued/reserved turns at closing, and rejects both new quizzes and late final answers',async()=>{
  instant=new Date('2026-07-06T12:30:00Z');const learners=await Promise.all(['OutsideA','OutsideB','WaitingA','WaitingB','InQuiz'].map(student));for(const learner of learners)await join(learner,one);
  const first=await request(learners[0],one);await request(learners[1],one);await request(learners[2],one);await request(learners[3],one);
  await app.studentAction(learners[1],'return');assert.equal((await app.studentState(learners[2])).currentVisit?.status,'ready');
  const quiz=await app.newQuiz(learners[4],'water',one.id);const firstAnswer=await answer(learners[4],quiz);
  instant=new Date('2026-07-06T13:30:00Z'); // 09:30 Eastern: exclusive end
  await assert.rejects(()=>answer(learners[4],firstAnswer.quiz!),failure(409));
  await assert.rejects(()=>app.newQuiz(learners[4],'water',one.id),failure(409));
  const queued=await app.studentState(learners[2]);assert.equal(queued.currentVisit,null);assert.match(queued.recentVisits[0].cancellationReason!,/session ended/);
  assert.equal((await app.studentState(learners[3])).currentVisit,null);
  const active=(await app.studentState(learners[0])).currentVisit!;assert.equal(active.id,first.id);assert.equal(active.leftAt,first.leftAt);
  await app.studentAction(learners[0],'return');assert.equal((await app.studentState(learners[0])).recentVisits[0].status,'returned');
  instant=new Date('2026-07-06T12:30:00Z');
 });
 it('never invents a legacy schedule and permits return corrections after a session ends',async()=>{
  const id=randomUUID();await db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES($1,$2,'Legacy unscheduled','OLD01')",[id,teacher.id]);await app.seedQuestions(db,id);const legacy=(await app.teacherState(teacher,id)).classroom!;const learner=await student('Legacy');await join(learner,legacy);
  assert.equal((await app.studentState(learner)).canRequestPass,false);await assert.rejects(()=>app.newQuiz(learner,'restroom',legacy.id),failure(409));
  await app.updateClass(teacher,legacy.id,{startTime:'08:00',endTime:'09:30'});const visit=await request(learner,legacy);await app.studentAction(learner,'return');
  instant=new Date('2026-07-06T20:00:00Z');await app.reopenVisit(teacher,visit.id);assert.equal((await app.studentState(learner)).currentVisit?.leftAt,visit.leftAt);await app.studentAction(learner,'return');instant=new Date('2026-07-06T12:30:00Z');
 });
 it('does not let teachers clear account-wide restrictions or mutate another enrollment while removing/transferring',async()=>{
  const learner=await student('Restriction');await join(learner,one);await join(learner,foreign,other);
  await db.query('UPDATE users SET account_suspended=TRUE WHERE id=$1',[learner.id]);await app.updateRoster(teacher,learner.id,{accountStatus:'active'},one.id);
  assert.equal((await app.studentState(learner)).canRequestPass,false);await assert.rejects(()=>app.newQuiz(learner,'restroom',one.id),failure(403));
  await db.query('UPDATE users SET account_suspended=FALSE WHERE id=$1',[learner.id]);await app.removeStudent(teacher,learner.id,one.id);
  const state=await app.studentState(learner);assert.equal(state.enrollments.length,1);assert.equal(state.enrollments[0].classroom.id,foreign.id);assert.equal(state.enrollments[0].status,'approved');
 });
});

test('version six migration preserves accounts, hashes, old approvals, memberships and history without inventing schedules',async()=>{
 const db=new PGlite('memory://');try{
  await db.exec(baselineSchema);for(const migration of migrations.filter(m=>m.version<6)){await db.exec(migration.sql);await db.query('INSERT INTO watercycle_migrations(version) VALUES($1)',[migration.version]);}
  const hash=await hashPassword(password);
  await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES('t','teacher','Old','Teacher','oldteacher',$1)",[hash]);
  await db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('c','t','Existing class','MIG01')");
  for(const status of ['active','pending','deactivated']){
   await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id,account_status,enabled) VALUES($1,'student','Old','Student',$1,$2,'c',$3,$4)",[status,hash,status,status!=='deactivated']);
   await db.query("INSERT INTO enrollments(id,student_id,classroom_id) VALUES($1,$1,'c')",[status]);
   await db.query("INSERT INTO visits(id,student_id,classroom_id,status,left_at,returned_at) VALUES($1,$1,'c','returned','2026-01-02T12:00:00Z','2026-01-02T12:03:00Z')",[status]);
  }
  await db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('past','t','Historical membership','MIG02')");
  await db.query("INSERT INTO enrollments(id,student_id,classroom_id,active,left_at) VALUES('historical','active','past',FALSE,statement_timestamp())");
  await db.query("UPDATE users SET approved_by='t',approved_at=statement_timestamp() WHERE id='active'");
  const beforeUsers=(await db.query<Record<string,unknown>>('SELECT * FROM users ORDER BY id')).rows,beforeVisits=(await db.query<Record<string,unknown>>('SELECT * FROM visits ORDER BY id')).rows;
  async function migrate(){await db.transaction(async tx=>await migrateDatabase({query:async<T>(sql:string,params:unknown[]=[])=>({rows:(await tx.query<T>(sql,params)).rows})},async sql=>{await tx.exec(sql);}));}
  await migrate();await migrate();
  const after=(await db.query<Record<string,unknown>>('SELECT * FROM users ORDER BY id')).rows;beforeUsers.forEach((row,i)=>Object.entries(row).forEach(([key,value])=>assert.deepEqual(after[i][key],value)));
  const trips=(await db.query<Record<string,unknown>>('SELECT * FROM visits ORDER BY id')).rows;beforeVisits.forEach((row,i)=>Object.entries(row).forEach(([key,value])=>assert.deepEqual(trips[i][key],value)));
  assert.deepEqual((await db.query('SELECT student_id,status FROM enrollments WHERE active=TRUE ORDER BY student_id')).rows,[{student_id:'active',status:'approved'},{student_id:'deactivated',status:'deactivated'},{student_id:'pending',status:'pending'}]);
  assert.deepEqual((await db.query("SELECT status,approved_at,approved_by FROM enrollments WHERE id='historical'")).rows[0],{status:'deactivated',approved_at:null,approved_by:null});
  assert.equal((await db.query<{start_time:null}>('SELECT start_time FROM classrooms')).rows[0].start_time,null);
  assert.equal(after.find(row=>row.id==='deactivated')?.account_suspended,true);
 }finally{await db.close();}
});
