// Only the isolated Docker harness supplies these generated test credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../../src/lib/db';
import { WaterCycle } from '../../src/lib/domain';
import { ADMIN_USERNAME } from '../../src/lib/bootstrap-admin';
import { createSession, sessionUser } from '../../src/lib/auth';
import type { Quiz, Question } from '../../src/lib/contracts';
async function main(){
 assert.match(process.env.WATERCYCLE_POSTGRES_CONTAINER??'',/^watercycle-persistence-/);
 const db=await getDatabase();
 try {
  const app=new WaterCycle(db);const passwords=JSON.parse(process.env.WATERCYCLE_TEST_CREDENTIALS!);
  const admin=await app.login({username:ADMIN_USERNAME,password:passwords.admin,role:'admin'});
  if(process.argv[2]==='create'){
   const account=await app.createTeacher(admin,{firstName:'Persistence',lastName:'Teacher',username:'persistenceteacher',email:'persistence@school.test',password:passwords.temporary,enabled:true});
   let teacher=await app.login({username:account.username,password:passwords.temporary,role:'teacher'});
   await app.changePassword(teacher,passwords.temporary,passwords.teacher);teacher=await app.login({username:account.username,password:passwords.teacher,role:'teacher'});
   const classroom=await app.createClass(teacher,{name:'Persistent Biology',period:'1',code:'PER01',startTime:'00:00',endTime:'23:59'});
   // Disposable PostgreSQL regression fixture: exercise persisted custom days
   // so real production-server restart checks also run on weekends. New classes
   // created through the product still default to Monday–Friday.
   await db.query('UPDATE classrooms SET schedule_days=ARRAY[1,2,3,4,5,6,7] WHERE id=$1',[classroom.id]);
   const student=await app.signup({firstName:'Persistent',lastName:'Student',password:passwords.student});await app.enrollStudent(student,classroom.code!);
   const pending=await app.signup({firstName:'Pending',lastName:'Student',password:passwords.student});await app.enrollStudent(pending,classroom.code!);
   await app.updateRoster(teacher,student.id,{accountStatus:'active'});await app.completeTutorial(student);
   async function answer(quiz:Quiz){const {rows:[row]}=await db.query<{questions:Question[]}>('SELECT questions FROM quizzes WHERE id=$1',[quiz.id]);return app.answerQuiz(student,{quizId:quiz.id,questionId:quiz.question.id,questionToken:quiz.questionToken,answer:row.questions.find(q=>q.id===quiz.question.id)!.correctIndex});}
   const first=await answer(await app.newQuiz(student,'restroom'));const trip=(await answer(first.quiz!)).visit!;
   await db.query("UPDATE visits SET left_at=statement_timestamp()-INTERVAL '13 minutes' WHERE id=$1",[trip.id]);await app.acknowledgeWarning(student,trip.id);await app.studentAction(student,'return');
   await app.reopenVisit(teacher,trip.id);await app.studentAction(student,'return');
   await answer(await app.newQuiz(student,'water'));
   const ticket=await app.submitReport(teacher,{teacherName:'Persistence Teacher',email:'persistence@school.test',description:'Preserve this problem report across deployments.',requestId:randomUUID()});await app.changeReportStatus(admin,ticket.id,'solved');await app.changeReportStatus(admin,ticket.id,'need_attention');
   const inactive=await app.createTeacher(admin,{firstName:'Inactive',lastName:'Teacher',username:'inactiveteacher',password:passwords.temporary,enabled:false});assert.equal(inactive.enabled,false);
   const token=await createSession(db,student.id);
   console.log(JSON.stringify({studentId:student.id,session:token,ticketId:ticket.id}));
  }else{
   const saved=JSON.parse(process.env.WATERCYCLE_TEST_SAVED!);
   const teacher=await app.login({username:'persistenceteacher',password:passwords.teacher,role:'teacher'});
   const student=await app.login({username:'persistentstudent01',password:passwords.student,role:'student'});
   assert.equal(student.id,saved.studentId);assert.equal((await sessionUser(db,saved.session))?.id,student.id);
   const state=await app.studentState(student);assert.equal(state.user.accountStatus,'active');assert.equal(state.user.tutorialCompleted,true);assert.equal(state.activeQuiz?.correctCount,1);
   assert.equal(state.recentVisits.length,1);assert.equal(state.recentVisits[0].corrections.length,1);assert.ok(state.recentVisits[0].warningAcknowledgedAt);
   const roster=await app.teacherState(teacher);assert.equal(roster.students.length,2);assert.equal(roster.pendingStudents.length,1);assert.ok(roster.questions.length>=2);
   const violations=await app.ruleOffenders(teacher);assert.equal(violations.violations.length,1);assert.equal(violations.violations[0].totalViolations,1);
   assert.equal((await app.problemReport(admin,saved.ticketId)).history.length,2);
   console.log('Existing accounts, password changes, sessions, rosters, learning, trips, violations, corrections, and tickets verified.');
  }
 }finally{await db.close();}
}
main().catch(()=>{console.error('Isolated deployment persistence worker failed; no credentials were logged.');process.exitCode=1;});
