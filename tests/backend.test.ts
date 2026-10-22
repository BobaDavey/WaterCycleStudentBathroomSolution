import { approveStudent } from './student-fixtures';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../src/lib/db';
import { AppError, createSession, digest, hashPassword, rateLimit, sessionUser, userFrom, usernameFor, verifyPassword } from '../src/lib/auth';
import { WaterCycle, questionSchema, requirePasswordChange } from '../src/lib/domain';
import type { Question, Quiz, User } from '../src/lib/contracts';

const password = 'Biology-test-2026!';
const rejectsStatus = (status: number) => (error: unknown) => error instanceof AppError && error.status === status;
let db: Database;
let app: WaterCycle;
let teacher: User;
let code: string;
let classroomId: string;

async function student(firstName: string, lastName = 'Student') {
  return approveStudent(db,app,await app.signup({ firstName, lastName, password, classroomCode: code }));
}
async function answerKey(quiz: Quiz): Promise<number> {
  const { rows: [row] } = await db.query<{ questions: Question[] }>('SELECT questions FROM quizzes WHERE id=$1', [quiz.id]);
  return row.questions.find(question => question.id === quiz.question.id)!.correctIndex;
}
async function answer(user: User, quiz: Quiz, value?: number) {
  return app.answerQuiz(user, { quizId: quiz.id, questionId: quiz.question.id, questionToken: quiz.questionToken, answer: value ?? await answerKey(quiz) });
}
async function pass(user: User) {
  const first = await answer(user, await app.newQuiz(user, 'restroom'));
  assert.equal(first.passed, false);
  return answer(user, first.quiz!);
}
async function activeCount() {
  const { rows: [row] } = await db.query<{ count: number }>("SELECT COUNT(*) AS count FROM visits WHERE status IN ('ready','out')");
  return Number(row.count);
}
async function insertTeacher(username: string, firstName = 'Morgan', lastName = 'Reed') {
  const { rows: [row] } = await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id) VALUES($1,'teacher',$2,$3,$4,$5,NULL) RETURNING *", [randomUUID(), firstName, lastName, username, await hashPassword(password)]);
  return userFrom(row);
}
async function otherTeacher() {
  const owner = await insertTeacher('otherteacher', 'Other', 'Teacher');
  await db.query('INSERT INTO classrooms(id,teacher_id,name,code) VALUES($1,$2,$3,$4)', [randomUUID(), owner.id, 'Other classroom', '09009']);
  return owner;
}

describe('WaterCycle persistent classroom workflow', { concurrency: false }, () => {
  before(async () => {
    db = await createDatabase({ directory: 'memory://', bootstrapAdmin: false });
    app = new WaterCycle(db);
  });
  beforeEach(async () => {
    await db.query('TRUNCATE rate_limits,sessions,quizzes,visits,questions,enrollments,users,classrooms CASCADE');
    teacher = await insertTeacher('morganreed');
    const classroom = await app.createClass(teacher, { name: 'Biology 2', period: '2', code: '01001' });
    classroomId = classroom.id;
    code = classroom.code!;
  });
  after(async () => {
    await db?.close();
  });

  it('initializes the class biology bank while preserving the teacher account', async () => {
    const state = await app.teacherState(teacher);
    assert.ok(state.questions.length >= 12);
    assert.equal(state.classroom?.capacity, 2);
    assert.equal(state.classroom?.name, 'Biology 2');
    assert.equal(state.classroom?.code, '01001');
    assert.equal(state.classroom?.teacherId, teacher.id);
    assert.equal(state.classes.length, 1);
    assert.equal((await app.login({ username: teacher.username, password, role: 'teacher' })).id, teacher.id);
  });

  it('uses salted passwords and restricts login to the requested role', async () => {
    const learner = await student('Jamie', 'Chen');
    assert.equal((await app.login({ username: 'JAMIECHEN', password, role: 'student' })).id, learner.id);
    await assert.rejects(() => app.login({ username: 'jamiechen', password: 'incorrect', role: 'student' }), rejectsStatus(401));
    await assert.rejects(() => app.login({ username: 'jamiechen', password, role: 'teacher' }), rejectsStatus(401));
    await assert.rejects(() => app.login({ username: 'missing', password, role: 'student' }), rejectsStatus(401));
    const hashes = await Promise.all([hashPassword(password), hashPassword(password)]);
    assert.notEqual(hashes[0], hashes[1]);
    assert.equal(await verifyPassword(password, hashes[0]), true);
    assert.equal(await verifyPassword('wrong', hashes[0]), false);
    assert.equal(usernameFor('José', "O'Neil"), 'joseoneil');
  });

  it('lets a first sign-up claim a teacher-created roster entry once', async () => {
    const entry = await app.addRoster(teacher, { firstName: 'Jamie', lastName: 'Chen' });
    assert.equal(entry.registered, false);
    const learner = await student('Jamie', 'Chen');
    assert.equal(learner.id, entry.id);
    assert.equal(learner.username, 'jamiechen');
    assert.equal((await app.teacherState(teacher)).students[0].registered, true);
    await assert.rejects(() => student('Jamie', 'Chen'), rejectsStatus(409));
    await assert.rejects(() => app.signup({ firstName: 'Wrong', lastName: 'Code', password, classroomCode: 'UNKNOWN' }), rejectsStatus(400));
    await app.updateRoster(teacher, learner.id, { enabled: false });
    assert.equal((await app.login({ username: 'jamiechen', password, role: 'student' })).accountStatus,'deactivated');
  });

  it('shows one distinct question at a time without answer keys until two answers are correct', async () => {
    const learner = await student('Jamie', 'Chen');
    const quiz = await app.newQuiz(learner, 'restroom');
    assert.equal(quiz.question.options.length, 4);
    for (const key of ['correctIndex', 'explanation', 'active']) assert.equal(key in quiz.question, false);
    const failed = await answer(learner, quiz, (await answerKey(quiz) + 1) % 4);
    assert.equal(failed.passed, false);
    assert.equal(failed.correctCount, 0);
    assert.equal(failed.visit, undefined);
    assert.notEqual(failed.quiz?.question.id, quiz.question.id);
    assert.equal((await app.studentState(learner)).currentVisit, null);
    assert.ok(failed.feedback.every(item => typeof item.explanation === 'string'));
    assert.equal((await pass(learner)).passed, true);
  });

  it('serializes concurrent successful requests and never grants a third slot', async () => {
    const learners = await Promise.all(['Jamie', 'Alex', 'Sam', 'Casey', 'Riley', 'Avery'].map(first => student(first)));
    const results = await Promise.all(learners.map(pass));
    assert.equal(results.filter(result => result.visit?.status === 'out').length, 2);
    assert.equal(results.filter(result => result.visit?.status === 'waiting').length, 4);
    assert.equal(await activeCount(), 2);
    const states = await Promise.all(learners.map(learner => app.studentState(learner)));
    assert.ok(states.every(state => state.activeCount === 2 && state.waitingCount === 4));
    assert.ok(states.filter(state => state.currentVisit?.status === 'out').every(state => state.currentVisit?.leftAt));
    const waiting = states.find(state => state.currentVisit?.status === 'waiting')!;
    await assert.rejects(() => app.studentAction(waiting.user, 'leave'), rejectsStatus(409));
  });

  it('promotes students in FIFO order and starts queued timers only after departure', async () => {
    const [first, second, third, fourth] = await Promise.all(['First', 'Second', 'Third', 'Fourth'].map(first => student(first)));
    for (const learner of [first, second, third, fourth]) await pass(learner);
    assert.ok((await app.studentState(first)).currentVisit?.leftAt);
    assert.equal((await app.studentState(third)).currentVisit?.leftAt, null);
    assert.equal((await app.studentState(third)).currentVisit?.position, 1);
    assert.equal((await app.studentState(fourth)).currentVisit?.position, 2);
    const departed = (await app.studentState(first)).currentVisit!;
    assert.equal(departed.status, 'out');
    assert.ok(departed.leftAt);
    await app.studentAction(first, 'return');
    assert.equal((await app.studentState(third)).currentVisit?.status, 'ready');
    assert.equal((await app.studentState(third)).currentVisit?.leftAt, null);
    await app.studentAction(third, 'leave');
    assert.ok((await app.studentState(third)).currentVisit?.leftAt);
    assert.equal((await app.studentState(fourth)).currentVisit?.status, 'waiting');
    const firstState = await app.studentState(first);
    assert.equal(firstState.currentVisit, null);
    assert.equal(firstState.recentVisits[0].status, 'returned');
    assert.ok(firstState.recentVisits[0].returnedAt);
    assert.equal(await activeCount(), 2);
    await app.studentAction(second, 'return');
    assert.equal((await app.studentState(fourth)).currentVisit?.status, 'ready');
    assert.equal(await activeCount(), 2);
  });

  it('retains older active passes when more than 1000 newer completed trips exist', async () => {
    const [ready, out, waiting, history] = await Promise.all(['Ready', 'Out', 'Waiting', 'History'].map(first => student(first)));
    const activeIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.query(`INSERT INTO visits(id,classroom_id,student_id,status,requested_at,ready_at,left_at,ready_expires_at)
      VALUES ($1,$4,$5,'ready',CURRENT_TIMESTAMP-INTERVAL '2 days',CURRENT_TIMESTAMP,NULL,CURRENT_TIMESTAMP+INTERVAL '2 minutes'),
             ($2,$4,$6,'out',CURRENT_TIMESTAMP-INTERVAL '2 days',CURRENT_TIMESTAMP-INTERVAL '2 days',CURRENT_TIMESTAMP-INTERVAL '2 days',NULL),
             ($3,$4,$7,'waiting',CURRENT_TIMESTAMP-INTERVAL '2 days',NULL,NULL,NULL)`,
      [...activeIds, classroomId, ready.id, out.id, waiting.id]);
    await db.query(`INSERT INTO visits(id,classroom_id,student_id,status,requested_at,ready_at,left_at,returned_at)
      SELECT 'history-' || n::text,$1,$2,'returned',
        CURRENT_TIMESTAMP-n*INTERVAL '1 minute',CURRENT_TIMESTAMP-n*INTERVAL '1 minute',
        CURRENT_TIMESTAMP-n*INTERVAL '1 minute',CURRENT_TIMESTAMP-(n-1)*INTERVAL '1 minute'
      FROM generate_series(1,1005) n`, [classroomId, history.id]);
    const state = await app.teacherState(teacher);
    for (const id of activeIds) assert.ok(state.visits.some(visit => visit.id === id), `Active pass ${id} must remain visible`);
    assert.equal(state.visits.filter(visit => ['ready', 'out', 'waiting'].includes(visit.status)).length, 3);
    assert.equal(state.visits.filter(visit => visit.status === 'returned').length, 1000);
    assert.equal(state.visits.find(visit => visit.studentId === waiting.id)?.position, 1);
    assert.deepEqual({ out: state.stats.out, ready: state.stats.ready, waiting: state.stats.waiting }, { out: 1, ready: 1, waiting: 1 });
  });

  it('resumes pending attempts and rejects expired or another student’s answers and retired batch submissions', async () => {
    const learner = await student('Jamie');
    const other = await student('Alex');
    const firstQuiz = await app.newQuiz(learner, 'restroom');
    const nextQuiz = await app.newQuiz(learner, 'restroom');
    assert.deepEqual(nextQuiz, firstQuiz);
    await assert.rejects(() => app.submitQuiz(learner, firstQuiz.id, [0, 0]), rejectsStatus(410));
    await assert.rejects(() => answer(other, nextQuiz), rejectsStatus(409));
    await db.query("UPDATE quizzes SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id=$1", [nextQuiz.id]);
    await assert.rejects(() => answer(learner, nextQuiz), rejectsStatus(409));
    await pass(learner);
    await assert.rejects(() => app.newQuiz(learner, 'restroom'), rejectsStatus(409));
    const { rows } = await db.query("SELECT id FROM visits WHERE student_id=$1 AND status IN ('ready','waiting','out')", [learner.id]);
    assert.equal(rows.length, 1);
  });

  it('keeps students out of teacher tools and exposes only their own visit history', async () => {
    const [learner, other] = await Promise.all([student('Jamie'), student('Alex')]);
    await pass(other);
    await app.studentAction(other, 'return');
    await assert.rejects(() => app.teacherState(learner), rejectsStatus(403));
    await assert.rejects(() => app.addRoster(learner, { firstName: 'Bad', lastName: 'Actor' }), rejectsStatus(403));
    await assert.rejects(() => app.studentState(teacher), rejectsStatus(403));
    await assert.rejects(() => app.newQuiz(teacher, 'restroom'), rejectsStatus(403));
    const state = await app.studentState(learner);
    assert.equal(state.currentVisit, null);
    assert.deepEqual(state.recentVisits, []);
    assert.equal('students' in state, false);
    assert.equal('questions' in state, false);
    assert.equal(JSON.stringify(state).includes('password_hash'), false);
    assert.equal(JSON.stringify(state).includes(other.id), false);
  });

  it('isolates classroom questions, roster, passes, and exports from another teacher', async () => {
    const learner = await student('Jamie');
    const visit = (await pass(learner)).visit!;
    const question = (await app.teacherState(teacher)).questions[0];
    const outsider = await otherTeacher();
    await assert.rejects(() => app.updateRoster(outsider, learner.id, { enabled: false }), rejectsStatus(404));
    await assert.rejects(() => app.deleteQuestion(outsider, question.id), rejectsStatus(404));
    await assert.rejects(() => app.saveQuestion(outsider, question, question.id), rejectsStatus(404));
    await assert.rejects(() => app.teacherVisit(outsider, visit.id, 'cancel'), rejectsStatus(404));
    const otherState = await app.teacherState(outsider);
    assert.deepEqual(otherState.students, []);
    assert.deepEqual(otherState.questions, []);
    assert.deepEqual(otherState.visits, []);
    const csv = await app.exportCsv(outsider);
    assert.equal(csv.includes('Jamie'), false);
    assert.equal(csv.split('\r\n').length, 1);
  });

  it('invalidates existing sessions and requires a password change after teacher reset', async () => {
    const learner = await student('Jamie');
    const token = await createSession(db, learner.id);
    assert.equal((await sessionUser(db, token))?.id, learner.id);
    await app.updateRoster(teacher, learner.id, { password: 'Temporary-2026!' });
    assert.equal(await sessionUser(db, token), null);
    await assert.rejects(() => app.login({ username: learner.username, password, role: 'student' }), rejectsStatus(401));
    const resetUser = await app.login({ username: learner.username, password: 'Temporary-2026!', role: 'student' });
    assert.equal(resetUser.mustChangePassword, true);
    assert.throws(() => requirePasswordChange(resetUser), rejectsStatus(403));
    await assert.rejects(() => app.newQuiz(resetUser, 'restroom'), rejectsStatus(403));
    await assert.rejects(() => app.changePassword(resetUser, 'wrong', 'A-new-password-2026!'), rejectsStatus(400));
    await app.changePassword(resetUser, 'Temporary-2026!', 'A-new-password-2026!');
    const changedUser = await app.login({ username: learner.username, password: 'A-new-password-2026!', role: 'student' });
    assert.equal(changedUser.mustChangePassword, false);
    assert.ok((await app.newQuiz(changedUser, 'restroom')).question.id);
  });

  it('expires sessions and never stores bearer tokens in plaintext', async () => {
    const learner = await student('Jamie');
    const token = await createSession(db, learner.id);
    const { rows: [row] } = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id=$1', [learner.id]);
    assert.notEqual(row.token_hash, token);
    assert.equal(row.token_hash, digest(token));
    assert.equal(await sessionUser(db, 'bad-token'), null);
    await db.query("UPDATE sessions SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE user_id=$1", [learner.id]);
    assert.equal(await sessionUser(db, token), null);
  });

  it('deactivation preserves an outside break and login while preventing new requests', async () => {
    const [first, second, third] = await Promise.all(['First', 'Second', 'Third'].map(first => student(first)));
    for (const learner of [first, second, third]) await pass(learner);
    const token = await createSession(db, first.id);
    await app.updateRoster(teacher, first.id, { enabled: false });
    assert.equal((await sessionUser(db, token))?.accountStatus,'deactivated');
    assert.equal((await app.studentState(third)).currentVisit?.status, 'waiting');
    assert.equal((await app.studentState(first)).canRequestPass,false);
    assert.equal((await app.rosterDetail(teacher, first.id)).visits[0].status, 'out');
    assert.equal(await activeCount(), 2);
    await app.studentAction(first,'return');
    assert.equal((await app.studentState(third)).currentVisit?.status,'ready');
    await app.updateRoster(teacher, first.id, { enabled: true });
    assert.equal((await app.login({ username: first.username, password, role: 'student' })).id, first.id);
  });

  it('preserves question snapshots through edits and deletion, but stops new quizzes below two active questions', async () => {
    const learner = await student('Jamie');
    const quiz = await app.newQuiz(learner, 'restroom');
    const state = await app.teacherState(teacher);
    for (const q of state.questions) await app.deleteQuestion(teacher, q.id);
    assert.deepEqual((await app.teacherState(teacher)).questions, []);
    const first = await answer(learner, quiz);
    assert.equal((await answer(learner, first.quiz!)).passed, true);
    await app.studentAction(learner, 'return');
    await assert.rejects(() => app.newQuiz(learner, 'restroom'), rejectsStatus(409));
    const fresh = questionSchema.parse({ prompt: 'Which organelle performs photosynthesis?', options: ['Chloroplast', 'Nucleus', 'Ribosome', 'Mitochondrion'], correctIndex: 0, topic: 'Cells', explanation: 'Chloroplasts contain chlorophyll.', active: true });
    await app.saveQuestion(teacher, fresh);
    await assert.rejects(() => app.newQuiz(learner, 'restroom'), rejectsStatus(409));
    await app.saveQuestion(teacher, { ...fresh, prompt: 'Which organelle makes most cellular ATP?', correctIndex: 3 });
    assert.ok((await app.newQuiz(learner, 'restroom')).question.id);
  });

  it('supports teacher pass management without allowing invalid trip transitions', async () => {
    const learner = await student('Jamie');
    const blockers = await Promise.all(['FirstBlocker', 'SecondBlocker'].map(name => student(name)));
    for (const blocker of blockers) await pass(blocker);
    const firstVisit = (await pass(learner)).visit!;
    await assert.rejects(() => app.teacherVisit(teacher, firstVisit.id, 'return'), rejectsStatus(409));
    await app.teacherVisit(teacher, firstVisit.id, 'cancel');
    await app.studentAction(blockers[0], 'return');
    const secondVisit = (await pass(learner)).visit!;
    await assert.rejects(() => app.studentAction(learner, 'cancel'), rejectsStatus(409));
    await assert.rejects(() => app.teacherVisit(teacher, secondVisit.id, 'cancel'), rejectsStatus(409));
    await app.teacherVisit(teacher, secondVisit.id, 'return');
    assert.equal((await app.studentState(learner)).currentVisit, null);
    const csv = await app.exportCsv(teacher);
    assert.ok(csv.includes('Jamie Student'));
    assert.ok(csv.includes('returned'));
    assert.ok(csv.includes('cancelled'));
  });

  it('keeps rate-limit counters in the database and resets them after expiry', async () => {
    await rateLimit(db, 'same-account', 2);
    await rateLimit(db, 'same-account', 2);
    await assert.rejects(() => rateLimit(db, 'same-account', 2), rejectsStatus(429));
    await db.query("UPDATE rate_limits SET reset_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE key=$1", ['same-account']);
    await rateLimit(db, 'same-account', 2);
    const { rows: [row] } = await db.query<{ attempts: number }>('SELECT attempts FROM rate_limits WHERE key=$1', ['same-account']);
    assert.equal(row.attempts, 1);
  });
});
