import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../src/lib/db';
import { bootstrapAdministrator, ADMIN_USERNAME } from '../src/lib/bootstrap-admin';
import { AppError, createSession, hashPassword, sessionUser, userFrom } from '../src/lib/auth';
import { WaterCycle, requirePasswordChange, teacherUpdateSchema } from '../src/lib/domain';
import type { Classroom, Question, Quiz, User } from '../src/lib/contracts';

const teacherPassword = 'Classroom-teacher-2026!';
const studentPassword = 'Classroom-student-2026!';
const status = (expected: number) => (error: unknown) => error instanceof AppError && error.status === expected;
const sqlCode = (expected: string) => (error: unknown) => (error as { code?: string })?.code === expected;
let db: Database;
let app: WaterCycle;
let administrator: User;
let teacher: User;
let otherTeacher: User;
let firstClass: Classroom;
let secondClass: Classroom;
let otherClass: Classroom;

async function teacherFixture(username: string, firstName: string) {
  const { rows: [row] } = await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id,email) VALUES($1,'teacher',$2,'Teacher',$3,$4,NULL,$5) RETURNING *", [randomUUID(), firstName, username, await hashPassword(teacherPassword), `${username}@school.test`]);
  return userFrom(row);
}
async function refreshed(user: User) {
  const { rows: [row] } = await db.query('SELECT * FROM users WHERE id=$1', [user.id]);
  return userFrom(row);
}
async function register(firstName: string, code = firstClass.code!, username?: string) {
  return app.signup({ firstName, lastName: 'Learner', username, password: studentPassword, classroomCode: code });
}
async function answers(quiz: Quiz) {
  const { rows: [row] } = await db.query<{ questions: Question[] }>('SELECT questions FROM quizzes WHERE id=$1', [quiz.id]);
  return row.questions.map(question => question.correctIndex);
}
async function request(user: User) {
  const quiz = await app.newQuiz(user);
  return (await app.submitQuiz(user, quiz.id, await answers(quiz))).visit!;
}

// Every administrator test uses a newly generated, ephemeral password. No real
// administrator credential or fixed administrator password is a test fixture.
describe('Multi-teacher classes, enrollment, and administrator oversight', { concurrency: false }, () => {
  before(async () => {
    db = await createDatabase({ directory: 'memory://', bootstrapAdmin: false });
    app = new WaterCycle(db);
  });
  beforeEach(async () => {
    await db.query('TRUNCATE rate_limits,sessions,quizzes,visits,questions,enrollments,users,classrooms CASCADE');
    await bootstrapAdministrator(db, randomBytes(32).toString('base64url'));
    administrator = userFrom((await db.query("SELECT * FROM users WHERE role='admin'")).rows[0]);
    teacher = await teacherFixture('firstteacher', 'First');
    otherTeacher = await teacherFixture('secondteacher', 'Second');
    firstClass = await app.createClass(teacher, { name: 'Biology', period: '1', code: '01001' });
    secondClass = await app.createClass(teacher, { name: 'AP Biology', period: '2', code: '01002' });
    otherClass = await app.createClass(otherTeacher, { name: 'Honors Biology', period: '3', code: '02001' });
  });
  after(async () => { await db?.close(); });

  it('creates multiple owned classes, keeps leading zeros, and enforces five digits in PostgreSQL', async () => {
    const leading = await app.createClass(teacher, { name: 'Early biology', period: '0', code: '00001' });
    assert.equal(leading.code, '00001');
    assert.equal(leading.teacherId, teacher.id);
    const state = await app.teacherState(teacher);
    assert.equal(state.classes.length, 3);
    assert.ok(state.classes.every(classroom => classroom.teacherId === teacher.id));
    assert.equal(state.classes.some(classroom => classroom.id === otherClass.id), false);
    for (const code of ['1234', '123456', '12a45', ' 12345', '12345 ']) {
      await assert.rejects(db.query('INSERT INTO classrooms(id,teacher_id,name,code) VALUES($1,$2,$3,$4)', [randomUUID(), teacher.id, 'Invalid code class', code]), sqlCode('23514'));
    }
    await assert.rejects(() => app.createClass(otherTeacher, { name: 'Duplicate code', period: '4', code: '00001' }), error => status(409)(error) || sqlCode('23505')(error));
    await assert.rejects(db.query('INSERT INTO classrooms(id,teacher_id,name,code) VALUES($1,$2,$3,$4)', [randomUUID(), otherTeacher.id, 'Duplicate at database level', '00001']), sqlCode('23505'));
  });

  it('edits class names and codes without moving students or deleting existing trips', async () => {
    const learner = await register('Existing');
    const visit = await request(learner);
    await app.studentAction(learner, 'leave');
    await app.studentAction(learner, 'return');
    const updated = await app.updateClass(teacher, firstClass.id, { name: 'Updated biology', period: 'A', code: '00007' });
    assert.equal(updated.name, 'Updated biology');
    assert.equal(updated.code, '00007');
    const state = await app.teacherState(teacher, firstClass.id);
    assert.equal(state.students[0].id, learner.id);
    assert.equal(state.visits.find(item => item.id === visit.id)?.classroomId, firstClass.id);
    assert.equal((await app.studentState(learner)).classroom?.id, firstClass.id);
    await assert.rejects(() => register('OldCode', '01001'), status(400));
    const joined = await register('NewCode', '00007');
    assert.equal(joined.classroomId, firstClass.id);
    await assert.rejects(() => app.updateClass(otherTeacher, firstClass.id, { name: 'Not your class' }), status(404));
    await assert.rejects(() => app.teacherState(otherTeacher, firstClass.id), status(404));
  });

  it('archives classes without erasing records, rejects archived enrollment, and permits only returns', async () => {
    const learner = await register('Out');
    const queued = await register('Reserved');
    await request(learner);
    await app.studentAction(learner, 'leave');
    await request(queued);
    await app.updateClass(teacher, firstClass.id, { archived: true });
    const archived = await app.teacherState(teacher, firstClass.id);
    assert.equal(archived.classroom?.archived, true);
    assert.equal(archived.students.length, 2);
    await assert.rejects(() => register('ArchivedCode'), status(400));
    assert.equal((await app.studentState(learner)).canRequestPass, false);
    assert.equal((await app.studentState(queued)).currentVisit, null);
    await app.studentAction(learner, 'return');
    assert.ok((await app.studentState(learner)).recentVisits.some(visit => visit.status === 'returned'));
    await assert.rejects(() => app.newQuiz(learner), status(409));
    const reused = await app.createClass(otherTeacher, { name: 'Reused available code', period: '4', code: firstClass.code! });
    assert.equal(reused.code, firstClass.code);
    assert.notEqual(reused.id, firstClass.id);
  });

  it('automatically enrolls valid signups once and preserves custom usernames and roster claims', async () => {
    const entry = await app.addRoster(teacher, { firstName: 'Roster', lastName: 'Learner' }, secondClass.id);
    const claimed = await register('Roster', secondClass.code!);
    assert.equal(claimed.id, entry.id);
    assert.equal(claimed.classroomId, secondClass.id);
    const custom = await register('Custom', otherClass.code!, 'customlearner');
    assert.equal(custom.username, 'customlearner');
    assert.equal(custom.classroomId, otherClass.id);
    assert.equal((await app.teacherState(otherTeacher, otherClass.id)).students.some(student => student.id === custom.id), true);
    assert.equal((await app.teacherState(teacher, secondClass.id)).students.some(student => student.id === custom.id), false);
    await assert.rejects(() => register('Custom', otherClass.code!, 'customlearner'), status(409));
    const { rows: [count] } = await db.query('SELECT COUNT(*) AS n FROM enrollments WHERE student_id=$1 AND active=TRUE', [custom.id]);
    assert.equal(Number(count.n), 1);
    await assert.rejects(db.query('INSERT INTO enrollments(id,student_id,classroom_id,active) VALUES($1,$2,$3,TRUE)', [randomUUID(), custom.id, secondClass.id]), sqlCode('23505'));
    await assert.rejects(() => register('Nonexistent', '99999'), status(400));
  });

  it('transfers students only within the owning teacher and preserves departure history and FIFO', async () => {
    const [moving, reserved, waiting] = await Promise.all(['Moving', 'Reserved', 'Waiting'].map(name => register(name)));
    const original = await request(moving);
    await app.studentAction(moving, 'leave');
    await request(reserved);
    await request(waiting);
    await assert.rejects(() => app.transferStudent(teacher, moving.id, otherClass.id), status(404));
    await assert.rejects(() => app.transferStudent(otherTeacher, moving.id, otherClass.id), status(404));
    await app.transferStudent(teacher, moving.id, secondClass.id);
    const moved = await refreshed(moving);
    assert.equal(moved.id, moving.id);
    assert.equal(moved.username, moving.username);
    assert.equal(moved.classroomId, secondClass.id);
    assert.equal((await app.teacherState(teacher, firstClass.id)).students.some(student => student.id === moving.id), false);
    assert.equal((await app.teacherState(teacher, secondClass.id)).students.some(student => student.id === moving.id), true);
    assert.equal((await app.studentState(waiting)).currentVisit?.status, 'ready');
    const old = (await app.teacherState(teacher, firstClass.id)).visits.find(visit => visit.id === original.id)!;
    assert.equal(old.classroomId, firstClass.id);
    assert.equal(old.status, 'returned');
    assert.ok(old.leftAt && old.returnedAt);
    assert.equal((await app.studentState(moved)).recentVisits.some(visit => visit.id === old.id), true);
    assert.equal((await app.newQuiz(moved)).questions.length, 2);
  });

  it('invalidates quizzes issued before a transfer or removal', async () => {
    const learner = await register('Quiz');
    const quiz = await app.newQuiz(learner);
    const key = await answers(quiz);
    await app.transferStudent(teacher, learner.id, secondClass.id);
    const moved = await refreshed(learner);
    await assert.rejects(() => app.submitQuiz(moved, quiz.id, key), status(409));
    const next = await app.newQuiz(moved);
    const nextKey = await answers(next);
    await app.removeStudent(teacher, learner.id);
    const removed = await refreshed(learner);
    await assert.rejects(() => app.submitQuiz(removed, next.id, nextKey), status(409));
    assert.equal((await app.studentState(removed)).currentVisit, null);
  });

  it('removes enrollment without deleting accounts, and lets the same account enroll again', async () => {
    const learner = await register('Removed');
    const visit = await request(learner);
    await app.studentAction(learner, 'leave');
    await app.removeStudent(teacher, learner.id);
    const existing = await app.login({ username: learner.username, password: studentPassword, role: 'student' });
    assert.equal(existing.id, learner.id);
    assert.equal(existing.classroomId, null);
    const state = await app.studentState(existing);
    assert.equal(state.classroom, null);
    assert.equal(state.canRequestPass, false);
    assert.equal(state.recentVisits[0].id, visit.id);
    await assert.rejects(() => app.newQuiz(existing), status(409));
    await app.enrollStudent(existing, secondClass.code!);
    const reenrolled = await refreshed(existing);
    assert.equal(reenrolled.classroomId, secondClass.id);
    await assert.rejects(() => app.enrollStudent(reenrolled, secondClass.code!), status(409));
    await app.removeStudent(teacher, learner.id);
    await app.enrollStudent(await refreshed(existing), firstClass.code!);
    const { rows } = await db.query('SELECT * FROM enrollments WHERE student_id=$1 AND classroom_id=$2', [learner.id, firstClass.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].active, true);
  });

  it('keeps historical student details scoped to the selected teacher-owned class', async () => {
    const learner = await register('History');
    const old = await request(learner);
    await app.studentAction(learner, 'leave');
    await app.studentAction(learner, 'return');
    await app.removeStudent(teacher, learner.id);
    await app.enrollStudent(await refreshed(learner), otherClass.code!);
    const joined = await refreshed(learner);
    const current = await request(joined);
    await app.studentAction(joined, 'leave');
    await app.studentAction(joined, 'return');
    const previousDetail = await app.rosterDetail(teacher, learner.id, firstClass.id);
    assert.equal(previousDetail.visits.some(visit => visit.id === old.id), true);
    assert.equal(previousDetail.visits.some(visit => visit.id === current.id), false);
    const currentDetail = await app.rosterDetail(otherTeacher, learner.id, otherClass.id);
    assert.equal(currentDetail.visits.some(visit => visit.id === old.id), false);
    assert.equal(currentDetail.visits.some(visit => visit.id === current.id), true);
    await assert.rejects(() => app.rosterDetail(otherTeacher, learner.id, firstClass.id), status(404));
    await assert.rejects(() => app.rosterDetail(teacher, learner.id, otherClass.id), status(404));
  });

  it('uses separate two-person limits and question banks in separate class periods', async () => {
    const primary = await Promise.all(['A', 'B', 'C'].map(name => register(`PeriodOne${name}`)));
    const secondary = await Promise.all(['A', 'B', 'C'].map(name => register(`PeriodTwo${name}`, secondClass.code!)));
    for (const learner of [...primary, ...secondary]) await request(learner);
    for (const classroom of [firstClass, secondClass]) {
      const state = await app.teacherState(teacher, classroom.id);
      assert.equal(state.stats.ready, 2);
      assert.equal(state.stats.waiting, 1);
    }
    const firstQuestion = (await app.teacherState(teacher, firstClass.id)).questions[0];
    await assert.rejects(() => app.deleteQuestion(teacher, firstQuestion.id, secondClass.id), status(404));
    await assert.rejects(() => app.exportCsv(otherTeacher, firstClass.id), status(404));
  });

  it('creates teacher credentials as administrator and enforces the first-password change', async () => {
    const created = await app.createTeacher(administrator, { firstName: 'New', lastName: 'Teacher', username: 'newteacher@school.test', email: 'newteacher@school.test', password: teacherPassword, enabled: true });
    let login = await app.login({ username: 'newteacher@school.test', password: teacherPassword, role: 'teacher' });
    assert.equal(login.id, created.id);
    assert.equal(login.mustChangePassword, true);
    assert.throws(() => requirePasswordChange(login), status(403));
    await assert.rejects(() => app.createClass(login, { name: 'Not yet', period: '0', code: '03001' }), status(403));
    await app.changePassword(login, teacherPassword, 'Changed-teacher-2026!');
    login = await app.login({ username: login.username, password: 'Changed-teacher-2026!', role: 'teacher' });
    assert.equal(login.mustChangePassword, false);
    const classroom = await app.createClass(login, { name: 'New teacher class', period: '4', code: '03001' });
    const session = await createSession(db, login.id);
    await app.updateTeacher(administrator, login.id, { password: 'Reset-teacher-2026!' });
    assert.equal(await sessionUser(db, session), null);
    await assert.rejects(() => app.login({ username: login.username, password: 'Changed-teacher-2026!', role: 'teacher' }), status(401));
    const reset = await app.login({ username: login.username, password: 'Reset-teacher-2026!', role: 'teacher' });
    assert.equal(reset.mustChangePassword, true);
    assert.equal((await app.adminClass(administrator, classroom.id)).classroom.id, classroom.id);
  });

  it('deactivates teachers without deleting their classes, students, or records', async () => {
    const learner = await register('Preserved');
    const visit = await request(learner);
    await app.studentAction(learner, 'leave');
    const token = await createSession(db, teacher.id);
    await app.updateTeacher(administrator, teacher.id, teacherUpdateSchema.parse({ enabled: false }));
    const disabledAccount = (await app.adminState(administrator)).teachers.find(account => account.id === teacher.id)!;
    assert.equal(disabledAccount.email, 'firstteacher@school.test');
    assert.equal(await sessionUser(db, token), null);
    await assert.rejects(() => app.login({ username: teacher.username, password: teacherPassword, role: 'teacher' }), status(401));
    await assert.rejects(() => app.teacherState(teacher), status(403));
    await assert.rejects(() => register('DisabledTeacher'), status(400));
    const detail = await app.adminClass(administrator, firstClass.id);
    assert.equal(detail.students.some(student => student.id === learner.id), true);
    assert.equal(detail.visits.some(record => record.id === visit.id), true);
    assert.equal((await app.studentState(learner)).canRequestPass, false);
    await app.studentAction(learner, 'return');
    await app.updateTeacher(administrator, teacher.id, { enabled: true, firstName: 'Updated', email: 'updated@school.test' });
    const enabled = await app.login({ username: teacher.username, password: teacherPassword, role: 'teacher' });
    assert.equal(enabled.firstName, 'Updated');
    assert.equal((await app.studentState(learner)).canRequestPass, true);
  });

  it('preserves omitted email fields and supports explicitly clearing a teacher email', async () => {
    await app.updateTeacher(administrator, teacher.id, teacherUpdateSchema.parse({ password: 'Email-reset-teacher-2026!' }));
    let account = (await app.adminState(administrator)).teachers.find(item => item.id === teacher.id)!;
    assert.equal(account.email, 'firstteacher@school.test');
    await app.updateTeacher(administrator, teacher.id, teacherUpdateSchema.parse({ email: '' }));
    account = (await app.adminState(administrator)).teachers.find(item => item.id === teacher.id)!;
    assert.equal(account.email, null);
    assert.equal(account.firstName, teacher.firstName);
    assert.equal(account.enabled, true);
  });

  it('restricts administrator state and account changes to the singleton administrator', async () => {
    const learner = await register('Private');
    for (const user of [teacher, learner]) {
      await assert.rejects(() => app.adminState(user), status(403));
      await assert.rejects(() => app.adminClass(user, firstClass.id), status(403));
      await assert.rejects(() => app.createTeacher(user, { firstName: 'Denied', lastName: 'Teacher', username: 'deniedteacher', password: teacherPassword, enabled: true }), status(403));
      await assert.rejects(() => app.updateTeacher(user, otherTeacher.id, { enabled: false }), status(403));
      await assert.rejects(() => app.updateAdminProfile(user, { firstName: 'Denied', lastName: 'User' }), status(403));
    }
    await assert.rejects(() => app.teacherState(administrator), status(403));
    await assert.rejects(() => app.studentState(administrator), status(403));
    await assert.rejects(() => app.updateTeacher(administrator, administrator.id, { enabled: false }), status(404));
    const overview = await app.adminState(administrator);
    assert.equal(overview.user.username, ADMIN_USERNAME);
    assert.equal(overview.stats.teachers, 2);
    assert.equal(overview.stats.activeTeachers, 2);
    assert.equal(overview.stats.activeClasses, 3);
    assert.equal(overview.stats.students, 1);
    const serialized = JSON.stringify(overview);
    for (const privateField of ['password_hash', 'token_hash', 'ADMIN_INITIAL_PASSWORD']) assert.equal(serialized.includes(privateField), false);
    const detail = await app.adminClass(administrator, firstClass.id);
    assert.equal(detail.students[0].id, learner.id);
    await app.updateAdminProfile(administrator, { firstName: 'David', lastName: 'Zhang', email: 'administrator@school.test' });
    const current = await refreshed(administrator);
    assert.equal(current.username, ADMIN_USERNAME);
    assert.equal(current.role, 'admin');
    assert.equal(current.email, 'administrator@school.test');
  });
});
