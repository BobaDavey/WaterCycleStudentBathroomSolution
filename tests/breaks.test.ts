import { approveStudent } from './student-fixtures';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, type Database, type SQL } from '../src/lib/db';
import { bootstrapAdministrator } from '../src/lib/bootstrap-admin';
import { AppError, createSession, hashPassword, sessionUser, userFrom } from '../src/lib/auth';
import { WaterCycle } from '../src/lib/domain';
import type { BreakPurpose, Classroom, Question, Quiz, User } from '../src/lib/contracts';

const password = 'Break-workflow-2026!';
const status = (expected: number) => (error: unknown) => error instanceof AppError && error.status === expected;
let db: Database;
let app: WaterCycle;
let teacher: User;
let otherTeacher: User;
let administrator: User;
let classroom: Classroom;

async function teacherFixture(username: string) {
  const { rows: [row] } = await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES($1,'teacher','Biology','Teacher',$2,$3) RETURNING *", [randomUUID(), username, await hashPassword(password)]);
  return userFrom(row);
}
async function student(name: string, code = classroom.code!) {
  return approveStudent(db,app,await app.signup({ firstName: name, lastName: 'Learner', password, classroomCode: code }));
}
async function key(quiz: Quiz) {
  const { rows: [row] } = await db.query<{ questions: Question[] }>('SELECT questions FROM quizzes WHERE id=$1', [quiz.id]);
  return row.questions.find(question => question.id === quiz.question.id)!.correctIndex;
}
async function payload(quiz: Quiz, correct = true) {
  const answer = await key(quiz);
  return { quizId: quiz.id, questionId: quiz.question.id, questionToken: quiz.questionToken, answer: correct ? answer : (answer + 1) % 4 };
}
async function answer(user: User, quiz: Quiz, correct = true) {
  return app.answerQuiz(user, await payload(quiz, correct));
}
async function qualify(user: User, purpose: BreakPurpose = 'restroom') {
  const first = await answer(user, await app.newQuiz(user, purpose));
  assert.equal(first.correctCount, 1);
  const final = await answer(user, first.quiz!);
  assert.equal(final.correctCount, 2);
  assert.equal(final.passed, true);
  assert.ok(final.visit);
  return final.visit;
}
async function counts(classroomId = classroom.id) {
  const { rows: [row] } = await db.query("SELECT COUNT(*) FILTER (WHERE status IN ('ready','out')) AS reserved, COUNT(*) FILTER (WHERE status='waiting') AS waiting FROM visits WHERE classroom_id=$1", [classroomId]);
  return { reserved: Number(row.reserved), waiting: Number(row.waiting) };
}
async function expireReservation(visitId: string) {
  await db.query("UPDATE visits SET ready_at=CURRENT_TIMESTAMP-INTERVAL '121 seconds',ready_expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1", [visitId]);
}

// All data stays in isolated in-memory databases; administrator credentials are
// generated for each fixture and never copied from deployment configuration.
describe('Sequential learning and fair student break reservations', { concurrency: false }, () => {
  before(async () => {
    db = await createDatabase({ directory: 'memory://', bootstrapAdmin: false });
    app = new WaterCycle(db);
  });
  beforeEach(async () => {
    await db.query('TRUNCATE rate_limits,sessions,quizzes,visits,questions,enrollments,users,classrooms CASCADE');
    await bootstrapAdministrator(db, randomBytes(32).toString('base64url'));
    administrator = userFrom((await db.query("SELECT * FROM users WHERE role='admin'")).rows[0]);
    teacher = await teacherFixture('breakteacher');
    otherTeacher = await teacherFixture('otherbreakteacher');
    classroom = await app.createClass(teacher, { name: 'Break biology', period: '1', code: 'bio01' });
  });
  after(async () => { await db?.close(); });

  it('normalizes letter codes, preserves numeric codes, and rejects global case-insensitive collisions', async () => {
    assert.equal(classroom.code, 'BIO01');
    const learner = await student('Lowercase', 'bIo01');
    assert.equal(learner.classroomId, classroom.id);
    await assert.rejects(() => app.createClass(otherTeacher, { name: 'Duplicate', code: 'BiO01' }), error => status(409)(error) || (error as { code?: string }).code === '23505');
    await assert.rejects(db.query('INSERT INTO classrooms(id,teacher_id,name,code) VALUES($1,$2,$3,$4)', [randomUUID(), otherTeacher.id, 'SQL duplicate', 'bio01']), error => (error as { code?: string }).code === '23505');
    for (const code of ['ABC1', 'ABC123', 'AB@12', 'éA123']) {
      await assert.rejects(() => app.createClass(teacher, { name: 'Invalid code', code }));
      await assert.rejects(() => student(`Invalid${code.replace(/[^a-z0-9]/gi, '')}`, code));
    }
    const numeric = await app.createClass(teacher, { name: 'Numeric compatibility', code: '00123' });
    assert.equal(numeric.code, '00123');
    assert.equal((await student('Numeric', '00123')).classroomId, numeric.id);
    await app.removeStudent(teacher, learner.id);
    await app.updateClass(teacher, classroom.id, { code: '9aBc2' });
    await app.enrollStudent(learner, '9abc2');
    assert.equal((await app.studentState(learner)).classroom?.code, '9ABC2');
  });

  it('requires a valid purpose before starting and cannot change the purpose of a pending attempt', async () => {
    const learner = await student('Purpose');
    for (const purpose of [undefined, null, '', 'bathroom', 'WATER']) {
      await assert.rejects(() => Reflect.apply(app.newQuiz, app, [learner, purpose]), status(400));
    }
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM quizzes')).rows[0].n), 0);
    const quiz = await app.newQuiz(learner, 'water');
    assert.equal(quiz.purpose, 'water');
    assert.equal(quiz.correctCount, 0);
    await assert.rejects(() => app.newQuiz(learner, 'restroom'), status(409));
    assert.deepEqual(await app.newQuiz(learner, 'water'), quiz);
    await app.cancelQuiz(learner, quiz.id);
    assert.equal((await app.studentState(learner)).activeQuiz, null);
    assert.equal((await app.newQuiz(learner, 'restroom')).purpose, 'restroom');
    await assert.rejects(() => answer(learner, quiz), status(409));
  });

  it('counts cumulative correct answers across wrong answers without restarting progress', async () => {
    const learner = await student('Cumulative');
    const first = await app.newQuiz(learner, 'water');
    const one = await answer(learner, first);
    assert.equal(one.correctCount, 1);
    assert.equal(one.passed, false);
    assert.equal(one.feedback[0].correct, true);
    const wrong = await answer(learner, one.quiz!, false);
    assert.equal(wrong.correctCount, 1);
    assert.equal(wrong.feedback[0].correct, false);
    assert.ok(wrong.feedback[0].explanation);
    assert.equal((await app.studentState(learner)).currentVisit, null);
    assert.equal(new Set([first.question.id, one.quiz!.question.id, wrong.quiz!.question.id]).size, 3);
    const passed = await answer(learner, wrong.quiz!);
    assert.equal(passed.correctCount, 2);
    assert.equal(passed.visit?.purpose, 'water');
    assert.equal(passed.visit?.status, 'out');
    assert.equal((await app.studentState(learner)).activeQuiz, null);
  });

  it('exhausts unused questions before recycling and finishes gracefully with a two-question bank', async () => {
    const learner = await student('Recycle');
    const { rows: [bank] } = await db.query('SELECT COUNT(*) AS n FROM questions WHERE classroom_id=$1 AND active=TRUE', [classroom.id]);
    let quiz = await app.newQuiz(learner, 'restroom');
    const seen = new Set<string>();
    for (let index = 0; index < Number(bank.n); index++) {
      assert.equal(seen.has(quiz.question.id), false, 'Unused snapshot questions must precede repeats');
      seen.add(quiz.question.id);
      const result = await answer(learner, quiz, false);
      assert.equal(result.correctCount, 0);
      quiz = result.quiz!;
    }
    assert.equal(seen.has(quiz.question.id), true);
    await app.cancelQuiz(learner, quiz.id);
    const all = (await app.teacherState(teacher, classroom.id)).questions;
    for (const question of all.slice(2)) await app.deleteQuestion(teacher, question.id, classroom.id);
    quiz = await app.newQuiz(learner, 'restroom');
    const originalId = quiz.question.id;
    const first = await answer(learner, quiz);
    assert.notEqual(first.quiz?.question.id, originalId);
    const wrong = await answer(learner, first.quiz!, false);
    assert.equal(wrong.quiz?.question.id, originalId);
    assert.equal(wrong.correctCount, 1);
    assert.equal((await answer(learner, wrong.quiz!)).passed, true);
  });

  it('restores the current question and progress after reload while retaining original question snapshots', async () => {
    const learner = await student('Reload');
    const quiz = await app.newQuiz(learner, 'water');
    const originalKey = await key(quiz);
    const storedQuestion = (await app.teacherState(teacher, classroom.id)).questions.find(question => question.id === quiz.question.id)!;
    await app.saveQuestion(teacher, { ...storedQuestion, prompt: 'Teacher edited the live prompt', correctIndex: (originalKey + 1) % 4 }, storedQuestion.id, classroom.id);
    const first = await answer(learner, quiz);
    assert.equal(first.correctCount, 1);
    const restored = await new WaterCycle(db).studentState(await app.login({ username: learner.username, password, role: 'student' }));
    assert.deepEqual(restored.activeQuiz, first.quiz);
    assert.equal(restored.activeQuiz?.purpose, 'water');
    assert.ok(Number.isFinite(Date.parse(restored.serverNow)));
    for (const question of (await app.teacherState(teacher, classroom.id)).questions) await app.deleteQuestion(teacher, question.id, classroom.id);
    assert.deepEqual(await app.newQuiz(learner, 'water'), first.quiz);
    assert.equal((await answer(learner, restored.activeQuiz!)).passed, true);
  });

  it('makes parallel identical answer retries idempotent and rejects changed or forged stale answers', async () => {
    const learner = await student('Replay');
    const stranger = await student('Stranger');
    const starts = await Promise.all(Array.from({ length: 8 }, () => app.newQuiz(learner, 'restroom')));
    assert.equal(new Set(starts.map(quiz => quiz.id)).size, 1);
    assert.equal(new Set(starts.map(quiz => quiz.questionToken)).size, 1);
    const quiz = starts[0];
    const submission = await payload(quiz);
    await assert.rejects(() => app.answerQuiz(stranger, submission), status(409));
    await assert.rejects(() => app.answerQuiz(learner, { ...submission, questionId: randomUUID() }), status(409));
    await assert.rejects(() => app.answerQuiz(learner, { ...submission, questionToken: randomUUID() }), status(409));
    await assert.rejects(() => app.answerQuiz(learner, { ...submission, answer: 4 }), status(400));
    const retries = await Promise.all(Array.from({ length: 12 }, () => app.answerQuiz(learner, submission)));
    assert.ok(retries.every(result => result.correctCount === 1 && !result.passed));
    assert.equal((await db.query('SELECT correct_count FROM quizzes WHERE id=$1', [quiz.id])).rows[0].correct_count, 1);
    await assert.rejects(() => app.answerQuiz(learner, { ...submission, answer: (submission.answer + 1) % 4 }), status(409));
    const current = (await app.studentState(learner)).activeQuiz!;
    const finalSubmission = await payload(current);
    const completed = await Promise.all(Array.from({ length: 12 }, () => app.answerQuiz(learner, finalSubmission)));
    assert.ok(completed.every(result => result.passed && result.correctCount === 2));
    assert.equal(new Set(completed.map(result => result.visit?.id)).size, 1);
    const oldReplay = await app.answerQuiz(learner, submission);
    assert.equal(oldReplay.visit?.id, completed[0].visit?.id);
    assert.equal(oldReplay.correctCount, 2);
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM visits WHERE student_id=$1', [learner.id])).rows[0].n), 1);
    await assert.rejects(() => app.newQuiz(learner, 'water'), status(409));
  });

  it('starts an immediately available break on the server and preserves purpose, timestamps, and reporting', async () => {
    const learner = await student('Immediate');
    const beforeStart = Date.now();
    const visit = await qualify(learner, 'water');
    assert.equal(visit.status, 'out');
    assert.equal(visit.purpose, 'water');
    assert.ok(visit.leftAt);
    assert.ok(Date.parse(visit.leftAt!) >= beforeStart && Date.parse(visit.leftAt!) <= Date.now());
    const refreshed = await new WaterCycle(db).studentState(learner);
    assert.equal(refreshed.currentVisit?.leftAt, visit.leftAt);
    assert.equal(refreshed.currentVisit?.purpose, 'water');
    await assert.rejects(() => app.studentAction(learner, 'cancel'), status(409));
    await assert.rejects(() => app.studentAction(learner, 'leave'), status(409));
    await app.studentAction(learner, 'return');
    const record = (await app.teacherState(teacher, classroom.id)).visits.find(item => item.id === visit.id)!;
    assert.equal(record.status, 'returned');
    assert.equal(record.leftAt, visit.leftAt);
    assert.ok(record.returnedAt && Date.parse(record.returnedAt) >= Date.parse(record.leftAt!));
    assert.match(await app.exportCsv(teacher, classroom.id), /water/i);
  });

  it('shares capacity across purposes, preserves FIFO, and starts queued timers only after departure', async () => {
    const [first, second, third, fourth, fifth] = await Promise.all(['First', 'Second', 'Third', 'Fourth', 'Fifth'].map(name => student(name)));
    await qualify(first, 'water');
    await qualify(second, 'restroom');
    const thirdVisit = await qualify(third, 'water');
    const fourthVisit = await qualify(fourth, 'restroom');
    assert.equal(thirdVisit.status, 'waiting');
    assert.equal(thirdVisit.leftAt, null);
    assert.equal(thirdVisit.readyAt, null);
    assert.equal(thirdVisit.readyExpiresAt, null);
    assert.equal((await app.studentState(third)).currentVisit?.position, 1);
    assert.equal((await app.studentState(fourth)).currentVisit?.position, 2);
    await assert.rejects(() => app.studentAction(third, 'leave'), status(409));
    await assert.rejects(() => app.newQuiz(third, 'water'), status(409));
    await app.studentAction(first, 'return');
    const reserved = (await app.studentState(third)).currentVisit!;
    assert.equal(reserved.status, 'ready');
    assert.equal(reserved.leftAt, null);
    assert.ok(reserved.readyAt && reserved.readyExpiresAt);
    assert.equal(Date.parse(reserved.readyExpiresAt!) - Date.parse(reserved.readyAt!), 120_000);
    const newcomer = await qualify(fifth);
    assert.equal(newcomer.status, 'waiting');
    assert.deepEqual(await counts(), { reserved: 2, waiting: 2 });
    await app.studentAction(third, 'leave');
    const out = (await app.studentState(third)).currentVisit!;
    assert.equal(out.status, 'out');
    assert.ok(out.leftAt && Date.parse(out.leftAt) >= Date.parse(reserved.readyAt!));
    assert.equal(out.purpose, 'water');
    await app.studentAction(fourth, 'cancel');
    assert.equal((await app.studentState(fifth)).currentVisit?.position, 1);
    assert.equal((await app.studentState(fourth)).recentVisits.find(visit => visit.id === fourthVisit.id)?.status, 'cancelled');
  });

  it('cancels a reserved turn without starting its timer and promotes the next waiting student', async () => {
    const learners = await Promise.all(['One', 'Two', 'Three', 'Four'].map(name => student(name)));
    for (const learner of learners) await qualify(learner);
    await app.studentAction(learners[0], 'return');
    const reserved = (await app.studentState(learners[2])).currentVisit!;
    await app.studentAction(learners[2], 'cancel');
    const cancelled = (await app.studentState(learners[2])).recentVisits.find(visit => visit.id === reserved.id)!;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.leftAt, null);
    assert.equal((await app.studentState(learners[3])).currentVisit?.status, 'ready');
    assert.deepEqual(await counts(), { reserved: 2, waiting: 0 });
  });

  it('returns a coherent queue snapshot when a concurrent return promotes the student mid-read', async () => {
    const [first, second, waiting] = await Promise.all(['SnapshotOne', 'SnapshotTwo', 'SnapshotWaiting'].map(name => student(name)));
    for (const learner of [first, second, waiting]) await qualify(learner);
    let signalVisitRead!: () => void;
    let releaseVisitRead!: () => void;
    const visitRead = new Promise<void>(resolve => { signalVisitRead = resolve; });
    const release = new Promise<void>(resolve => { releaseVisitRead = resolve; });
    let protectedByTransaction = false;
    let paused = false;
    async function interceptedQuery<T>(connection: SQL, inTransaction: boolean, sql: string, params: unknown[] = []) {
      const result = await connection.query<T>(sql, params);
      if (!paused && params[0] === waiting.id && sql.includes('WHERE v.student_id=$1 AND (v.status')) {
        paused = true;
        protectedByTransaction = inTransaction;
        signalVisitRead();
        await release;
      }
      return result;
    }
    const instrumented: Database = {
      query: <T>(sql: string, params?: unknown[]) => interceptedQuery<T>(db, false, sql, params),
      transaction: <T>(callback: (tx: SQL) => Promise<T>) => db.transaction(tx => callback({ query: <R>(sql: string, params?: unknown[]) => interceptedQuery<R>(tx, true, sql, params) })),
      close: () => db.close(),
    };
    const pendingSnapshot = new WaterCycle(instrumented).studentState(waiting);
    await visitRead;
    const returning = app.studentAction(first, 'return');
    // In PGlite a held read transaction blocks the writer. An unprotected
    // snapshot lets it finish between the visit read and queue-position read.
    try {
      if (!protectedByTransaction) await returning;
    } finally {
      releaseVisitRead();
    }
    const snapshot = await pendingSnapshot;
    await returning;
    assert.equal(snapshot.currentVisit?.status, 'waiting');
    assert.equal(snapshot.currentVisit?.position, 1);
    assert.equal(snapshot.currentVisit?.leftAt, null);
    assert.equal(snapshot.activeCount, 2);
    assert.equal(snapshot.waitingCount, 1);
    const promoted = await app.studentState(waiting);
    assert.equal(promoted.currentVisit?.status, 'ready');
    assert.equal(promoted.currentVisit?.leftAt, null);
    assert.equal(promoted.activeCount, 2);
    assert.equal(promoted.waitingCount, 0);
  });

  it('reaps expired reservations through student, teacher, and administrator polling and keeps FIFO', async () => {
    const modes = ['student', 'teacher', 'administrator', 'class-detail'] as const;
    for (const [index, mode] of modes.entries()) {
      const target = await app.createClass(teacher, { name: `Timeout ${mode}`, code: `EXP0${index}` });
      const learners = await Promise.all(['One', 'Two', 'Three', 'Four', 'Observer'].map(name => student(`${mode.replace('-', '')}${name}`, target.code!)));
      for (const learner of learners.slice(0, 4)) await qualify(learner);
      await app.studentAction(learners[0], 'return');
      const timedOut = (await app.studentState(learners[2])).currentVisit!;
      await expireReservation(timedOut.id);
      if (mode === 'student') await app.studentState(learners[4]);
      else if (mode === 'teacher') await app.teacherState(teacher, target.id);
      else if (mode === 'administrator') await app.adminState(administrator);
      else await app.adminClass(administrator, target.id);
      const { rows: [expired] } = await db.query('SELECT status,left_at FROM visits WHERE id=$1', [timedOut.id]);
      assert.equal(expired.status, 'cancelled', `${mode} polling must release abandoned turns`);
      assert.equal(expired.left_at, null);
      const promoted = (await app.studentState(learners[3])).currentVisit!;
      assert.equal(promoted.status, 'ready');
      assert.equal(promoted.leftAt, null);
      assert.deepEqual(await counts(target.id), { reserved: 2, waiting: 0 });
      await assert.rejects(() => app.studentAction(learners[2], 'leave'), status(409));
      const newcomer = await qualify(learners[4]);
      assert.equal(newcomer.status, 'waiting');
      assert.equal((await app.studentState(learners[3])).currentVisit?.id, promoted.id);
    }
  });

  it('commits timeout promotion even when an expired student attempts a late departure', async () => {
    const learners = await Promise.all(['LateOne', 'LateTwo', 'LateThree', 'LateFour'].map(name => student(name)));
    for (const learner of learners) await qualify(learner);
    await app.studentAction(learners[0], 'return');
    const reserved = (await app.studentState(learners[2])).currentVisit!;
    await expireReservation(reserved.id);
    await assert.rejects(() => app.studentAction(learners[2], 'leave'), status(409));
    const rows = (await db.query('SELECT student_id,status,left_at FROM visits WHERE student_id=ANY($1::text[])', [[learners[2].id, learners[3].id]])).rows;
    assert.equal(rows.find(row => row.student_id === learners[2].id)?.status, 'cancelled');
    assert.equal(rows.find(row => row.student_id === learners[3].id)?.status, 'ready');
    assert.ok(rows.every(row => row.left_at === null));
  });

  it('serializes timeout polling, a return, and a newly qualified request without bypassing earlier waiters', async () => {
    const learners = await Promise.all(['RaceOne', 'RaceTwo', 'RaceThree', 'RaceFour', 'RaceFive', 'RaceNewcomer'].map(name => student(name)));
    for (const learner of learners.slice(0, 5)) await qualify(learner);
    await app.studentAction(learners[0], 'return');
    const expired = (await app.studentState(learners[2])).currentVisit!;
    await expireReservation(expired.id);
    await Promise.all([
      app.studentState(learners[5]), app.teacherState(teacher, classroom.id),
      app.adminState(administrator), app.adminClass(administrator, classroom.id),
      app.studentAction(learners[1], 'return'), qualify(learners[5], 'water'),
    ]);
    const states = await Promise.all(learners.slice(2).map(learner => app.studentState(learner)));
    assert.equal(states[0].currentVisit, null);
    assert.deepEqual(states.slice(1).map(state => state.currentVisit?.status), ['ready', 'ready', 'waiting']);
    assert.equal(states[3].currentVisit?.position, 1);
    assert.ok(states.slice(1).every(state => state.currentVisit?.leftAt === null));
    assert.deepEqual(await counts(), { reserved: 2, waiting: 1 });
  });

  it('serializes simultaneous returns and departures without allocating any reservation twice', async () => {
    const learners = await Promise.all(['ConcurrentOne', 'ConcurrentTwo', 'ConcurrentThree', 'ConcurrentFour', 'ConcurrentFive', 'ConcurrentSix'].map(name => student(name)));
    for (const learner of learners) await qualify(learner);
    const returns = await Promise.allSettled([learners[0], learners[0], learners[1], learners[1]].map(learner => app.studentAction(learner, 'return')));
    assert.equal(returns.filter(result => result.status === 'fulfilled').length, 2);
    for (const result of returns) if (result.status === 'rejected') assert.ok(status(409)(result.reason));
    assert.deepEqual(await counts(), { reserved: 2, waiting: 2 });
    const states = await Promise.all(learners.slice(2).map(learner => app.studentState(learner)));
    assert.deepEqual(states.map(state => state.currentVisit?.status), ['ready', 'ready', 'waiting', 'waiting']);
    const departures = await Promise.allSettled([learners[2], learners[2], learners[3], learners[3]].map(learner => app.studentAction(learner, 'leave')));
    assert.equal(departures.filter(result => result.status === 'fulfilled').length, 2);
    assert.deepEqual(await counts(), { reserved: 2, waiting: 2 });
    assert.equal((await app.teacherState(teacher, classroom.id)).stats.out, 2);
  });

  it('persists one warning acknowledgement per overdue break without restricting or ending repeated long trips', async () => {
    const learner = await student('LongBreak');
    const stranger = await student('OtherLongBreak');
    const token = await createSession(db, learner.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const visit = await qualify(learner, attempt ? 'water' : 'restroom');
      await assert.rejects(() => app.acknowledgeWarning(learner, visit.id), status(409));
      await db.query("UPDATE visits SET left_at=CURRENT_TIMESTAMP-INTERVAL '13 minutes' WHERE id=$1", [visit.id]);
      await assert.rejects(() => app.acknowledgeWarning(stranger, visit.id), status(409));
      await app.acknowledgeWarning(learner, visit.id);
      const warned = (await app.studentState(learner)).currentVisit!;
      assert.equal(warned.status, 'out');
      assert.ok(warned.warningAcknowledgedAt);
      assert.ok(Date.parse(warned.leftAt!) < Date.now() - 12 * 60_000);
      await app.acknowledgeWarning(learner, visit.id);
      const refreshed = (await new WaterCycle(db).studentState(learner)).currentVisit!;
      assert.equal(refreshed.warningAcknowledgedAt, warned.warningAcknowledgedAt);
      assert.equal(refreshed.leftAt, warned.leftAt);
      assert.equal((await sessionUser(db, token))?.id, learner.id);
      assert.equal((await db.query('SELECT enabled FROM users WHERE id=$1', [learner.id])).rows[0].enabled, true);
      await app.studentAction(learner, 'return');
      await assert.rejects(() => app.acknowledgeWarning(learner, visit.id), status(409));
      assert.equal((await app.studentState(learner)).canRequestPass, true);
    }
    const detail = await app.rosterDetail(teacher, learner.id, classroom.id);
    assert.equal(detail.visits.length, 2);
    assert.ok(detail.visits.every(visit => visit.status === 'returned' && visit.warningAcknowledgedAt && Date.parse(visit.returnedAt!) - Date.parse(visit.leftAt!) > 12 * 60_000));
    assert.ok((await app.teacherState(teacher, classroom.id)).stats.averageMinutes >= 13);
    await app.updateRoster(teacher, learner.id, { enabled: false });
    assert.equal((await sessionUser(db, token))?.accountStatus,'deactivated');
  });

  it('shows tutorial eligibility only for new signups or newly claimed roster accounts and saves completion', async () => {
    const learner = await student('Tutorial');
    assert.equal(learner.tutorialCompleted, false);
    assert.equal((await app.studentState(learner)).user.tutorialCompleted, false);
    await app.completeTutorial(learner);
    await app.completeTutorial(learner);
    const loggedIn = await app.login({ username: learner.username, password, role: 'student' });
    assert.equal(loggedIn.tutorialCompleted, true);
    assert.equal((await app.studentState(learner)).user.tutorialCompleted, true, 'Reload must read persisted completion even with an older User object');
    const roster = await app.addRoster(teacher, { firstName: 'Claimed', lastName: 'Learner' }, classroom.id);
    const claimed = await student('Claimed');
    assert.equal(claimed.id, roster.id);
    assert.equal(claimed.tutorialCompleted, false);
    await app.completeTutorial(claimed);
    await app.removeStudent(teacher, claimed.id);
    const unenrolled = await app.login({ username: claimed.username, password, role: 'student' });
    await app.enrollStudent(unenrolled, classroom.code!);
    assert.equal((await app.studentState(unenrolled)).user.tutorialCompleted, true);
    const { rows: [legacy] } = await db.query("INSERT INTO users(id,role,first_name,last_name,username,password_hash) VALUES($1,'student','Existing','Learner','existinglearner',$2) RETURNING *", [randomUUID(), await hashPassword(password)]);
    assert.equal(userFrom(legacy).tutorialCompleted, true);
    await assert.rejects(() => app.completeTutorial(teacher), status(403));
  });
});
