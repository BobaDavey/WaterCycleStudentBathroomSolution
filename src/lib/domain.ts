import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, SQL } from './db';
import { AppError, hashPassword, safeEqual, userFrom, usernameFor, verifyPassword } from './auth';
import type { Classroom, Question, Quiz, QuizResult, RosterStudent, StudentState, TeacherState, User, Visit } from './contracts';
import { defaultQuestions } from './default-questions';

const name = z.string().trim().min(1, 'Please enter a name.').max(50);
const password = z.string().min(8, 'Passwords must have at least 8 characters.').max(128);
export const loginSchema = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(128), role: z.enum(['student','teacher']) });
export const signupSchema = z.object({ firstName: name, lastName: name, password, classroomCode: z.string().trim().min(1).max(20) });
export const setupSchema = z.object({ firstName: name, lastName: name, username: z.string().trim().regex(/^[a-zA-Z0-9]{3,100}$/, 'Use 3–100 letters and numbers for the username.'), password, classroomName: z.string().trim().min(1).max(100), setupKey: z.string().min(1).max(256) });
export const questionSchema = z.object({ prompt: z.string().trim().min(8).max(1000), options: z.array(z.string().trim().min(1).max(300)).length(4), correctIndex: z.number().int().min(0).max(3), topic: z.string().trim().min(1).max(80), explanation: z.string().trim().max(2000).default(''), active: z.boolean().default(true) }).refine(q => new Set(q.options.map(s => s.toLowerCase())).size === 4, { message: 'Each answer option must be different.' });
export const rosterSchema = z.object({ firstName: name, lastName: name });
export const rosterUpdateSchema = z.object({ enabled: z.boolean().optional(), password: password.optional() }).refine(v => v.enabled !== undefined || v.password !== undefined, 'Choose a change.');
export const passwordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
export const classroomSchema = z.object({ name: z.string().trim().min(1).max(100), regenerateCode: z.boolean().optional() });
export const submitSchema = z.object({ quizId: z.string().uuid(), answers: z.array(z.number().int().min(0).max(3)).length(2) });

type Row = Record<string, unknown>;
function iso(value: unknown): string | null { return value ? new Date(value as string | Date).toISOString() : null; }
function classroomFrom(row: Row): Classroom { return { id: String(row.id), name: String(row.name), code: String(row.code), capacity: Number(row.capacity) }; }
function questionFrom(row: Row): Question { return { id: String(row.id), prompt: String(row.prompt), options: row.options as string[], correctIndex: Number(row.correct_index), topic: String(row.topic), explanation: String(row.explanation), active: Boolean(row.active) }; }
function visitFrom(row: Row): Visit { return { id: String(row.id), studentId: String(row.student_id), studentName: `${row.first_name} ${row.last_name}`, status: row.status as Visit['status'], requestedAt: iso(row.requested_at)!, readyAt: iso(row.ready_at), leftAt: iso(row.left_at), returnedAt: iso(row.returned_at) }; }
function rosterFrom(row: Row): RosterStudent { return { id: String(row.id), firstName: String(row.first_name), lastName: String(row.last_name), username: String(row.username), enabled: Boolean(row.enabled), registered: Boolean(row.password_hash), mustChangePassword: Boolean(row.must_change_password), visitsToday: Number(row.visits_today || 0) }; }
function classCode() { return randomBytes(4).toString('hex').toUpperCase(); }
function assertStudent(user: User) { if (user.role !== 'student') throw new AppError(403, 'This action is for students.'); }
function assertTeacher(user: User) { if (user.role !== 'teacher') throw new AppError(403, 'Teacher access required.'); }
export function requirePasswordChange(user: User) { if (user.mustChangePassword) throw new AppError(403, 'Please change your temporary password before continuing.'); }
async function lockClass(tx: SQL, classroomId: string) { await tx.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE', [classroomId]); }
async function checkStudentAccess(tx: SQL, user: User) {
 const { rows: [current] } = await tx.query("SELECT enabled,must_change_password FROM users WHERE id=$1 AND classroom_id=$2 AND role='student'", [user.id,user.classroomId]);
 if (!current?.enabled) throw new AppError(401,'Your account is unavailable. Please contact your teacher.');
 if (current.must_change_password) throw new AppError(403,'Please change your temporary password before continuing.');
}
async function promote(tx: SQL, classroomId: string) {
 const { rows: [count] } = await tx.query('SELECT COUNT(*) AS n FROM visits WHERE classroom_id=$1 AND status IN (\'ready\',\'out\')', [classroomId]);
 const slots = Math.max(0, 2 - Number(count.n));
 if (slots) await tx.query(`UPDATE visits SET status='ready',ready_at=CURRENT_TIMESTAMP WHERE id IN (SELECT id FROM visits WHERE classroom_id=$1 AND status='waiting' ORDER BY requested_at,id LIMIT $2)`, [classroomId, slots]);
}
const visitSelect = 'SELECT v.*,u.first_name,u.last_name FROM visits v JOIN users u ON u.id=v.student_id';

export class WaterCycle {
 constructor(readonly db: Database) {}
 async login(input: z.infer<typeof loginSchema>, connection: SQL = this.db): Promise<User> {
  const { rows: [row] } = await connection.query('SELECT * FROM users WHERE username=$1 AND role=$2 FOR UPDATE', [input.username.toLowerCase(), input.role]);
  if (!await verifyPassword(input.password, row?.password_hash as string | null) || !row?.enabled) throw new AppError(401, 'The username or password is incorrect.');
  return userFrom(row);
 }
 async setup(input: z.infer<typeof setupSchema>): Promise<User> {
  if (!process.env.TEACHER_SETUP_KEY || !safeEqual(input.setupKey, process.env.TEACHER_SETUP_KEY)) throw new AppError(403, 'The teacher setup key is incorrect or has not been configured.');
  const hash = await hashPassword(input.password);
  return this.db.transaction(async tx => {
   // Serialize first-run setup across serverless instances.
   await tx.query('LOCK TABLE users IN EXCLUSIVE MODE');
   const { rows } = await tx.query("SELECT id FROM users WHERE role='teacher' LIMIT 1");
   if (rows.length) throw new AppError(409, 'The teacher account is already set up. Please sign in.');
   const classroomId = randomUUID();
   await tx.query('INSERT INTO classrooms(id,name,code) VALUES($1,$2,$3)', [classroomId,input.classroomName,classCode()]);
   const { rows: [teacher] } = await tx.query(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id) VALUES($1,'teacher',$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(),input.firstName,input.lastName,input.username.toLowerCase(),hash,classroomId]);
   await this.seedQuestions(tx,classroomId);
   return userFrom(teacher);
  });
 }
 async seedQuestions(tx: SQL, classroomId: string) {
  for (const q of defaultQuestions) await tx.query('INSERT INTO questions(id,classroom_id,prompt,options,correct_index,topic,explanation,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(),classroomId,q.prompt,JSON.stringify(q.options),q.correctIndex,q.topic,q.explanation,q.active]);
 }
 async signup(input: z.infer<typeof signupSchema>): Promise<User> {
  const username = usernameFor(input.firstName,input.lastName);
  if (username.length < 2) throw new AppError(400, 'Your first and last name must form a username with at least two letters or numbers. Ask your teacher for help.');
  const hash = await hashPassword(input.password);
  return this.db.transaction(async tx => {
   const { rows: [classroom] } = await tx.query('SELECT * FROM classrooms WHERE code=$1 FOR UPDATE', [input.classroomCode.toUpperCase()]);
   if (!classroom) throw new AppError(400, 'That classroom code was not found. Check with your teacher.');
   const { rows: [existing] } = await tx.query('SELECT * FROM users WHERE username=$1 FOR UPDATE', [username]);
   if (existing) {
    if (existing.role !== 'student' || existing.classroom_id !== classroom.id || existing.password_hash || !existing.enabled) throw new AppError(409, 'This username is already registered or unavailable. Ask your teacher for help.');
    const { rows: [claimed] } = await tx.query('UPDATE users SET password_hash=$1,first_name=$2,last_name=$3 WHERE id=$4 RETURNING *', [hash,input.firstName,input.lastName,existing.id]);
    return userFrom(claimed);
   }
   const { rows: [student] } = await tx.query(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id) VALUES($1,'student',$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(),input.firstName,input.lastName,username,hash,classroom.id]);
   return userFrom(student);
  });
 }
 async changePassword(user: User, currentPassword: string, newPassword: string) {
  const hash = await hashPassword(newPassword);
  await this.db.transaction(async tx => {
   const { rows: [row] } = await tx.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE',[user.id]);
   if (!await verifyPassword(currentPassword,row?.password_hash as string)) throw new AppError(400,'Your current password is incorrect.');
   await tx.query('UPDATE users SET password_hash=$1,must_change_password=FALSE WHERE id=$2',[hash,user.id]);
   await tx.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);
  });
 }
 async studentState(user: User): Promise<StudentState> {
  assertStudent(user);
  const [{ rows: [classroom] }, { rows: visits }, { rows: [counts] }, { rows: [questions] }] = await Promise.all([
   this.db.query('SELECT * FROM classrooms WHERE id=$1',[user.classroomId]),
   this.db.query(`${visitSelect} WHERE v.student_id=$1 ORDER BY v.requested_at DESC LIMIT 100`,[user.id]),
   this.db.query(`SELECT COUNT(*) FILTER(WHERE status IN ('ready','out')) AS active,COUNT(*) FILTER(WHERE status='waiting') AS waiting FROM visits WHERE classroom_id=$1`,[user.classroomId]),
   this.db.query('SELECT COUNT(*) AS n FROM questions WHERE classroom_id=$1 AND active=TRUE AND deleted=FALSE',[user.classroomId])
  ]);
  const currentRow = visits.find(row => ['waiting','ready','out'].includes(String(row.status)));
  const currentVisit = currentRow ? visitFrom(currentRow) : null;
  if (currentVisit?.status === 'waiting') {
   const { rows: waiting } = await this.db.query("SELECT id FROM visits WHERE classroom_id=$1 AND status='waiting' ORDER BY requested_at,id",[user.classroomId]);
   currentVisit.position = waiting.findIndex(row => row.id === currentVisit.id) + 1;
  }
  return { user,classroom:classroomFrom(classroom),currentVisit,activeCount:Number(counts.active),waitingCount:Number(counts.waiting),recentVisits:visits.filter(v => ['returned','cancelled'].includes(String(v.status))).slice(0,10).map(visitFrom),availableQuestions:Number(questions.n) };
 }
 async newQuiz(user: User): Promise<Quiz> {
  assertStudent(user); requirePasswordChange(user);
  return this.db.transaction(async tx => {
   await lockClass(tx,user.classroomId);
   await checkStudentAccess(tx,user);
   const { rows: active } = await tx.query("SELECT id FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out')",[user.id]);
   if (active.length) throw new AppError(409,'You already have a bathroom pass or a place in line.');
   const { rows } = await tx.query('SELECT * FROM questions WHERE classroom_id=$1 AND active=TRUE AND deleted=FALSE ORDER BY RANDOM() LIMIT 2',[user.classroomId]);
   if (rows.length !== 2) throw new AppError(409,'Your teacher needs to add at least two active questions before passes are available.');
   const questions = rows.map(questionFrom);
   await tx.query('UPDATE quizzes SET used=TRUE WHERE student_id=$1 AND used=FALSE',[user.id]);
   const id = randomUUID();
   await tx.query('INSERT INTO quizzes(id,student_id,questions,expires_at) VALUES($1,$2,$3,$4)',[id,user.id,JSON.stringify(questions),new Date(Date.now()+15*60000).toISOString()]);
   return { id,questions: questions.map(q => ({ id:q.id,prompt:q.prompt,options:q.options,topic:q.topic })) };
  });
 }
 async submitQuiz(user: User, quizId: string, answers: number[]): Promise<QuizResult> {
  assertStudent(user); requirePasswordChange(user);
  return this.db.transaction(async tx => {
   await lockClass(tx,user.classroomId);
   await checkStudentAccess(tx,user);
   const { rows: [quiz] } = await tx.query('SELECT * FROM quizzes WHERE id=$1 AND student_id=$2 FOR UPDATE',[quizId,user.id]);
   if (!quiz || quiz.used || new Date(quiz.expires_at as string).getTime() <= Date.now()) throw new AppError(409,'This quiz has expired or was already submitted. Start a fresh quiz.');
   await tx.query('UPDATE quizzes SET used=TRUE WHERE id=$1',[quizId]);
   const questions = quiz.questions as Question[];
   const feedback = questions.map((q,i) => ({ questionId:q.id,correct:answers[i] === q.correctIndex,explanation:q.explanation }));
   const correctCount = feedback.filter(f => f.correct).length;
   if (correctCount !== 2) return { passed:false,correctCount,feedback };
   const { rows: active } = await tx.query("SELECT id FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out')",[user.id]);
   if (active.length) throw new AppError(409,'You already have a bathroom pass.');
   const id = randomUUID();
   await tx.query("INSERT INTO visits(id,classroom_id,student_id,status) VALUES($1,$2,$3,'waiting')",[id,user.classroomId,user.id]);
   await promote(tx,user.classroomId);
   const { rows: [visit] } = await tx.query(`${visitSelect} WHERE v.id=$1`,[id]);
   return { passed:true,correctCount,feedback,visit:visitFrom(visit) };
  });
 }
 async studentAction(user: User, action: 'leave' | 'return' | 'cancel') {
  assertStudent(user); requirePasswordChange(user);
  await this.db.transaction(async tx => {
   await lockClass(tx,user.classroomId);
   await checkStudentAccess(tx,user);
   const { rows: [visit] } = await tx.query("SELECT * FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out') FOR UPDATE",[user.id]);
   if (!visit) throw new AppError(409,'You do not have an active bathroom pass.');
   if (action === 'leave') {
    if (visit.status !== 'ready') throw new AppError(409,'Please wait for your turn before leaving.');
    await tx.query("UPDATE visits SET status='out',left_at=CURRENT_TIMESTAMP WHERE id=$1",[visit.id]);
   } else if (action === 'return') {
    if (visit.status !== 'out') throw new AppError(409,'You can record your return after you have left.');
    await tx.query("UPDATE visits SET status='returned',returned_at=CURRENT_TIMESTAMP WHERE id=$1",[visit.id]);
   } else {
    if (visit.status === 'out') throw new AppError(409,'Use I’m back to finish your current trip.');
    await tx.query("UPDATE visits SET status='cancelled' WHERE id=$1",[visit.id]);
   }
   await promote(tx,user.classroomId);
  });
 }
 async teacherState(user: User): Promise<TeacherState> {
  assertTeacher(user);
  const [{rows:[classroom]},{rows:students},{rows:questions},{rows:visits},{rows:[stats]}] = await Promise.all([
   this.db.query('SELECT * FROM classrooms WHERE id=$1',[user.classroomId]),
   this.db.query(`SELECT u.*, (SELECT COUNT(*) FROM visits v WHERE v.student_id=u.id AND v.left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS visits_today FROM users u WHERE u.classroom_id=$1 AND u.role='student' ORDER BY u.last_name,u.first_name`,[user.classroomId]),
   this.db.query('SELECT * FROM questions WHERE classroom_id=$1 AND deleted=FALSE ORDER BY topic,prompt',[user.classroomId]),
   this.db.query(`${visitSelect} WHERE v.classroom_id=$1 AND (v.status IN ('waiting','ready','out') OR v.id IN (SELECT id FROM visits WHERE classroom_id=$1 AND status IN ('returned','cancelled') ORDER BY requested_at DESC LIMIT 1000)) ORDER BY v.requested_at DESC`,[user.classroomId]),
   this.db.query(`SELECT COUNT(*) FILTER(WHERE status='out') AS out,COUNT(*) FILTER(WHERE status='ready') AS ready,COUNT(*) FILTER(WHERE status='waiting') AS waiting,COUNT(*) FILTER(WHERE left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS trips_today,AVG(EXTRACT(EPOCH FROM (returned_at-left_at))/60) FILTER(WHERE status='returned' AND left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS average_minutes FROM visits WHERE classroom_id=$1`,[user.classroomId])
  ]);
  const visitModels = visits.map(visitFrom);
  const waiting = [...visitModels].filter(v=>v.status==='waiting').sort((a,b)=>a.requestedAt.localeCompare(b.requestedAt)||a.id.localeCompare(b.id));
  waiting.forEach((v,i)=>{v.position=i+1;});
  return {user,classroom:classroomFrom(classroom),students:students.map(rosterFrom),questions:questions.map(questionFrom),visits:visitModels,stats:{out:Number(stats.out),ready:Number(stats.ready),waiting:Number(stats.waiting),tripsToday:Number(stats.trips_today),averageMinutes:Number(stats.average_minutes || 0)}};
 }
 async addRoster(user: User, input: z.infer<typeof rosterSchema>): Promise<RosterStudent> {
  assertTeacher(user); requirePasswordChange(user);
  const username = usernameFor(input.firstName,input.lastName);
  if (username.length < 2) throw new AppError(400,'The first and last name must form a username with at least two letters or numbers.');
  const {rows:[student]} = await this.db.query(`INSERT INTO users(id,role,first_name,last_name,username,classroom_id) VALUES($1,'student',$2,$3,$4,$5) RETURNING *`,[randomUUID(),input.firstName,input.lastName,username,user.classroomId]);
  return rosterFrom(student);
 }
 async updateRoster(user: User, id: string, input: z.infer<typeof rosterUpdateSchema>) {
  assertTeacher(user); requirePasswordChange(user);
  const hash = input.password ? await hashPassword(input.password) : undefined;
  await this.db.transaction(async tx => {
   await lockClass(tx,user.classroomId);
   const {rows:[student]} = await tx.query("SELECT * FROM users WHERE id=$1 AND classroom_id=$2 AND role='student' FOR UPDATE",[id,user.classroomId]);
   if (!student) throw new AppError(404,'Student not found.');
   if (input.enabled !== undefined) await tx.query('UPDATE users SET enabled=$1 WHERE id=$2',[input.enabled,id]);
   if (hash) await tx.query('UPDATE users SET password_hash=$1,must_change_password=TRUE WHERE id=$2',[hash,id]);
   if (input.enabled === false || hash) await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);
   if (input.enabled === false) {
    await tx.query("UPDATE visits SET status=CASE WHEN status='out' THEN 'returned' ELSE 'cancelled' END,returned_at=CASE WHEN status='out' THEN CURRENT_TIMESTAMP ELSE returned_at END WHERE student_id=$1 AND status IN ('waiting','ready','out')",[id]);
    await promote(tx,user.classroomId);
   }
  });
 }
 async saveQuestion(user: User, input: z.infer<typeof questionSchema>, id?: string): Promise<Question | void> {
  assertTeacher(user); requirePasswordChange(user);
  if (id) {
   const {rows} = await this.db.query('UPDATE questions SET prompt=$1,options=$2,correct_index=$3,topic=$4,explanation=$5,active=$6 WHERE id=$7 AND classroom_id=$8 AND deleted=FALSE RETURNING id',[input.prompt,JSON.stringify(input.options),input.correctIndex,input.topic,input.explanation,input.active,id,user.classroomId]);
   if (!rows.length) throw new AppError(404,'Question not found.');
   return;
  }
  const {rows:[row]} = await this.db.query('INSERT INTO questions(id,classroom_id,prompt,options,correct_index,topic,explanation,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),user.classroomId,input.prompt,JSON.stringify(input.options),input.correctIndex,input.topic,input.explanation,input.active]);
  return questionFrom(row);
 }
 async deleteQuestion(user: User, id: string) {
  assertTeacher(user); requirePasswordChange(user);
  const {rows} = await this.db.query('UPDATE questions SET active=FALSE,deleted=TRUE WHERE id=$1 AND classroom_id=$2 RETURNING id',[id,user.classroomId]);
  if (!rows.length) throw new AppError(404,'Question not found.');
 }
 async teacherVisit(user: User, id: string, action:'return'|'cancel') {
  assertTeacher(user); requirePasswordChange(user);
  await this.db.transaction(async tx => {
   await lockClass(tx,user.classroomId);
   const {rows:[visit]} = await tx.query('SELECT * FROM visits WHERE id=$1 AND classroom_id=$2 FOR UPDATE',[id,user.classroomId]);
   if (!visit) throw new AppError(404,'Pass not found.');
   if (action === 'return') {
    if (visit.status !== 'out') throw new AppError(409,'This student is not currently out.');
    await tx.query("UPDATE visits SET status='returned',returned_at=CURRENT_TIMESTAMP WHERE id=$1",[id]);
   } else {
    if (!['ready','waiting'].includes(String(visit.status))) throw new AppError(409,'Only a queued or ready pass can be cancelled.');
    await tx.query("UPDATE visits SET status='cancelled' WHERE id=$1",[id]);
   }
   await promote(tx,user.classroomId);
  });
 }
 async updateClassroom(user: User, input:z.infer<typeof classroomSchema>):Promise<Classroom> {
  assertTeacher(user); requirePasswordChange(user);
  const {rows:[row]} = await this.db.query('UPDATE classrooms SET name=$1,code=CASE WHEN $2 THEN $3 ELSE code END WHERE id=$4 RETURNING *',[input.name,Boolean(input.regenerateCode),classCode(),user.classroomId]);
  return classroomFrom(row);
 }
 async exportCsv(user:User):Promise<string> {
  assertTeacher(user);
  const {rows} = await this.db.query(`${visitSelect} WHERE v.classroom_id=$1 ORDER BY v.requested_at DESC`,[user.classroomId]);
  const cell = (v:unknown) => { let text=String(v??''); if (/^[=+\-@\t\r]/.test(text)) text=`'${text}`; return `"${text.replaceAll('"','""')}"`; };
  return [['Student','Status','Requested (UTC)','Left (UTC)','Returned (UTC)','Minutes'],...rows.map(r=>[`${r.first_name} ${r.last_name}`,r.status,iso(r.requested_at),iso(r.left_at),iso(r.returned_at),r.left_at&&r.returned_at?((new Date(r.returned_at as string).getTime()-new Date(r.left_at as string).getTime())/60000).toFixed(1):''])].map(r=>r.map(cell).join(',')).join('\r\n');
 }
}
