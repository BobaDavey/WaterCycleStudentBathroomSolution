import {after,before,describe,it,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createDatabase,type Database} from '../src/lib/db';
import {WaterCycle} from '../src/lib/domain';
import {AppError,hashPassword,userFrom} from '../src/lib/auth';
import {baselineSchema,migrations,migrateDatabase} from '../src/lib/migrations';
import type {Classroom,Question,Quiz,User} from '../src/lib/contracts';

const password='IsolatedCapacityTest2026!';
const clock=()=>new Date('2026-07-06T16:00:00Z');
const status=(expected:number)=>(error:unknown)=>error instanceof AppError&&error.status===expected;
async function correct(db:Database,app:WaterCycle,student:User,quiz:Quiz){
 const {rows:[snapshot]}=await db.query<{questions:Question[]}>('SELECT questions FROM quizzes WHERE id=$1',[quiz.id]);
 return app.answerQuiz(student,{quizId:quiz.id,questionId:quiz.question.id,questionToken:quiz.questionToken,answer:snapshot.questions.find(q=>q.id===quiz.question.id)!.correctIndex});
}
describe('Classroom-specific Max Passes Allowed',()=>{
 let db:Database,app:WaterCycle,teacher:User,co:User,outsider:User,serial=0;
 before(async()=>{
  db=await createDatabase({directory:'memory://'});app=new WaterCycle(db,clock);
  const hash=await hashPassword(password);
  async function account(username:string){return userFrom((await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES($1,'teacher','Capacity','Teacher',$2,$3) RETURNING *",[randomUUID(),username,hash])).rows[0]);}
  teacher=await account('capacityteacher');co=await account('capacityco');outsider=await account('capacityoutsider');
 });
 after(async()=>await db.close());
 async function room(capacity?:number){return app.createClass(teacher,{name:'Capacity test',code:`CP${String(++serial).padStart(3,'0')}`,startTime:'00:00',endTime:'23:59',capacity});}
 async function learners(classroom:Classroom,count:number){
  const students:User[]=[];
  for(let i=0;i<count;i++){const student=await app.signup({firstName:'Capacity',lastName:'Learner',password});await app.addRoster(teacher,{username:student.username,studentId:student.id},classroom.id);students.push(student);}
  return students;
 }
 async function qualify(student:User,classroom:Classroom){const first=await correct(db,app,student,await app.newQuiz(student,'restroom',classroom.id));return (await correct(db,app,student,first.quiz!)).visit!;}
 it('defaults new and SQL-created classes to two and preserves independent settings and unrelated edits',async()=>{
  const first=await room(),second=await room();assert.equal(first.capacity,2);assert.equal(second.capacity,2);
  await db.query("INSERT INTO classrooms(id,teacher_id,name,code) VALUES('capacity-default',$1,'SQL default','CP000')",[teacher.id]);
  assert.equal((await db.query('SELECT capacity FROM classrooms WHERE id=$1',['capacity-default'])).rows[0].capacity,2);
  await app.updateClass(teacher,first.id,{capacity:5});await app.updateClass(teacher,first.id,{period:'New period'});
  assert.equal((await app.teacherState(teacher,first.id)).classroom?.capacity,5);assert.equal((await app.teacherState(teacher,second.id)).classroom?.capacity,2);
 });
 it('validates whole-number bounds in the API/domain and database, including co-teacher authorization',async()=>{
  const classroom=await room();await app.addCoTeacher(teacher,classroom.id,co.username);
  assert.equal((await app.updateClass(co,classroom.id,{capacity:3})).capacity,3);
  for(const capacity of [0,-1,1.5,31,Infinity,NaN,'3',null]){
   await assert.rejects(()=>app.updateClass(co,classroom.id,{capacity:capacity as number}));
   await assert.rejects(()=>room(capacity as number));
  }
  for(const capacity of [0,-1,31])await assert.rejects(()=>db.query('UPDATE classrooms SET capacity=$1 WHERE id=$2',[capacity,classroom.id]),e=>(e as {code:string}).code==='23514');
  assert.equal((await app.updateClass(co,classroom.id,{capacity:30})).capacity,30);
  await assert.rejects(()=>app.updateClass(outsider,classroom.id,{capacity:1}),status(404));
  await app.removeCoTeacher(teacher,classroom.id,co.id);await assert.rejects(()=>app.updateClass(co,classroom.id,{capacity:1}),status(404));
 });
 for(const capacity of [1,2,3,5])it(`enforces limit ${capacity}, queues concurrent final answers and advances FIFO after return`,async()=>{
  const classroom=await room(capacity),students=await learners(classroom,capacity+2);
  const finals=await Promise.all(students.map(async student=>(await correct(db,app,student,await app.newQuiz(student,'restroom',classroom.id))).quiz!));
  const results=await Promise.all(students.map((student,i)=>correct(db,app,student,finals[i])));
  assert.equal(results.filter(r=>r.visit?.status==='out').length,capacity);assert.equal(results.filter(r=>r.visit?.status==='waiting').length,2);
  const state=await app.teacherState(teacher,classroom.id),waiting=state.visits.filter(v=>v.status==='waiting').sort((a,b)=>a.position!-b.position!);
  const out=state.visits.find(v=>v.status==='out')!;await app.studentAction(students.find(s=>s.id===out.studentId)!,'return');
  const next=(await app.studentState(students.find(s=>s.id===waiting[0].studentId)!)).currentVisit!;assert.equal(next.id,waiting[0].id);assert.equal(next.status,'ready');
  await app.studentAction(students.find(s=>s.id===next.studentId)!,'leave');
  assert.equal((await app.teacherState(teacher,classroom.id)).stats.out,capacity);assert.equal((await app.studentState(students.find(s=>s.id===waiting[1].studentId)!)).currentVisit?.status,'waiting');
 });
 it('reduces below actual occupancy without changing active trips or admitting students until occupancy falls below the new limit',async()=>{
  const classroom=await room(3),students=await learners(classroom,5);for(const student of students)await qualify(student,classroom);
  const trips=(await db.query("SELECT * FROM visits WHERE classroom_id=$1 AND status='out' ORDER BY id",[classroom.id])).rows;
  await app.updateClass(teacher,classroom.id,{capacity:1});assert.deepEqual((await db.query("SELECT * FROM visits WHERE classroom_id=$1 AND status='out' ORDER BY id",[classroom.id])).rows,trips);
  for(const student of students.slice(0,2)){await app.studentAction(student,'return');const state=await app.teacherState(teacher,classroom.id);assert.equal(state.stats.ready,0);assert.equal(state.stats.waiting,2);}
  await app.studentAction(students[2],'return');assert.equal((await app.studentState(students[3])).currentVisit?.status,'ready');assert.equal((await app.studentState(students[4])).currentVisit?.status,'waiting');
 });
 it('pauses excess reservations in FIFO order, preserves them without polling and resumes with a fresh response window',async()=>{
  const classroom=await room(3),students=await learners(classroom,5);for(const student of students)await qualify(student,classroom);
  await app.studentAction(students[0],'return');await app.studentAction(students[1],'return');
  const first=(await app.studentState(students[3])).currentVisit!,second=(await app.studentState(students[4])).currentVisit!;
  await app.updateClass(teacher,classroom.id,{capacity:1});
  for(const student of students.slice(3))assert.equal((await app.studentState(student)).currentVisit?.reservationPaused,true);
  await db.query("UPDATE visits SET ready_expires_at=statement_timestamp()-INTERVAL '5 minutes' WHERE id IN ($1,$2)",[first.id,second.id]);
  await app.studentAction(students[2],'return');
  const resumed=(await app.studentState(students[3])).currentVisit!;assert.equal(resumed.id,first.id);assert.equal(resumed.reservationPaused,false);assert.ok(Date.parse(resumed.readyExpiresAt!)>Date.now()+110000);
  assert.equal((await app.studentState(students[4])).currentVisit?.reservationPaused,true);
  await assert.rejects(()=>app.studentAction(students[4],'leave'),status(409)); // A free spot is reserved for the older turn.
  await app.studentAction(students[3],'leave');await app.studentAction(students[3],'return');
  const last=(await app.studentState(students[4])).currentVisit!;assert.equal(last.id,second.id);assert.equal(last.reservationPaused,false);await app.studentAction(students[4],'leave');
 });
 it('increases capacity immediately for waiting students and rechecks the latest limit for in-progress quizzes',async()=>{
  const classroom=await room(1),students=await learners(classroom,6);for(const student of students.slice(0,5))await qualify(student,classroom);
  const quiz=(await correct(db,app,students[5],await app.newQuiz(students[5],'water',classroom.id))).quiz!;
  await app.updateClass(teacher,classroom.id,{capacity:3});let state=await app.teacherState(teacher,classroom.id);assert.equal(state.stats.out,1);assert.equal(state.stats.ready,2);assert.equal(state.stats.waiting,2);
  assert.equal((await correct(db,app,students[5],quiz)).visit?.status,'waiting');
  await app.updateClass(teacher,classroom.id,{capacity:5});state=await app.teacherState(teacher,classroom.id);assert.equal(state.stats.ready,4);assert.equal(state.stats.waiting,1);
 });
});

test('migration eight preserves every version-seven row and the existing default, then safely permits new capacity values',async()=>{
 const db=new PGlite('memory://');try{
  await db.exec(baselineSchema);for(const migration of migrations.filter(m=>m.version<=7)){await db.exec(migration.sql);await db.query('INSERT INTO watercycle_migrations(version) VALUES($1)',[migration.version]);}
  await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES('t','teacher','Existing','Teacher','capacitylegacy','preserved-hash')");
  await db.query("INSERT INTO classrooms(id,teacher_id,name,code,time_zone,start_time,end_time) VALUES('c','t','Existing class','CAP08','Pacific/Honolulu','08:00','09:00')");
  await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES('s','student','Existing','Student','existingstudent','preserved-student-hash')");
  await db.query("INSERT INTO enrollments(id,student_id,classroom_id,status) VALUES('e','s','c','approved')");
  await db.query("INSERT INTO visits(id,classroom_id,student_id,status,left_at) VALUES('v','c','s','out','2026-07-06T15:00:00Z')");
  const tables=(await db.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'watercycle_migrations' ORDER BY tablename")).rows;
  const snapshot=async()=>Promise.all(tables.map(async t=>({table:t.tablename,rows:(await db.query(`SELECT to_jsonb(t) AS record FROM ${t.tablename} t ORDER BY to_jsonb(t)::text`)).rows})));
  const before=await snapshot();const migrate=()=>db.transaction(async tx=>migrateDatabase({query:async<T>(sql:string,params:unknown[]=[])=>({rows:(await tx.query<T>(sql,params)).rows})},async sql=>{await tx.exec(sql);}));
  await migrate();assert.deepEqual(await snapshot(),before);assert.equal((await db.query<{capacity:number}>("SELECT capacity FROM classrooms WHERE id='c'")).rows[0].capacity,2);
  await db.query("UPDATE classrooms SET capacity=5 WHERE id='c'");await migrate();assert.equal((await db.query<{capacity:number}>("SELECT capacity FROM classrooms WHERE id='c'")).rows[0].capacity,5);
 }finally{await db.close();}
});

test('capacity, active trips and paused reservations persist across isolated database restarts',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'watercycle-capacity-'));let db:Database|undefined;
 try{
  db=await createDatabase({directory});let app=new WaterCycle(db,clock);
  const teacher=userFrom((await db.query("INSERT INTO users(id,role,first_name,last_name,username) VALUES('t','teacher','Test','Teacher','persistcapacity') RETURNING *")).rows[0]);
  const classroom=await app.createClass(teacher,{name:'Persistent limit',code:'CP888',startTime:'00:00',endTime:'23:59'});
  await app.updateClass(teacher,classroom.id,{capacity:5});await db.close();db=await createDatabase({directory});app=new WaterCycle(db,clock);
  assert.equal((await app.teacherState(teacher,classroom.id)).classroom?.capacity,5);
  await app.updateClass(teacher,classroom.id,{capacity:2});const students:User[]=[];
  for(let index=0;index<3;index++){
   const student=await app.signup({firstName:'Persistent',lastName:'Capacity',password});await app.addRoster(teacher,{username:student.username,studentId:student.id},classroom.id);
   const first=await correct(db,app,student,await app.newQuiz(student,'water',classroom.id));await correct(db,app,student,first.quiz!);students.push(student);
  }
  await app.studentAction(students[0],'return');await app.updateClass(teacher,classroom.id,{capacity:1});
  assert.equal((await app.studentState(students[2])).currentVisit?.reservationPaused,true);
  const before=(await db.query('SELECT * FROM visits WHERE classroom_id=$1 ORDER BY id',[classroom.id])).rows;
  await db.close();db=await createDatabase({directory});app=new WaterCycle(db,clock);
  assert.equal((await app.studentState(students[1])).classroom?.capacity,1);assert.equal((await app.studentState(students[1])).currentVisit?.status,'out');
  assert.equal((await app.studentState(students[2])).currentVisit?.reservationPaused,true);assert.deepEqual((await db.query('SELECT * FROM visits WHERE classroom_id=$1 ORDER BY id',[classroom.id])).rows,before);
  await app.studentAction(students[1],'return');assert.equal((await app.studentState(students[2])).currentVisit?.reservationPaused,false);
 }finally{await db?.close();await rm(directory,{recursive:true,force:true});}
});
