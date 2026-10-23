import { WorkflowTestApp as WaterCycle } from './student-fixtures';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../src/lib/db';
import {} from '../src/lib/domain';
import { bootstrapAdministrator } from '../src/lib/bootstrap-admin';
import { AppError, createSession, hashPassword, sessionUser, userFrom } from '../src/lib/auth';
import { reportSchema } from '../src/lib/problem-reports';
import type { Classroom, Quiz, Question, User } from '../src/lib/contracts';
const password='Approval-test-2026!';
const fails=(status:number)=>(error:unknown)=>error instanceof AppError&&error.status===status;
let db:Database,app:WaterCycle,teacher:User,other:User,admin:User,room:Classroom,otherRoom:Classroom;
async function teacherFixture(username:string){return userFrom((await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES($1,'teacher','Approval','Teacher',$2,$3) RETURNING *",[randomUUID(),username,await hashPassword(password)])).rows[0]);}
async function signup(name:string,code=room.code!){return app.signup({firstName:name,lastName:'Student',password,classroomCode:code});}
async function approved(name:string){const student=await signup(name);await app.updateRoster(teacher,student.id,{accountStatus:'active'});return student;}
async function answer(student:User,quiz:Quiz){const {rows:[row]}=await db.query<{questions:Question[]}>('SELECT questions FROM quizzes WHERE id=$1',[quiz.id]);return app.answerQuiz(student,{quizId:quiz.id,questionId:quiz.question.id,questionToken:quiz.questionToken,answer:row.questions.find(q=>q.id===quiz.question.id)!.correctIndex});}
async function qualify(student:User){const first=await answer(student,await app.newQuiz(student,'water'));return(await answer(student,first.quiz!)).visit!;}
function report(overrides:Record<string,unknown>={}){return reportSchema.parse({teacherName:'Dr Biology',email:'biology@school.test',description:'The classroom page stopped updating.',requestId:randomUUID(),...overrides});}

describe('Student approval, audited return corrections, and private problem reports',()=>{
 before(async()=>{db=await createDatabase({directory:'memory://',bootstrapAdmin:false});app=new WaterCycle(db);});
 beforeEach(async()=>{
  await db.query('TRUNCATE rate_limits,sessions,quizzes,visits,questions,enrollments,users,classrooms CASCADE');
  await bootstrapAdministrator(db,randomBytes(30).toString('base64url'));admin=userFrom((await db.query("SELECT * FROM users WHERE role='admin'")).rows[0]);
  teacher=await teacherFixture('approvalteacher');other=await teacherFixture('foreignteacher');
  room=await app.createClass(teacher,{name:'Approval Biology',period:'1',code:'AP001'});otherRoom=await app.createClass(other,{name:'Other Biology',code:'AP002'});
 });
 after(async()=>await db.close());
 it('defaults signups and roster claims to Pending while allowing login, tutorial, and limited dashboard',async()=>{
  const learner=await signup('Pending');assert.equal(learner.accountStatus,'active');
  assert.equal((await app.login({username:learner.username,password,role:'student'})).accountStatus,'active');
  const state=await app.studentState(learner);assert.equal(state.canRequestPass,false);assert.equal(state.activeQuiz,null);assert.equal(state.currentVisit,null);
  assert.equal(state.enrollments[0].status,'pending');assert.match(state.unavailableReason!,/approved to attend/);
  await app.completeTutorial(learner);
  await assert.rejects(()=>app.newQuiz(learner,'restroom'),fails(403));await assert.rejects(()=>app.newQuiz(learner,'water'),fails(403));
  const entry=await app.addRoster(teacher,{firstName:'Claim',lastName:'Student'});assert.notEqual((await signup('Claim')).id,entry.id);
  assert.equal((await app.studentState(userFrom((await db.query('SELECT * FROM users WHERE id=$1',[entry.id])).rows[0]))).user.accountStatus,'active');
  assert.equal((await db.query('SELECT * FROM visits')).rows.length,0);assert.equal((await db.query('SELECT * FROM quizzes')).rows.length,0);
 });
 it('lists all owned pending registrations oldest first, excludes other teachers, and saves idempotent approval audit',async()=>{
  const oldest=await signup('Oldest');const second=await signup('Second');await signup('Foreign',otherRoom.code!);
  await db.query("UPDATE enrollments SET joined_at=statement_timestamp()-INTERVAL '1 day' WHERE student_id=$1",[oldest.id]);
  assert.deepEqual((await app.teacherState(teacher)).pendingStudents.map(s=>s.id),[oldest.id,second.id]);
  await assert.rejects(()=>app.updateRoster(other,oldest.id,{accountStatus:'active'}),fails(404));
  await assert.rejects(()=>app.updateRoster(oldest,oldest.id,{accountStatus:'active'}),fails(403));
  await app.updateRoster(teacher,oldest.id,{accountStatus:'active'});await app.updateRoster(teacher,oldest.id,{accountStatus:'active'});
  assert.deepEqual((await app.teacherState(teacher)).pendingStudents.map(s=>s.id),[second.id]);
  const row=(await db.query('SELECT * FROM enrollments WHERE student_id=$1',[oldest.id])).rows[0];assert.equal(row.approved_by,teacher.id);assert.ok(row.approved_at);
  assert.equal((await db.query('SELECT * FROM student_status_events WHERE student_id=$1',[oldest.id])).rows.length,1);
  assert.equal((await app.studentState(oldest)).canRequestPass,true);assert.ok(await app.newQuiz(oldest,'restroom'));
 });
 it('enforces current server status against stale approved users, answers, and a forged ready departure',async()=>{
  const learner=await approved('Stale');const quiz=await app.newQuiz(learner,'water');await app.updateRoster(teacher,learner.id,{accountStatus:'deactivated'});
  await assert.rejects(()=>answer(learner,quiz),fails(403));await assert.rejects(()=>app.newQuiz(learner,'water'),fails(403));
  await db.query("INSERT INTO visits(id,student_id,classroom_id,status,purpose,ready_expires_at) VALUES($1,$2,$3,'ready','water',statement_timestamp()+INTERVAL '120 seconds')",[randomUUID(),learner.id,room.id]);
  await assert.rejects(()=>app.studentAction(learner,'leave'),fails(403));
  const state=await app.studentState(learner);assert.equal(state.currentVisit,null);assert.equal(state.activeQuiz,null);assert.equal(state.canRequestPass,false);
  const login=await app.login({username:learner.username,password,role:'student'});assert.equal(login.accountStatus,'active');assert.equal((await app.studentState(learner)).enrollments[0].status,'deactivated');
  await app.updateRoster(teacher,learner.id,{accountStatus:'active'});assert.equal((await app.studentState(learner)).canRequestPass,true);
 });
 it('deactivation cancels queue reservations and learning, preserves outside records and sessions, and promotes FIFO',async()=>{
  const students=await Promise.all(['One','Two','Three','Four'].map(approved));for(const student of students)await qualify(student);
  await app.studentAction(students[0],'return');assert.equal((await app.studentState(students[2])).currentVisit?.status,'ready');
  await app.updateRoster(teacher,students[2].id,{accountStatus:'deactivated'});assert.equal((await app.studentState(students[3])).currentVisit?.status,'ready');
  const token=await createSession(db,students[1].id);const before=(await app.studentState(students[1])).currentVisit!;
  await app.updateRoster(teacher,students[1].id,{accountStatus:'deactivated'});
  assert.equal((await sessionUser(db,token))?.accountStatus,'active');assert.deepEqual((await app.studentState(students[1])).currentVisit,before);
  await app.studentAction(students[1],'return');assert.equal((await app.studentState(students[1])).currentVisit,null);
 });
 it('requires approval again after self-enrollment under a different teacher',async()=>{
  const learner=await approved('Rejoin');await app.removeStudent(teacher,learner.id);await app.enrollStudent(learner,otherRoom.code!);
  assert.equal((await app.studentState(learner)).enrollments[0].status,'pending');
  await assert.rejects(()=>app.updateRoster(teacher,learner.id,{accountStatus:'active'}),fails(404));await app.updateRoster(other,learner.id,{accountStatus:'active'});
  assert.equal((await app.studentState(learner)).canRequestPass,true);
 });
 it('reopens the same break from the original departure, preserves audit and warning, and counts one violation',async()=>{
  const learner=await approved('Correction');const visit=await qualify(learner);
  await db.query("UPDATE visits SET left_at=statement_timestamp()-INTERVAL '13 minutes' WHERE id=$1",[visit.id]);
  const original=(await app.studentState(learner)).currentVisit!;await app.studentAction(learner,'return');
  const returned=(await app.studentState(learner)).recentVisits[0];await app.reopenVisit(teacher,visit.id);
  const current=(await app.studentState(learner)).currentVisit!;assert.equal(current.id,visit.id);assert.equal(current.leftAt,original.leftAt);assert.equal(current.returnedAt,null);
  assert.equal(current.corrections.length,1);assert.equal(new Date(current.corrections[0].incorrectReturnedAt).toISOString(),returned.returnedAt);
  assert.equal(current.warningAcknowledgedAt,null);await app.acknowledgeWarning(learner,visit.id);
  assert.equal((await app.ruleOffenders(teacher)).violations[0].totalViolations,1);
  await assert.rejects(()=>app.reopenVisit(teacher,visit.id),fails(409));
  await app.studentAction(learner,'return');assert.equal((await app.studentState(learner)).currentVisit,null);
  assert.equal((await db.query('SELECT * FROM visits WHERE student_id=$1',[learner.id])).rows.length,1);
  assert.equal((await app.ruleOffenders(teacher)).violations[0].totalViolations,1);
 });
 it('restores accurate over-capacity without cancelling innocent breaks or advancing the waiting queue',async()=>{
  const students=await Promise.all(['One','Two','Three','Four'].map(approved));const visits=[];for(const student of students)visits.push(await qualify(student));
  await app.studentAction(students[0],'return');await app.studentAction(students[2],'leave');
  const innocent=(await app.studentState(students[2])).currentVisit!;await app.reopenVisit(teacher,visits[0].id);
  assert.equal((await app.teacherState(teacher)).stats.out,3);assert.deepEqual((await app.studentState(students[2])).currentVisit,innocent);
  assert.equal((await app.studentState(students[3])).currentVisit?.status,'waiting');
  await app.studentAction(students[0],'return');assert.equal((await app.studentState(students[3])).currentVisit?.status,'waiting');
  await app.studentAction(students[1],'return');assert.equal((await app.studentState(students[3])).currentVisit?.status,'ready');
 });
 it('blocks an existing reservation from leaving when a correction has filled all outside slots',async()=>{
  const a=await approved('One'),b=await approved('Two'),c=await approved('Three');const first=await qualify(a);await qualify(b);await qualify(c);
  await app.studentAction(a,'return');assert.equal((await app.studentState(c)).currentVisit?.status,'ready');await app.reopenVisit(teacher,first.id);
  await assert.rejects(()=>app.studentAction(c,'leave'),fails(409));const paused=(await app.studentState(c)).currentVisit!;assert.equal(paused.status,'ready');assert.equal(paused.reservationPaused,true);
  // Simulate no browser polling for several minutes while the actual spots stay full.
  await db.query("UPDATE visits SET ready_expires_at=statement_timestamp()-INTERVAL '5 minutes' WHERE id=$1",[paused.id]);
  assert.equal((await app.studentState(c)).currentVisit?.status,'ready');
  await app.studentAction(a,'return');const resumed=(await app.studentState(c)).currentVisit!;assert.equal(resumed.id,paused.id);assert.equal(resumed.reservationPaused,false);assert.ok(Date.parse(resumed.readyExpiresAt!)>Date.now()+110000);await app.studentAction(c,'leave');assert.equal((await app.studentState(c)).currentVisit?.status,'out');
 });
 it('checks correction ownership, older override, and duplicate active breaks, auditing each legitimate correction',async()=>{
  const learner=await approved('Older');const visit=await qualify(learner);await app.studentAction(learner,'return');
  await assert.rejects(()=>app.reopenVisit(other,visit.id),fails(404));await assert.rejects(()=>app.reopenVisit(learner,visit.id),fails(403));await assert.rejects(()=>app.reopenVisit(admin,visit.id),fails(403));
  await db.query("UPDATE visits SET left_at=statement_timestamp()-INTERVAL '26 hours',returned_at=statement_timestamp()-INTERVAL '25 hours' WHERE id=$1",[visit.id]);
  await assert.rejects(()=>app.reopenVisit(teacher,visit.id),fails(409));await assert.rejects(()=>app.reopenVisit(teacher,visit.id,{resolveOlder:true,reason:'short'}),fails(409));
  await app.reopenVisit(teacher,visit.id,{resolveOlder:true,reason:'Teacher reconciled an older inaccurate return.'});await app.studentAction(learner,'return');
  const second=await qualify(learner);await assert.rejects(()=>app.reopenVisit(teacher,visit.id),fails(409));await app.studentAction(learner,'return');
  const results=await Promise.allSettled([app.reopenVisit(teacher,second.id),app.reopenVisit(teacher,second.id)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await db.query("SELECT * FROM visits WHERE student_id=$1 AND status='out'",[learner.id])).rows.length,1);
 });
 it('saves authenticated teacher reports with Need Attention, validates inputs, and deduplicates retries transactionally',async()=>{
  const input=report();const results=await Promise.all([app.submitReport(teacher,input),app.submitReport(teacher,input)]);assert.equal(results[0].id,results[1].id);
  const row=(await db.query('SELECT * FROM problem_reports')).rows[0];assert.equal(row.teacher_id,teacher.id);assert.equal(row.status,'need_attention');assert.ok(row.submitted_at);
  for(const invalid of [{teacherName:''},{email:'invalid'},{description:'  '}])await assert.rejects(()=>app.submitReport(teacher,{...input,...invalid}));
  await assert.rejects(()=>app.submitReport(teacher,{...input,description:'Changed content'}),fails(409));assert.equal((await db.query('SELECT * FROM problem_reports')).rows.length,1);
 });
 it('allows only the sole developer to list, read, solve, or reopen tickets',async()=>{
  const learner=await signup('Denied');const ticket=await app.submitReport(teacher,report());
  for(const user of [learner,teacher,other]){await assert.rejects(()=>app.problemReports(user),fails(403));await assert.rejects(()=>app.problemReport(user,ticket.id),fails(403));await assert.rejects(()=>app.changeReportStatus(user,ticket.id,'solved'),fails(403));}
  for(const user of [learner,admin])await assert.rejects(()=>app.submitReport(user,report()),fails(403));
  const original=await app.problemReport(admin,ticket.id);await app.changeReportStatus(admin,ticket.id,'solved');await app.changeReportStatus(admin,ticket.id,'solved');
  let detail=await app.problemReport(admin,ticket.id);assert.ok(detail.resolvedAt);assert.equal(detail.history.length,1);assert.equal(detail.submittedAt,original.submittedAt);
  await app.changeReportStatus(admin,ticket.id,'need_attention');detail=await app.problemReport(admin,ticket.id);assert.equal(detail.history.length,2);assert.equal(detail.resolvedAt,null);assert.equal(detail.description,original.description);assert.equal(detail.history[0].status,'solved');
  assert.equal((await app.adminState(admin)).attentionTickets,1);
 });
 it('filters, searches literally, and pages through old reports with unresolved first and no timestamp tie losses',async()=>{
  const ids=[];for(let i=0;i<5;i++)ids.push((await app.submitReport(teacher,report({teacherName:i===0?'Percent% Teacher':`Teacher ${i}`}))).id);
  await app.changeReportStatus(admin,ids[4],'solved');await db.query("UPDATE problem_reports SET submitted_at='2026-10-20T12:00:00.000123Z'");
  let cursor:string|undefined;const found:string[]=[];do{const page=await app.problemReports(admin,{status:'all',limit:2,cursor});found.push(...page.tickets.map(t=>t.id));cursor=page.nextCursor??undefined;}while(cursor);
  assert.equal(found.length,5);assert.equal(new Set(found).size,5);assert.equal(found.at(-1),ids[4]);
  assert.equal((await app.problemReports(admin,{status:'solved'})).tickets[0].id,ids[4]);assert.equal((await app.problemReports(admin,{search:'%'})).tickets.length,1);
  assert.equal((await app.problemReports(admin,{search:ids[1]})).tickets[0].id,ids[1]);assert.equal((await app.problemReports(admin,{search:'biology@school.test'})).tickets.length,5);
  await assert.rejects(()=>app.problemReports(admin,{cursor:'bad'}),fails(400));
 });
});
