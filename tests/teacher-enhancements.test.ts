import {after,before,describe,it,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createDatabase,type Database} from '../src/lib/db';
import {WaterCycle} from '../src/lib/domain';
import {AppError,hashPassword,userFrom} from '../src/lib/auth';
import {baselineSchema,migrations,migrateDatabase} from '../src/lib/migrations';
import type {User,Question,Quiz} from '../src/lib/contracts';
const password='IsolatedTeacherTests2026!';
const status=(code:number)=>(error:unknown)=>error instanceof AppError&&error.status===code;
describe('Question Sets, shared classrooms and confirmed username enrollment',()=>{
 let db:Database,app:WaterCycle,primary:User,co:User,later:User,outsider:User,first:string,second:string,own:string;
 before(async()=>{
  db=await createDatabase({directory:'memory://'});app=new WaterCycle(db,()=>new Date('2026-07-01T16:00:00Z'));
  const hash=await hashPassword(password);
  async function teacher(username:string){return userFrom((await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES($1,'teacher','Test','Teacher',$2,$3) RETURNING *",[randomUUID(),username,hash])).rows[0]);}
  primary=await teacher('primary');co=await teacher('coteacher');later=await teacher('laterteacher');outsider=await teacher('outsider');
  async function room(user:User,code:string){return (await app.createClass(user,{name:code,code,startTime:'00:00',endTime:'23:59'})).id;}
  first=await room(primary,'ENH01');second=await room(primary,'ENH02');own=await room(co,'ENH03');
 });
 after(async()=>await db.close());
 it('preserves default banks and selects only the distinct union of each class’s active sets',async()=>{
  const initial=await app.teacherState(primary,first);assert.ok(initial.eligibleQuestionCount>=2);assert.equal(initial.activeSetIds.length,1);
  const a=await app.saveQuestionSet(primary,first,{name:'Unit 8',description:'Ecology'}),b=await app.saveQuestionSet(primary,first,{name:'Final review',description:''});
  const q=initial.questions.filter(q=>q.setIds?.includes(initial.activeSetIds[0])).slice(0,2);
  for(const set of [a,b])for(const question of q)await app.setQuestionMembership(primary,first,set.id,question.id,true);
  const unassigned=await app.saveQuestion(primary,{prompt:'An independent ecology question?',options:['One','Two','Three','Four'],correctIndex:0,topic:'Ecology',explanation:'',active:true,setIds:[]},undefined,first) as Question;
  assert.deepEqual((await app.teacherState(primary,first)).questions.find(q=>q.id===unassigned.id)?.setIds,[]);
  await app.setActiveQuestionSets(primary,first,[a.id,b.id]);assert.equal((await app.teacherState(primary,first)).eligibleQuestionCount,2);
  await app.setActiveQuestionSets(primary,second,[b.id]);assert.equal((await app.teacherState(primary,second)).eligibleQuestionCount,2);
  const student=await app.signup({firstName:'Eligible',lastName:'Student',password});await app.enrollStudent(student,'ENH01');await app.updateRoster(primary,student.id,{accountStatus:'active'},first);
  const quiz=await app.newQuiz(student,'restroom');const stored=(await db.query<{questions:Question[]}>('SELECT questions FROM quizzes WHERE id=$1',[quiz.id])).rows[0].questions;
  assert.equal(stored.length,2);assert.deepEqual(new Set(stored.map(q=>q.id)),new Set(q.map(q=>q.id)));
  await app.setQuestionMembership(primary,first,a.id,q[0].id,false);assert.ok((await app.teacherState(primary,first)).questions.some(item=>item.id===q[0].id));
  assert.equal((await db.query('SELECT used FROM quizzes WHERE id=$1',[quiz.id])).rows[0].used,true);
  await app.saveQuestionSet(primary,first,{name:'Ecology renamed',description:'Updated'},a.id);
  await app.deleteQuestionSet(primary,first,a.id);assert.ok((await app.teacherState(primary,first)).questions.some(item=>item.id===q[0].id));
  const visitId=randomUUID();await db.query("INSERT INTO visits(id,student_id,classroom_id,status,left_at) VALUES($1,$2,$3,'out','2026-07-01T15:58:00Z')",[visitId,student.id,first]);
  const before=(await db.query('SELECT * FROM visits WHERE id=$1',[visitId])).rows;
  await app.setActiveQuestionSets(primary,first,[]);assert.equal((await app.teacherState(primary,first)).eligibleQuestionCount,0);assert.equal((await app.teacherState(primary,second)).eligibleQuestionCount,2);assert.deepEqual((await db.query('SELECT * FROM visits WHERE id=$1',[visitId])).rows,before);
  await app.studentAction(student,'return');await assert.rejects(()=>app.newQuiz(student,'water'),/active Question Sets/);
  await app.setActiveQuestionSets(primary,first,[b.id]);const restarted=await app.newQuiz(student,'water');
  await app.saveQuestion(primary,{...q[0],setIds:[]},q[0].id,first);
  assert.equal((await db.query('SELECT used FROM quizzes WHERE id=$1',[restarted.id])).rows[0].used,true);
 });
 it('adds only an existing confirmed student, audits approval and preserves account security',async()=>{
  const student=await app.signup({firstName:'Username',lastName:'Enrollment',password});
  const before=(await db.query('SELECT * FROM users WHERE id=$1',[student.id])).rows[0],count=(await db.query('SELECT COUNT(*) AS n FROM users')).rows[0].n;
  const match=await app.lookupStudent(primary,student.username.toUpperCase(),first);assert.equal(match.id,student.id);
  await assert.rejects(()=>app.addRoster(primary,{username:student.username,studentId:'wrong'},first),status(409));
  await app.addRoster(primary,{username:student.username,studentId:student.id},first);
  const after=(await db.query('SELECT * FROM users WHERE id=$1',[student.id])).rows[0];for(const key of ['password_hash','username','enabled','account_suspended','tutorial_completed'])assert.deepEqual(after[key],before[key]);
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM users')).rows[0].n,count);assert.equal((await app.studentState(student)).enrollments[0].status,'approved');
  await assert.rejects(()=>app.lookupStudent(primary,student.username,first),status(409));await assert.rejects(()=>app.addRoster(primary,{username:student.username,studentId:student.id},first),status(409));
  await assert.rejects(()=>app.lookupStudent(primary,'missing',first),status(404));await assert.rejects(()=>app.lookupStudent(primary,co.username,first),status(400));
  await app.enrollStudent(student,'ENH02');assert.equal((await app.studentState(student)).enrollments.find(e=>e.classroom.id===second)?.status,'pending');
 });
 it('gives every co-teacher classroom management, but teacher membership always remains primary-only',async()=>{
  await app.addCoTeacher(primary,first,co.username);await app.addCoTeacher(primary,first,later.username);
  for(const teacher of [co,later]){
   assert.ok((await app.teacherState(teacher)).classes.some(c=>c.id===first));assert.equal((await app.teacherState(teacher,first)).teachers.filter(t=>t.primary).length,1);
   await assert.rejects(()=>app.addCoTeacher(teacher,first,outsider.username),status(403));await assert.rejects(()=>app.removeCoTeacher(teacher,first,co.id),status(403));
   await app.updateClass(teacher,first,{period:teacher.username});
  }
  await assert.rejects(()=>app.addCoTeacher(primary,first,co.username),status(409));await assert.rejects(()=>app.addCoTeacher(primary,first,primary.username),status(409));await assert.rejects(()=>app.addCoTeacher(primary,first,'missing'),status(404));
  await assert.rejects(()=>app.teacherState(outsider,first),status(404));await assert.rejects(()=>app.teacherState(co,second),status(404));
  const set=await app.saveQuestionSet(co,first,{name:'Shared co-teacher set',description:''});await app.setActiveQuestionSets(co,first,[set.id]);
  const question=await app.saveQuestion(co,{prompt:'A shared classroom question?',options:['A','B','C','D'],correctIndex:1,topic:'Genetics',explanation:'',active:true,setIds:[set.id]},undefined,first) as Question;
  assert.ok((await app.teacherState(primary,first)).questions.some(q=>q.id===question.id));
  const student=await app.signup({firstName:'Shared',lastName:'Student',password});await app.addRoster(co,{username:student.username,studentId:student.id},first);await app.updateRoster(later,student.id,{accountStatus:'deactivated'},first);await app.updateRoster(co,student.id,{accountStatus:'active'},first);
  await assert.rejects(()=>app.addCoTeacher(primary,first,student.username),status(404));
  await assert.rejects(()=>db.query('INSERT INTO classroom_teachers(classroom_id,teacher_id,added_by) VALUES($1,$2,$3)',[first,co.id,primary.id]),(error:unknown)=>(error as {code:string}).code==='23505');
  await assert.rejects(()=>db.query('INSERT INTO classroom_teachers(classroom_id,teacher_id,added_by) VALUES($1,$2,$3)',[first,student.id,primary.id]),(error:unknown)=>(error as {code:string}).code==='23514');
  assert.equal((await app.rosterDetail(co,student.id,first)).student.id,student.id);assert.ok((await app.exportCsv(co,first)).startsWith('"Student"'));
  const visit=randomUUID();await db.query("INSERT INTO visits(id,student_id,classroom_id,status,left_at) VALUES($1,$2,$3,'out',statement_timestamp()-INTERVAL '14 minutes')",[visit,student.id,first]);
  assert.ok((await app.ruleOffenders(co,{classroomId:first})).violations.some(v=>v.id===visit));await app.teacherVisit(co,visit,'return');await app.reopenVisit(later,visit);await app.teacherVisit(co,visit,'return');
  await app.removeCoTeacher(primary,first,co.id);
  for(const operation of [()=>app.teacherState(co,first),()=>app.updateClass(co,first,{period:'denied'}),()=>app.rosterDetail(co,student.id,first),()=>app.exportCsv(co,first),()=>app.ruleOffenders(co,{classroomId:first}),()=>app.teacherVisit(co,visit,'return'),()=>app.saveQuestionSet(co,first,{name:'denied',description:''}),()=>app.setActiveQuestionSets(co,first,[])])await assert.rejects(operation,status(404));
  assert.ok((await app.teacherState(co)).classes.some(c=>c.id===own));assert.ok((await app.teacherState(later,first)).classroom);assert.equal((await db.query('SELECT enabled FROM users WHERE id=$1',[co.id])).rows[0].enabled,true);
 });
});

test('migration seven preserves every version-six application value and activates each original bank',async()=>{
 const db=new PGlite('memory://');try{
  await db.exec(baselineSchema);for(const migration of migrations.filter(m=>m.version<=6)){await db.exec(migration.sql);await db.query('INSERT INTO watercycle_migrations(version) VALUES($1)',[migration.version]);}
  await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES('t','teacher','Old','Teacher','oldteacher','unchanged-hash')");
  await db.query("INSERT INTO classrooms(id,teacher_id,name,code,time_zone,start_time,end_time) VALUES('c','t','Old Biology','OLD01','Pacific/Honolulu','08:00','09:00')");
  await db.query("INSERT INTO questions(id,classroom_id,prompt,options,correct_index,topic) VALUES('q','c','Original question','[\"A\",\"B\",\"C\",\"D\"]',0,'Ecology')");
  const tables=['users','classrooms','questions','enrollments','visits','quizzes','sessions','student_status_events','break_corrections','problem_reports','problem_report_events'];
  const before:Record<string,Record<string,unknown>[]>= {};for(const table of tables)before[table]=(await db.query<Record<string,unknown>>(`SELECT * FROM ${table}`)).rows;
  await db.transaction(async tx=>migrateDatabase({query:async<T>(sql:string,params:unknown[]=[])=>({rows:(await tx.query<T>(sql,params)).rows})},async sql=>{await tx.exec(sql);}));
  for(const table of tables){const after=(await db.query<Record<string,unknown>>(`SELECT * FROM ${table}`)).rows;assert.equal(after.length,before[table].length);before[table].forEach((row,i)=>Object.entries(row).forEach(([key,value])=>assert.deepEqual(after[i][key],value)));}
  assert.deepEqual((await db.query('SELECT set_id,question_id,active FROM question_set_questions')).rows,[{set_id:'legacy-bank-c',question_id:'q',active:true}]);assert.equal((await db.query<{active:boolean}>('SELECT active FROM classroom_question_sets')).rows[0].active,true);assert.equal((await db.query<{created_at:null}>('SELECT created_at FROM questions')).rows[0].created_at,null);
 }finally{await db.close();}
});
