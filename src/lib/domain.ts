import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, SQL } from './db';
import { AppError, hashPassword, userFrom, usernameFor, verifyPassword } from './auth';
import { ADMIN_USERNAME } from './bootstrap-admin';
import type { BreakPurpose, AdminState, AdminStudent, ClassDetail, Classroom, Question, Quiz, QuizResult, RosterStudent, StudentDetail, StudentState, TeacherAccount, TeacherState, User, Visit } from './contracts';
import { defaultQuestions } from './default-questions';
import { submitProblemReport, listProblemReports, problemReportDetail, updateProblemReport, type ReportInput, type ReportFilters } from './problem-reports';
import { loadRuleOffenders, type RuleOffendersFilters } from './rule-offenders';

const name = z.string().trim().min(1, 'Please enter a name.').max(50);
const password = z.string().min(8, 'Passwords must have at least 8 characters.').max(128);
const username = z.string().trim().min(2).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._@+\-]*$/, 'Use letters, numbers, or an email address for the username.').transform(v => v.toLowerCase()).refine(v => v !== ADMIN_USERNAME, 'That username is reserved for the administrator.');
const email = z.union([z.email().max(254), z.literal(''), z.null()]).transform(v => v || null).optional();
const code = z.string().regex(/^[A-Za-z0-9]{5}$/, 'Enrollment codes must contain exactly five English letters or numbers.').transform(value => value.toUpperCase());
const className = z.string().trim().min(1, 'Please enter a class name.').max(100);
const period = z.string().trim().max(50).optional();
const timeZone = z.string().trim().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; } catch { return false; } }, 'Choose a valid IANA timezone, such as America/New_York.');
export const loginSchema = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(128), role: z.enum(['student','teacher','admin']) });
export const signupSchema = z.object({ firstName: name, lastName: name, username: username.optional(), password, classroomCode: code });
export const enrollmentSchema = z.object({ classroomCode: code });
export const setupSchema = z.object({}).passthrough();
export const classCreateSchema = z.object({ name: className, period, code, timeZone: timeZone.optional() });
export const classUpdateSchema = z.object({ name: className.optional(), period: z.union([z.string().trim().max(50), z.null()]).optional(), code: code.optional(), archived: z.boolean().optional(), timeZone: timeZone.optional() }).refine(v => Object.keys(v).length > 0, 'Choose a change.');
export const classroomSchema = classUpdateSchema;
export const questionSchema = z.object({ prompt: z.string().trim().min(8).max(1000), options: z.array(z.string().trim().min(1).max(300)).length(4), correctIndex: z.number().int().min(0).max(3), topic: z.string().trim().min(1).max(80), explanation: z.string().trim().max(2000).default(''), active: z.boolean().default(true) }).refine(q => new Set(q.options.map(s => s.toLowerCase())).size === 4, { message: 'Each answer option must be different.' });
export const rosterSchema = z.object({ firstName: name, lastName: name });
export const rosterUpdateSchema = z.object({ enabled: z.boolean().optional(), accountStatus: z.enum(['active','deactivated']).optional(), password: password.optional() }).refine(v => v.enabled !== undefined || v.accountStatus !== undefined || v.password !== undefined, 'Choose a change.');
export const transferSchema = z.object({ classroomId: z.string().uuid() });
export const passwordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
export const submitSchema = z.object({ quizId: z.string().uuid(), answers: z.array(z.number().int().min(0).max(3)).length(2) });
export const teacherCreateSchema = z.object({ firstName: name, lastName: name, username, email, password, enabled: z.boolean().default(true) });
export const teacherUpdateSchema = z.object({ firstName: name.optional(), lastName: name.optional(), username: username.optional(), email, password: password.optional(), enabled: z.boolean().optional() }).refine(v => Object.values(v).some(value => value !== undefined), 'Choose a change.');
export const adminProfileSchema = z.object({ firstName: name, lastName: name, email });

type Row = Record<string, unknown>;
function iso(value: unknown): string | null { return value ? new Date(value as string | Date).toISOString() : null; }
function nullable(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
export function classroomFrom(row: Row): Classroom { return { id: String(row.id), teacherId: String(row.teacher_id), teacherName: `${row.teacher_first_name ?? ''} ${row.teacher_last_name ?? ''}`.trim() || undefined, name: String(row.name), period: nullable(row.period), code: nullable(row.code), timeZone: String(row.time_zone ?? 'America/New_York'), legacyCode: nullable(row.legacy_code), capacity: Number(row.capacity), archived: Boolean(row.archived), studentCount: Number(row.student_count || 0) }; }
function questionFrom(row: Row): Question { return { id: String(row.id), prompt: String(row.prompt), options: row.options as string[], correctIndex: Number(row.correct_index), topic: String(row.topic), explanation: String(row.explanation), active: Boolean(row.active) }; }
function visitFrom(row: Row): Visit { return { id: String(row.id), studentId: String(row.student_id), studentName: `${row.first_name} ${row.last_name}`, classroomId: String(row.classroom_id), classroomName: String(row.classroom_name ?? ''), status: row.status as Visit['status'], purpose: (row.purpose ?? null) as BreakPurpose | null, requestedAt: iso(row.requested_at)!, readyAt: iso(row.ready_at), readyExpiresAt: iso(row.ready_expires_at), reservationPaused: Boolean(row.capacity_paused), leftAt: iso(row.left_at), returnedAt: iso(row.returned_at), warningAcknowledgedAt: iso(row.warning_acknowledged_at), corrections: (row.corrections ?? []) as Visit['corrections'] }; }
function rosterFrom(row: Row): RosterStudent { return { id: String(row.id), firstName: String(row.first_name), lastName: String(row.last_name), username: String(row.username), enabled: Boolean(row.enabled), accountStatus: row.account_status as RosterStudent['accountStatus'], registeredAt: iso(row.registered_at ?? row.created_at)!, approvedAt: iso(row.approved_at), registered: Boolean(row.password_hash), mustChangePassword: Boolean(row.must_change_password), visitsToday: Number(row.visits_today || 0), classroomId: nullable(row.current_classroom_id ?? row.classroom_id) }; }
function teacherFrom(row: Row): TeacherAccount { return { id: String(row.id), firstName: String(row.first_name), lastName: String(row.last_name), username: String(row.username), email: nullable(row.email), enabled: Boolean(row.enabled), mustChangePassword: Boolean(row.must_change_password), classCount: Number(row.class_count || 0), studentCount: Number(row.student_count || 0), createdAt: iso(row.created_at)! }; }
function assertRole(user: User, role: User['role']) { if (user.role !== role) throw new AppError(403, role === 'admin' ? 'Administrator access required.' : role === 'teacher' ? 'Teacher access required.' : 'This action is for students.'); }
export function requirePasswordChange(user: User) { if (user.mustChangePassword) throw new AppError(403, 'Please change your temporary password before continuing.'); }
async function currentActor(tx: SQL, user: User, role: User['role'], changing = false, lock = false) {
 assertRole(user,role);
 const { rows: [row] } = await tx.query(`SELECT * FROM users WHERE id=$1 AND role=$2 AND (enabled=TRUE OR role='student')${lock?' FOR UPDATE':''}`, [user.id,role]);
 if (!row || (role === 'admin' && row.username !== ADMIN_USERNAME)) throw new AppError(403, 'Your account is unavailable. Please sign in again.');
 if (changing && row.must_change_password) throw new AppError(403, 'Please change your temporary password before continuing.');
 return row;
}
async function lockClasses(tx: SQL, ids: (string | null | undefined)[]) { for (const id of [...new Set(ids.filter((id): id is string => Boolean(id)))].sort()) await tx.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE',[id]); }
async function checkStudentAccess(tx: SQL, user: User, classroomId: string, allowInactive = false) {
 const { rows: [current] } = await tx.query(`SELECT u.*,c.archived,t.enabled AS teacher_enabled FROM users u JOIN enrollments e ON e.student_id=u.id AND e.active=TRUE JOIN classrooms c ON c.id=e.classroom_id JOIN users t ON t.id=c.teacher_id WHERE u.id=$1 AND u.role='student' AND u.classroom_id=$2 AND e.classroom_id=$2 FOR UPDATE OF u`, [user.id,classroomId]);
 if (!current) throw new AppError(409,'Your enrollment changed or your account is unavailable. Refresh and contact your teacher if needed.');
 if (current.must_change_password) throw new AppError(403,'Please change your temporary password before continuing.');
 if (!allowInactive && current.account_status!=='active') throw new AppError(403,current.account_status==='pending'?'Your account is awaiting teacher approval.':'Your account is currently deactivated. Please contact your teacher.');
 if (!allowInactive && (current.archived || !current.teacher_enabled)) throw new AppError(409,'This class is inactive. You can view your records, but new passes are unavailable.');
 return current;
}
// Every caller holds the classroom row lock, so reservations and available spots
// have a single ordering even when different students poll or answer together.
async function promote(tx: SQL, classroomId: string) {
 const { rows: [classroom] } = await tx.query('SELECT c.archived,c.capacity,t.enabled AS teacher_enabled FROM classrooms c JOIN users t ON t.id=c.teacher_id WHERE c.id=$1',[classroomId]);
 if (!classroom) return;
 await tx.query(`UPDATE visits v SET status='cancelled' WHERE v.classroom_id=$1 AND v.status IN ('waiting','ready') AND (
  (v.status='ready' AND v.capacity_paused=FALSE AND (v.ready_expires_at IS NULL OR v.ready_expires_at<=statement_timestamp())) OR
  NOT EXISTS(SELECT 1 FROM users u JOIN enrollments e ON e.student_id=u.id AND e.active=TRUE WHERE u.id=v.student_id AND u.enabled=TRUE AND u.account_status='active' AND u.must_change_password=FALSE AND u.classroom_id=$1 AND e.classroom_id=$1)
 )`,[classroomId]);
 if (classroom.archived || !classroom.teacher_enabled) {
  await tx.query("UPDATE visits SET status='cancelled' WHERE classroom_id=$1 AND status IN ('waiting','ready')",[classroomId]);
  return;
 }
 // A correction can fill actual outside capacity while earlier reservations
 // remain. Persist the pause so a browser need not keep polling to retain its turn.
 const {rows:[outside]}=await tx.query("SELECT COUNT(*) AS n FROM visits WHERE classroom_id=$1 AND status='out'",[classroomId]);
 const paused=Number(outside.n)>=Number(classroom.capacity);
 await tx.query("UPDATE visits SET capacity_paused=$2,ready_expires_at=statement_timestamp()+INTERVAL '120 seconds' WHERE classroom_id=$1 AND status='ready' AND capacity_paused<>$2",[classroomId,paused]);
 const { rows: [count] } = await tx.query("SELECT COUNT(*) AS n FROM visits WHERE classroom_id=$1 AND status IN ('ready','out')", [classroomId]);
 const slots = Math.max(0, Number(classroom.capacity) - Number(count.n));
 if (slots) await tx.query(`UPDATE visits SET status='ready',ready_at=statement_timestamp(),ready_expires_at=statement_timestamp()+INTERVAL '120 seconds' WHERE id IN (SELECT id FROM visits WHERE classroom_id=$1 AND status='waiting' ORDER BY requested_at,id LIMIT $2)`, [classroomId, slots]);
}
function normalizedCode(value: string): string {
 const parsed=code.safeParse(value);
 if(!parsed.success)throw new AppError(400,'Enrollment codes must contain exactly five English letters or numbers.');
 return parsed.data;
}
type AnswerRecord = {questionToken:string;questionId:string;answer:number;correct:boolean;explanation:string};
function quizFrom(row: Row): Quiz {
 const questions=row.questions as Question[];
 const question=questions[Number(row.current_index)];
 if(!question || !row.question_token || !row.purpose)throw new AppError(409,'This learning session is unavailable. Please start a new request.');
 return {id:String(row.id),purpose:row.purpose as BreakPurpose,correctCount:Number(row.correct_count),question:{id:question.id,prompt:question.prompt,options:question.options,topic:question.topic},questionToken:String(row.question_token),expiresAt:iso(row.expires_at)!,...((row.answer_history as AnswerRecord[]).length>=questions.length?{notice:'You have worked through the question bank. Questions may repeat as you work toward two correct answers.'}:{})};
}
async function finishStudentVisits(tx: SQL, studentId: string) {
 await tx.query("UPDATE visits SET status=CASE WHEN status='out' THEN 'returned' ELSE 'cancelled' END,returned_at=CASE WHEN status='out' THEN statement_timestamp() ELSE returned_at END WHERE student_id=$1 AND status IN ('waiting','ready','out')",[studentId]);
 await tx.query('UPDATE quizzes SET used=TRUE WHERE student_id=$1 AND used=FALSE',[studentId]);
}
async function attachEnrollment(tx: SQL, studentId: string, classroomId: string) {
 await tx.query(`INSERT INTO enrollments(id,student_id,classroom_id,active,joined_at,left_at) VALUES($1,$2,$3,TRUE,CURRENT_TIMESTAMP,NULL) ON CONFLICT(student_id,classroom_id) DO UPDATE SET active=TRUE,joined_at=CURRENT_TIMESTAMP,left_at=NULL`,[randomUUID(),studentId,classroomId]);
 await tx.query('UPDATE users SET classroom_id=$1 WHERE id=$2',[classroomId,studentId]);
}
const classSelect = `SELECT c.*,t.first_name AS teacher_first_name,t.last_name AS teacher_last_name,t.enabled AS teacher_enabled,(SELECT COUNT(*) FROM enrollments e WHERE e.classroom_id=c.id AND e.active=TRUE) AS student_count FROM classrooms c JOIN users t ON t.id=c.teacher_id`;
const visitSelect = `SELECT v.*,u.first_name,u.last_name,c.name AS classroom_name,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',bc.id,'teacherName',a.first_name||' '||a.last_name,'correctedAt',bc.corrected_at,'incorrectReturnedAt',bc.incorrect_returned_at,'reason',bc.reason) ORDER BY bc.corrected_at,bc.id) FROM break_corrections bc JOIN users a ON a.id=bc.teacher_id WHERE bc.visit_id=v.id),'[]'::jsonb) AS corrections
 FROM visits v JOIN users u ON u.id=v.student_id JOIN classrooms c ON c.id=v.classroom_id`;
const rosterSelect = `SELECT u.*,e.classroom_id AS current_classroom_id,(SELECT COUNT(*) FROM visits v WHERE v.student_id=u.id AND v.classroom_id=e.classroom_id AND v.left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS visits_today FROM users u JOIN enrollments e ON e.student_id=u.id AND e.active=TRUE`;
const teacherSelect = `SELECT u.*,(SELECT COUNT(*) FROM classrooms c WHERE c.teacher_id=u.id) AS class_count,(SELECT COUNT(*) FROM enrollments e JOIN classrooms c ON c.id=e.classroom_id WHERE c.teacher_id=u.id AND e.active=TRUE) AS student_count FROM users u`;
const emptyStats = {out:0,ready:0,waiting:0,tripsToday:0,averageMinutes:0};

export class WaterCycle {
 constructor(readonly db: Database) {}
 async login(input: z.infer<typeof loginSchema>, connection: SQL = this.db): Promise<User> {
  const { rows: [row] } = await connection.query('SELECT * FROM users WHERE username=$1 AND role=$2 FOR UPDATE', [input.username.toLowerCase(), input.role]);
  if (!await verifyPassword(input.password, row?.password_hash as string | null) || (!row?.enabled && row?.role!=='student') || (input.role === 'admin' && row.username !== ADMIN_USERNAME)) throw new AppError(401, 'The username or password is incorrect.');
  return userFrom(row);
 }
 async setup(_input?: unknown): Promise<User> { throw new AppError(410,'Teacher accounts are created by the administrator. Public teacher registration is unavailable.'); }
 async seedQuestions(tx: SQL, classroomId: string) { for (const q of defaultQuestions) await tx.query('INSERT INTO questions(id,classroom_id,prompt,options,correct_index,topic,explanation,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),classroomId,q.prompt,JSON.stringify(q.options),q.correctIndex,q.topic,q.explanation,q.active]); }
 async signup(input: z.infer<typeof signupSchema>): Promise<User> {
  const classroomCode=normalizedCode(input.classroomCode);
  const login = input.username || usernameFor(input.firstName,input.lastName);
  if (login.length < 2 || login === ADMIN_USERNAME) throw new AppError(400,'Choose a valid student username.');
  const hash = await hashPassword(input.password);
  return this.db.transaction(async tx => {
   const { rows: [classroom] } = await tx.query(`SELECT c.* FROM classrooms c JOIN users t ON t.id=c.teacher_id WHERE c.code=$1 AND c.archived=FALSE AND t.enabled=TRUE FOR UPDATE OF c`,[classroomCode]);
   if (!classroom) throw new AppError(400,'That enrollment code is invalid or belongs to an inactive class. Check the five-character code with your teacher.');
   const { rows: [existing] } = await tx.query('SELECT * FROM users WHERE username=$1 FOR UPDATE',[login]);
   if (existing) {
    const {rows:enrolled}=await tx.query('SELECT classroom_id FROM enrollments WHERE student_id=$1 AND active=TRUE',[existing.id]);
    if (existing.role !== 'student' || existing.password_hash || !existing.enabled || enrolled[0]?.classroom_id !== classroom.id) throw new AppError(409,'This username is already registered or unavailable. Sign in to your existing account or ask your teacher for help.');
    const {rows:[claimed]}=await tx.query("UPDATE users SET password_hash=$1,first_name=$2,last_name=$3,tutorial_completed=FALSE,account_status='pending',registered_at=statement_timestamp(),approved_at=NULL,approved_by=NULL WHERE id=$4 RETURNING *",[hash,input.firstName,input.lastName,existing.id]);
    return userFrom(claimed);
   }
   const id=randomUUID();
   const {rows:[student]}=await tx.query(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,classroom_id,tutorial_completed) VALUES($1,'student',$2,$3,$4,$5,$6,FALSE) RETURNING *`,[id,input.firstName,input.lastName,login,hash,classroom.id]);
   await attachEnrollment(tx,id,String(classroom.id));
   return userFrom(student);
  });
 }
 async enrollStudent(user: User, classroomCode: string) {
  classroomCode=normalizedCode(classroomCode);
  assertRole(user,'student'); requirePasswordChange(user);
  await this.db.transaction(async tx=>{
   const {rows:[classroom]}=await tx.query(`SELECT c.* FROM classrooms c JOIN users t ON t.id=c.teacher_id WHERE c.code=$1 AND c.archived=FALSE AND t.enabled=TRUE FOR UPDATE OF c`,[classroomCode]);
   if (!classroom) throw new AppError(400,'That enrollment code is invalid or belongs to an inactive class. Check with your teacher.');
   await currentActor(tx,user,'student',true);
   await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
   const {rows}=await tx.query('SELECT classroom_id FROM enrollments WHERE student_id=$1 AND active=TRUE',[user.id]);
   if (rows.length) throw new AppError(409,'You are already enrolled. Ask your teacher to transfer you to another class.');
   await attachEnrollment(tx,user.id,String(classroom.id));
   await tx.query("UPDATE users SET account_status='pending',enabled=TRUE,approved_at=NULL,approved_by=NULL,registered_at=statement_timestamp() WHERE id=$1",[user.id]);
  });
 }
 async changePassword(user: User, currentPassword: string, newPassword: string) {
  const hash = await hashPassword(newPassword);
  await this.db.transaction(async tx => {
   const {rows:[row]}=await tx.query('SELECT password_hash,enabled,role FROM users WHERE id=$1 FOR UPDATE',[user.id]);
   if ((!row?.enabled && row?.role!=='student') || !await verifyPassword(currentPassword,row.password_hash as string)) throw new AppError(400,'Your current password is incorrect.');
   await tx.query('UPDATE users SET password_hash=$1,must_change_password=FALSE WHERE id=$2',[hash,user.id]);
   await tx.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);
  });
 }
 private async maintainQueue(classroomId: string) {
  await this.db.transaction(async tx=>{await lockClasses(tx,[classroomId]);await promote(tx,classroomId);});
 }
 private async studentClassId(user: User): Promise<string> {
  const {rows:[enrollment]}=await this.db.query('SELECT e.classroom_id FROM enrollments e JOIN users u ON u.id=e.student_id WHERE e.student_id=$1 AND e.active=TRUE AND u.classroom_id=e.classroom_id',[user.id]);
  if(!enrollment)throw new AppError(409,'Join a class before requesting a break.');
  return String(enrollment.classroom_id);
 }
 async studentState(user: User): Promise<StudentState> {
  assertRole(user,'student');
  for(let retry=0;retry<3;retry++) {
   const {rows:[discovered]}=await this.db.query('SELECT e.classroom_id FROM enrollments e JOIN users u ON u.id=e.student_id WHERE e.student_id=$1 AND e.active=TRUE AND u.classroom_id=e.classroom_id',[user.id]);
   const classroomId=nullable(discovered?.classroom_id);
   const snapshot=await this.db.transaction(async tx=>{
    // Mutations lock classrooms before students. Recheck enrollment after both
    // locks rather than acquiring a different class lock while holding a user.
    await lockClasses(tx,[classroomId]);
    const freshUser=userFrom(await currentActor(tx,user,'student',false,true));
    const {rows:[membership]}=await tx.query('SELECT classroom_id FROM enrollments WHERE student_id=$1 AND active=TRUE',[user.id]);
    if(nullable(membership?.classroom_id)!==classroomId || freshUser.classroomId!==classroomId)return null;
    const {rows:[enrollment]}=await tx.query(`${classSelect} JOIN enrollments e ON e.classroom_id=c.id AND e.student_id=$1 AND e.active=TRUE FOR SHARE OF t`,[user.id]);
    const classroom=enrollment?classroomFrom(enrollment):null;
    if(classroom)await promote(tx,classroom.id);
    const [{rows:visits},{rows:[counts]},{rows:[questions]},{rows:[attempt]},{rows:[clock]}]=await Promise.all([
     tx.query(`${visitSelect} WHERE v.student_id=$1 AND (v.status IN ('waiting','ready','out') OR v.id IN (SELECT id FROM visits WHERE student_id=$1 AND status IN ('returned','cancelled') ORDER BY requested_at DESC,id DESC LIMIT 10)) ORDER BY v.requested_at DESC,v.id DESC`,[user.id]),
     tx.query("SELECT COUNT(*) FILTER(WHERE status IN ('ready','out')) AS active,COUNT(*) FILTER(WHERE status='waiting') AS waiting FROM visits WHERE classroom_id=$1",[classroomId]),
     tx.query('SELECT COUNT(*) AS n FROM questions WHERE classroom_id=$1 AND active=TRUE AND deleted=FALSE',[classroomId]),
     tx.query('SELECT * FROM quizzes WHERE student_id=$1 AND classroom_id=$2 AND used=FALSE AND expires_at>statement_timestamp() AND purpose IS NOT NULL ORDER BY expires_at DESC,id DESC LIMIT 1',[user.id,classroomId]),
     tx.query('SELECT statement_timestamp() AS now')
    ]);
    const currentRow=visits.find(row=>['waiting','ready','out'].includes(String(row.status)));
    const currentVisit=currentRow?visitFrom(currentRow):null;
    if(currentVisit?.status==='waiting') {const {rows:waiting}=await tx.query("SELECT id FROM visits WHERE classroom_id=$1 AND status='waiting' ORDER BY requested_at,id",[classroomId]);const position=waiting.findIndex(row=>row.id===currentVisit.id);if(position<0)throw new AppError(409,'Your request changed while loading. Please refresh.');currentVisit.position=position+1;}
    const canRequestPass=Boolean(freshUser.accountStatus==='active' && classroom && !classroom.archived && enrollment.teacher_enabled && !freshUser.mustChangePassword);
    const unavailableReason=freshUser.accountStatus==='pending'?'Your account is awaiting teacher approval.':freshUser.accountStatus==='deactivated'?'Your account is currently deactivated. Please contact your teacher.':!classroom?'You are not currently enrolled. Enter a class code below or ask your teacher to add you.':classroom.archived?'This class has been archived. Your records are preserved; contact your teacher about a new class.':!enrollment.teacher_enabled?'Your teacher’s account is inactive. New passes are temporarily unavailable.':Number(questions.n)<2?'Your teacher needs to add at least two active questions before passes are available.':undefined;
    return {user:{...freshUser,classroomId},classroom,currentVisit,activeQuiz:attempt&&canRequestPass&&!currentVisit?quizFrom(attempt):null,serverNow:iso(clock.now)!,activeCount:Number(counts.active),waitingCount:Number(counts.waiting),recentVisits:visits.filter(visit=>['returned','cancelled'].includes(String(visit.status))).slice(0,10).map(visitFrom),availableQuestions:Number(questions.n),canRequestPass,unavailableReason};
   });
   if(snapshot)return snapshot;
  }
  throw new AppError(409,'Your enrollment changed while loading. Please refresh to see your current class.');
 }
 async newQuiz(user: User, purpose: BreakPurpose): Promise<Quiz> {
  assertRole(user,'student');requirePasswordChange(user);
  if(purpose!=='restroom'&&purpose!=='water')throw new AppError(400,'Choose Use Restroom or Drink Water before starting the questions.');
  const classroomId=await this.studentClassId(user);
  return this.db.transaction(async tx=>{
   await lockClasses(tx,[classroomId]);await checkStudentAccess(tx,user,classroomId);
   await promote(tx,classroomId);
   const {rows:active}=await tx.query("SELECT id FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out')",[user.id]);
   if(active.length)throw new AppError(409,'You already have a break or a place in line.');
   const {rows:[existing]}=await tx.query('SELECT * FROM quizzes WHERE student_id=$1 AND classroom_id=$2 AND used=FALSE AND expires_at>statement_timestamp() ORDER BY expires_at DESC,id DESC LIMIT 1 FOR UPDATE',[user.id,classroomId]);
   if(existing){if(existing.purpose!==purpose)throw new AppError(409,'You already started a request for another purpose. Cancel that learning session before choosing a different purpose.');return quizFrom(existing);}
   const {rows}=await tx.query('SELECT * FROM questions WHERE classroom_id=$1 AND active=TRUE AND deleted=FALSE ORDER BY RANDOM()',[classroomId]);
   if(rows.length<2)throw new AppError(409,'Your teacher needs to add at least two active questions before passes are available.');
   const questions=rows.map(questionFrom);await tx.query('UPDATE quizzes SET used=TRUE WHERE student_id=$1 AND used=FALSE',[user.id]);
   const id=randomUUID();const {rows:[quiz]}=await tx.query("INSERT INTO quizzes(id,student_id,classroom_id,questions,expires_at,purpose,correct_count,current_index,question_token,seen_question_ids,answer_history) VALUES($1,$2,$3,$4,statement_timestamp()+INTERVAL '15 minutes',$5,0,0,$6,$7,'[]') RETURNING *",[id,user.id,classroomId,JSON.stringify(questions),purpose,randomUUID(),JSON.stringify([questions[0].id])]);
   return quizFrom(quiz);
  });
 }
 async answerQuiz(user:User,input:{quizId:string;questionId:string;questionToken:string;answer:number}):Promise<QuizResult> {
  assertRole(user,'student');requirePasswordChange(user);
  if(!Number.isInteger(input.answer)||input.answer<0||input.answer>3)throw new AppError(400,'Choose one of the four answers.');
  const {rows:[previous]}=await this.db.query('SELECT classroom_id FROM quizzes WHERE id=$1 AND student_id=$2',[input.quizId,user.id]);
  if(!previous?.classroom_id)throw new AppError(409,'This learning session is unavailable. Start a fresh request.');
  const classroomId=String(previous.classroom_id);
  return this.db.transaction(async tx=>{
   await lockClasses(tx,[classroomId]);await checkStudentAccess(tx,user,classroomId);
   const {rows:[quiz]}=await tx.query('SELECT *,expires_at>statement_timestamp() AS unexpired FROM quizzes WHERE id=$1 AND student_id=$2 FOR UPDATE',[input.quizId,user.id]);
   if(!quiz||quiz.classroom_id!==classroomId)throw new AppError(409,'This learning session belongs to a previous enrollment. Start a fresh request.');
   const history=quiz.answer_history as AnswerRecord[];
   const replay=history.find(record=>record.questionToken===input.questionToken);
   if(replay){
    if(replay.questionId!==input.questionId||replay.answer!==input.answer)throw new AppError(409,'That question was already answered. Use the current question shown on your screen.');
    const feedback=[{questionId:replay.questionId,correct:replay.correct,explanation:replay.explanation}];
    if(quiz.visit_id){const {rows:[visit]}=await tx.query(`${visitSelect} WHERE v.id=$1 AND v.student_id=$2`,[quiz.visit_id,user.id]);if(visit)return{passed:true,correctCount:2,feedback,visit:visitFrom(visit)};}
    if(!quiz.used&&quiz.unexpired)return{passed:false,correctCount:Number(quiz.correct_count),feedback,quiz:quizFrom(quiz)};
    throw new AppError(409,'This learning session expired or was cancelled. Start a fresh request.');
   }
   if(quiz.used||!quiz.unexpired||quiz.question_token!==input.questionToken)throw new AppError(409,'This question expired or has already changed. Refresh to continue your current request.');
   const questions=quiz.questions as Question[];const question=questions[Number(quiz.current_index)];
   if(!question||question.id!==input.questionId)throw new AppError(409,'Answer the current question before continuing.');
   const correct=input.answer===question.correctIndex;
   const record:AnswerRecord={questionToken:input.questionToken,questionId:question.id,answer:input.answer,correct,explanation:question.explanation};
   history.push(record);const correctCount=Number(quiz.correct_count)+(correct?1:0);
   const feedback=[{questionId:question.id,correct,explanation:question.explanation}];
   if(correctCount>=2){
    await promote(tx,classroomId);
    const {rows:active}=await tx.query("SELECT id FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out')",[user.id]);
    if(active.length)throw new AppError(409,'You already have an active break request.');
    const {rows:[capacity]}=await tx.query("SELECT c.capacity,(SELECT COUNT(*) FROM visits WHERE classroom_id=c.id AND status IN ('ready','out')) AS occupied,(SELECT COUNT(*) FROM visits WHERE classroom_id=c.id AND status='waiting') AS waiting FROM classrooms c WHERE c.id=$1",[classroomId]);
    const immediate=Number(capacity.occupied)<Number(capacity.capacity)&&Number(capacity.waiting)===0;
    const id=randomUUID();await tx.query("INSERT INTO visits(id,classroom_id,student_id,status,purpose,requested_at,left_at) VALUES($1,$2,$3,$4,$5,statement_timestamp(),CASE WHEN $4='out' THEN statement_timestamp() ELSE NULL END)",[id,classroomId,user.id,immediate?'out':'waiting',quiz.purpose]);
    await tx.query('UPDATE quizzes SET used=TRUE,correct_count=2,answer_history=$1,visit_id=$2 WHERE id=$3',[JSON.stringify(history),id,quiz.id]);
    if(!immediate)await promote(tx,classroomId);
    const {rows:[visit]}=await tx.query(`${visitSelect} WHERE v.id=$1`,[id]);return{passed:true,correctCount:2,feedback,visit:visitFrom(visit)};
   }
   let seen=quiz.seen_question_ids as string[];
   let candidates=questions.map((q,index)=>({q,index})).filter(({q})=>!seen.includes(q.id));
   if(!candidates.length){seen=[];candidates=questions.map((q,index)=>({q,index})).filter(({q})=>questions.length===1||q.id!==question.id);}
   const next=candidates[Math.floor(Math.random()*candidates.length)];seen.push(next.q.id);
   const {rows:[updated]}=await tx.query('UPDATE quizzes SET correct_count=$1,current_index=$2,question_token=$3,seen_question_ids=$4,answer_history=$5 WHERE id=$6 RETURNING *',[correctCount,next.index,randomUUID(),JSON.stringify(seen),JSON.stringify(history),quiz.id]);
   return{passed:false,correctCount,feedback,quiz:quizFrom(updated)};
  });
 }
 async submitQuiz(_user: User, _quizId: string, _answers: number[]): Promise<QuizResult> {throw new AppError(410,'Please answer the current question one at a time. The old batch quiz endpoint is no longer available.');}
 async cancelQuiz(user:User,quizId:string) {
  assertRole(user,'student');requirePasswordChange(user);
  const {rows:[previous]}=await this.db.query('SELECT classroom_id FROM quizzes WHERE id=$1 AND student_id=$2',[quizId,user.id]);
  if(!previous)throw new AppError(404,'Learning session not found.');
  await this.db.transaction(async tx=>{await lockClasses(tx,[nullable(previous.classroom_id)]);await currentActor(tx,user,'student',true);await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
   const {rows:[quiz]}=await tx.query('SELECT visit_id FROM quizzes WHERE id=$1 AND student_id=$2 FOR UPDATE',[quizId,user.id]);
   if(quiz.visit_id)throw new AppError(409,'This request already qualified. Cancel your waiting request or record your return instead.');
   await tx.query('UPDATE quizzes SET used=TRUE WHERE id=$1',[quizId]);
  });
 }
 async completeTutorial(user:User) {
  await currentActor(this.db,user,'student');
  await this.db.query("UPDATE users SET tutorial_completed=TRUE WHERE id=$1 AND role='student'",[user.id]);
 }
 async acknowledgeWarning(user:User,visitId:string) {
  await currentActor(this.db,user,'student');
  const {rows}=await this.db.query("UPDATE visits SET warning_acknowledged_at=COALESCE(warning_acknowledged_at,statement_timestamp()) WHERE id=$1 AND student_id=$2 AND status='out' AND left_at<=statement_timestamp()-INTERVAL '12 minutes' RETURNING id",[visitId,user.id]);
  if(!rows.length)throw new AppError(409,'Only your current break at or after 12 minutes can be acknowledged.');
 }
 async studentAction(user: User, action:'leave'|'return'|'cancel') {
  assertRole(user,'student');requirePasswordChange(user);
  const {rows:[active]}=await this.db.query("SELECT classroom_id FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out')",[user.id]);
  if(!active)throw new AppError(409,'You do not have an active break.');
  const classroomId=String(active.classroom_id);
  // Commit expiration even if this particular student's subsequent action fails.
  await this.maintainQueue(classroomId);
  const error=await this.db.transaction(async tx=>{
   await lockClasses(tx,[classroomId]);await checkStudentAccess(tx,user,classroomId,action!=='leave');await promote(tx,classroomId);
   const {rows:[visit]}=await tx.query("SELECT * FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out') FOR UPDATE",[user.id]);
   if(!visit||visit.classroom_id!==classroomId)return 'Your reservation expired or your pass changed. Please refresh.';
   if(action==='leave') {if(visit.status!=='ready')return 'Please wait for your turn before leaving.';const {rows:[occupied]}=await tx.query("SELECT (SELECT COUNT(*) FROM visits WHERE classroom_id=$1 AND status='out') AS n,capacity FROM classrooms WHERE id=$1",[classroomId]);if(Number(occupied.n)>=Number(occupied.capacity))return 'All spots are occupied after a teacher correction. Keep your place and wait for a spot to open.';await tx.query("UPDATE visits SET status='out',left_at=statement_timestamp(),ready_expires_at=NULL,capacity_paused=FALSE WHERE id=$1",[visit.id]);}
   else if(action==='return') {if(visit.status!=='out')return 'You can record your return after you have left.';await tx.query("UPDATE visits SET status='returned',returned_at=statement_timestamp() WHERE id=$1",[visit.id]);}
   else {if(visit.status==='out')return 'Use I’m back to finish your current trip.';await tx.query("UPDATE visits SET status='cancelled' WHERE id=$1",[visit.id]);}
   await promote(tx,classroomId);return null;
  });
  if(error)throw new AppError(409,error);
 }
 private async ownedClass(user: User, requested?: string, connection: SQL=this.db, lock=false):Promise<Row|null> {
  await currentActor(connection,user,'teacher');
  if(requested) {const {rows:[row]}=await connection.query(`${classSelect} WHERE c.id=$1 AND c.teacher_id=$2${lock?' FOR UPDATE OF c':''}`,[requested,user.id]);if(!row)throw new AppError(404,'Class not found.');return row;}
  const {rows}=await connection.query(`${classSelect} WHERE c.teacher_id=$1 ORDER BY c.archived,c.name,c.id`,[user.id]);
  const row=rows.find(r=>!r.archived&&r.id===user.classroomId)||rows.find(r=>!r.archived)||rows[0]||null;
  if(row&&lock)await lockClasses(connection,[String(row.id)]);return row;
 }
 private async selectedClass(user: User, requested?: string, connection:SQL=this.db, lock=false):Promise<Row> {const row=await this.ownedClass(user,requested,connection,lock);if(!row)throw new AppError(400,'Create a class before managing students, questions, or passes.');return row;}
 async teacherState(user: User, classroomId?: string): Promise<TeacherState> {
  const classroom=await this.ownedClass(user,classroomId);
  const {rows:classes}=await this.db.query(`${classSelect} WHERE c.teacher_id=$1 ORDER BY c.archived,c.name,c.id`,[user.id]);
  const {rows:pending}=await this.db.query(`${rosterSelect} JOIN classrooms c ON c.id=e.classroom_id WHERE c.teacher_id=$1 AND u.account_status='pending' AND u.password_hash IS NOT NULL ORDER BY u.registered_at,u.id`,[user.id]);
  const pendingStudents=pending.map(row=>({...rosterFrom(row),classroomName:String(classes.find(c=>c.id===row.current_classroom_id)?.name??''),period:nullable(classes.find(c=>c.id===row.current_classroom_id)?.period)}));
  if(!classroom)return{user,pendingStudents,classes:classes.map(classroomFrom),classroom:null,students:[],questions:[],visits:[],stats:{...emptyStats}};
  const id=String(classroom.id);
  await this.maintainQueue(id);
  const [{rows:students},{rows:questions},{rows:visits},{rows:[stats]}]=await Promise.all([
   this.db.query(`${rosterSelect} WHERE e.classroom_id=$1 ORDER BY u.last_name,u.first_name`,[id]),
   this.db.query('SELECT * FROM questions WHERE classroom_id=$1 AND deleted=FALSE ORDER BY topic,prompt',[id]),
   this.db.query(`${visitSelect} WHERE v.classroom_id=$1 AND (v.status IN ('waiting','ready','out') OR v.id IN (SELECT id FROM visits WHERE classroom_id=$1 AND status IN ('returned','cancelled') ORDER BY requested_at DESC,id DESC LIMIT 1000)) ORDER BY v.requested_at DESC,v.id DESC`,[id]),
   this.db.query("SELECT COUNT(*) FILTER(WHERE status='out') AS out,COUNT(*) FILTER(WHERE status='ready') AS ready,COUNT(*) FILTER(WHERE status='waiting') AS waiting,COUNT(*) FILTER(WHERE left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS trips_today,AVG(EXTRACT(EPOCH FROM(returned_at-left_at))/60) FILTER(WHERE status='returned' AND left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS average_minutes FROM visits WHERE classroom_id=$1",[id])
  ]);
  const visitModels=visits.map(visitFrom);visitModels.filter(v=>v.status==='waiting').sort((a,b)=>a.requestedAt.localeCompare(b.requestedAt)||a.id.localeCompare(b.id)).forEach((v,i)=>{v.position=i+1;});
  return{user,pendingStudents,classes:classes.map(classroomFrom),classroom:classroomFrom(classroom),students:students.map(rosterFrom),questions:questions.map(questionFrom),visits:visitModels,stats:{out:Number(stats.out),ready:Number(stats.ready),waiting:Number(stats.waiting),tripsToday:Number(stats.trips_today),averageMinutes:Number(stats.average_minutes||0)}};
 }
 async createClass(user: User,input:z.infer<typeof classCreateSchema>):Promise<Classroom> {
  input={...input,code:normalizedCode(input.code),timeZone:timeZone.parse(input.timeZone ?? 'America/New_York')};
  requirePasswordChange(user);return this.db.transaction(async tx=>{
   await currentActor(tx,user,'teacher',true);const id=randomUUID();
   const {rows:[row]}=await tx.query('INSERT INTO classrooms(id,teacher_id,name,period,code,time_zone) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,user.id,input.name,input.period || null,input.code,input.timeZone]);
   await tx.query('UPDATE users SET classroom_id=$1 WHERE id=$2 AND classroom_id IS NULL',[id,user.id]);await this.seedQuestions(tx,id);return classroomFrom(row);
  });
 }
 async updateClass(user:User,id:string,input:z.infer<typeof classUpdateSchema>):Promise<Classroom> {
  if(input.code!==undefined)input={...input,code:normalizedCode(input.code)};
  if(input.timeZone!==undefined)input={...input,timeZone:timeZone.parse(input.timeZone)};
  requirePasswordChange(user);return this.db.transaction(async tx=>{
   const current=await this.selectedClass(user,id,tx,true);await currentActor(tx,user,'teacher',true);
   const nextCode=input.code??nullable(current.code);const archived=input.archived??Boolean(current.archived);
   if(!archived&&!nextCode)throw new AppError(400,'Choose a five-character enrollment code before activating this class.');
   const {rows:[row]}=await tx.query('UPDATE classrooms SET name=$1,period=$2,code=$3,archived=$4,time_zone=$6 WHERE id=$5 RETURNING *',[input.name??current.name,input.period!==undefined?(input.period||null):current.period,nextCode,archived,id,input.timeZone??current.time_zone]);
   if(archived&&!current.archived){await tx.query("UPDATE visits SET status='cancelled' WHERE classroom_id=$1 AND status IN ('waiting','ready')",[id]);await tx.query('UPDATE quizzes SET used=TRUE WHERE classroom_id=$1 AND used=FALSE',[id]);}
   return classroomFrom({...row,student_count:current.student_count});
  });
 }
 async updateClassroom(_user:User,_input:unknown):Promise<Classroom> {throw new AppError(410,'Manage class names and enrollment codes from Class Roster.');}
 async ruleOffenders(user:User,filters:RuleOffendersFilters={}) {
  if(user.role==='admin')await currentActor(this.db,user,'admin',true);
  else await currentActor(this.db,user,'teacher',true);
  if(filters.classroomId) {
   if(user.role==='teacher')await this.selectedClass(user,filters.classroomId);
   else if(!(await this.db.query('SELECT id FROM classrooms WHERE id=$1',[filters.classroomId])).rows.length)throw new AppError(404,'Class not found.');
  }
  return loadRuleOffenders(this.db,user.role==='teacher'?user.id:null,filters);
 }
 async addRoster(user:User,input:z.infer<typeof rosterSchema>,classroomId?:string):Promise<RosterStudent> {
  requirePasswordChange(user);return this.db.transaction(async tx=>{
   const classroom=await this.selectedClass(user,classroomId,tx,true);await currentActor(tx,user,'teacher',true);if(classroom.archived)throw new AppError(409,'Archived classes cannot accept new students.');
   const login=usernameFor(input.firstName,input.lastName);if(login.length<2||login===ADMIN_USERNAME)throw new AppError(400,'Choose a valid student name and username.');
   const id=randomUUID();const {rows:[row]}=await tx.query("INSERT INTO users(id,role,first_name,last_name,username,classroom_id) VALUES($1,'student',$2,$3,$4,$5) RETURNING *",[id,input.firstName,input.lastName,login,classroom.id]);await attachEnrollment(tx,id,String(classroom.id));return rosterFrom(row);
  });
 }
 private async enrolledStudent(user:User,id:string,connection:SQL=this.db,lock=false):Promise<Row> {
  await currentActor(connection,user,'teacher');const {rows:[student]}=await connection.query(`SELECT u.*,e.classroom_id AS current_classroom_id FROM users u JOIN enrollments e ON e.student_id=u.id AND e.active=TRUE JOIN classrooms c ON c.id=e.classroom_id WHERE u.id=$1 AND u.role='student' AND c.teacher_id=$2${lock?' FOR UPDATE OF u':''}`,[id,user.id]);
  if(!student)throw new AppError(404,'Student not found in your classes.');return student;
 }
 async updateRoster(user:User,id:string,input:z.infer<typeof rosterUpdateSchema>) {
  requirePasswordChange(user);const previous=await this.enrolledStudent(user,id);const hash=input.password?await hashPassword(input.password):undefined;
  await this.db.transaction(async tx=>{await lockClasses(tx,[String(previous.current_classroom_id)]);const student=await this.enrolledStudent(user,id,tx,true);if(student.current_classroom_id!==previous.current_classroom_id)throw new AppError(409,'This student’s class changed. Refresh and try again.');await currentActor(tx,user,'teacher',true);
   if(input.accountStatus!==undefined && input.enabled!==undefined && (input.accountStatus==='active')!==input.enabled)throw new AppError(400,'Choose one consistent account status.');
   const nextStatus=input.accountStatus ?? (input.enabled===undefined?undefined:input.enabled?'active':'deactivated');
   if(nextStatus && nextStatus!==student.account_status){
    if(nextStatus==='active'&&!student.password_hash)throw new AppError(409,'The student must register before approval.');
    await tx.query("UPDATE users SET account_status=$1,enabled=$2,approved_at=CASE WHEN $1='active' THEN statement_timestamp() ELSE approved_at END,approved_by=CASE WHEN $1='active' THEN $3 ELSE approved_by END WHERE id=$4",[nextStatus,nextStatus==='active',user.id,id]);
    await tx.query('INSERT INTO student_status_events(id,student_id,teacher_id,classroom_id,previous_status,status) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,user.id,student.current_classroom_id,student.account_status,nextStatus]);
   }
   if(hash){await tx.query('UPDATE users SET password_hash=$1,must_change_password=TRUE WHERE id=$2',[hash,id]);await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);}
   if(nextStatus==='deactivated'||hash){
    await tx.query("UPDATE visits SET status='cancelled' WHERE student_id=$1 AND status IN ('waiting','ready')",[id]);
    await tx.query('UPDATE quizzes SET used=TRUE WHERE student_id=$1 AND used=FALSE',[id]);
    await promote(tx,String(student.current_classroom_id));
   }
  });
 }
 async rosterDetail(user:User,id:string,classroomId?:string):Promise<StudentDetail> {
  assertRole(user,'teacher');await currentActor(this.db,user,'teacher');
  let classId=classroomId;
  if(classId)await this.selectedClass(user,classId);
  else {const {rows:[member]}=await this.db.query('SELECT e.classroom_id FROM enrollments e JOIN classrooms c ON c.id=e.classroom_id WHERE e.student_id=$1 AND c.teacher_id=$2 ORDER BY e.active DESC,e.joined_at DESC LIMIT 1',[id,user.id]);if(!member)throw new AppError(404,'Student not found in your classes.');classId=String(member.classroom_id);}
  const {rows:[student]}=await this.db.query('SELECT u.*,e.classroom_id AS current_classroom_id FROM users u JOIN enrollments e ON e.student_id=u.id WHERE u.id=$1 AND e.classroom_id=$2',[id,classId]);if(!student)throw new AppError(404,'Student not found in this class.');
  const {rows:visits}=await this.db.query(`${visitSelect} WHERE v.student_id=$1 AND v.classroom_id=$2 ORDER BY v.requested_at DESC LIMIT 1000`,[id,classId]);return{student:rosterFrom(student),visits:visits.map(visitFrom)};
 }
 async removeStudent(user:User,id:string) {await this.moveStudent(user,id,null);}
 async transferStudent(user:User,id:string,classroomId:string) {await this.moveStudent(user,id,classroomId);}
 private async moveStudent(user:User,id:string,destination:string|null) {
  requirePasswordChange(user);const previous=await this.enrolledStudent(user,id);const source=String(previous.current_classroom_id);if(destination===source)throw new AppError(409,'The student is already enrolled in that class.');
  await this.db.transaction(async tx=>{await lockClasses(tx,[source,destination]);await currentActor(tx,user,'teacher',true);
   const student=await this.enrolledStudent(user,id,tx,true);if(student.current_classroom_id!==source)throw new AppError(409,'This student’s class changed. Refresh and try again.');
   if(destination){const target=await this.selectedClass(user,destination,tx);if(target.archived)throw new AppError(409,'Students cannot transfer into an archived class.');}
   await finishStudentVisits(tx,id);await tx.query('UPDATE enrollments SET active=FALSE,left_at=CURRENT_TIMESTAMP WHERE student_id=$1 AND active=TRUE',[id]);await tx.query('UPDATE users SET classroom_id=NULL WHERE id=$1',[id]);if(destination)await attachEnrollment(tx,id,destination);await promote(tx,source);
  });
 }
 async saveQuestion(user:User,input:z.infer<typeof questionSchema>,id?:string,classroomId?:string):Promise<Question|void> {
  requirePasswordChange(user);return this.db.transaction(async tx=>{const classroom=await this.selectedClass(user,classroomId,tx,true);await currentActor(tx,user,'teacher',true);if(classroom.archived)throw new AppError(409,'Archived question banks are read-only.');
   if(id){const {rows}=await tx.query('UPDATE questions SET prompt=$1,options=$2,correct_index=$3,topic=$4,explanation=$5,active=$6 WHERE id=$7 AND classroom_id=$8 AND deleted=FALSE RETURNING id',[input.prompt,JSON.stringify(input.options),input.correctIndex,input.topic,input.explanation,input.active,id,classroom.id]);if(!rows.length)throw new AppError(404,'Question not found.');return;}
   const {rows:[row]}=await tx.query('INSERT INTO questions(id,classroom_id,prompt,options,correct_index,topic,explanation,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),classroom.id,input.prompt,JSON.stringify(input.options),input.correctIndex,input.topic,input.explanation,input.active]);return questionFrom(row);
  });
 }
 async deleteQuestion(user:User,id:string,classroomId?:string) {
  requirePasswordChange(user);await this.db.transaction(async tx=>{const classroom=await this.selectedClass(user,classroomId,tx,true);await currentActor(tx,user,'teacher',true);if(classroom.archived)throw new AppError(409,'Archived question banks are read-only.');const {rows}=await tx.query('UPDATE questions SET active=FALSE,deleted=TRUE WHERE id=$1 AND classroom_id=$2 RETURNING id',[id,classroom.id]);if(!rows.length)throw new AppError(404,'Question not found.');});
 }
 async teacherVisit(user:User,id:string,action:'return'|'cancel') {
  requirePasswordChange(user);await currentActor(this.db,user,'teacher',true);const {rows:[previous]}=await this.db.query('SELECT v.classroom_id FROM visits v JOIN classrooms c ON c.id=v.classroom_id WHERE v.id=$1 AND c.teacher_id=$2',[id,user.id]);if(!previous)throw new AppError(404,'Pass not found.');
  await this.db.transaction(async tx=>{await lockClasses(tx,[String(previous.classroom_id)]);await currentActor(tx,user,'teacher',true);const {rows:[visit]}=await tx.query('SELECT * FROM visits WHERE id=$1 FOR UPDATE',[id]);
   if(action==='return'){if(visit.status!=='out')throw new AppError(409,'This student is not currently out.');await tx.query("UPDATE visits SET status='returned',returned_at=statement_timestamp() WHERE id=$1",[id]);}
   else {if(!['ready','waiting'].includes(String(visit.status)))throw new AppError(409,'Only a queued or ready pass can be cancelled.');await tx.query("UPDATE visits SET status='cancelled' WHERE id=$1",[id]);}await promote(tx,String(visit.classroom_id));
  });
 }
 async reopenVisit(user:User,id:string,input:{resolveOlder?:boolean;reason?:string}={}) {
  await currentActor(this.db,user,'teacher',true);
  const {rows:[previous]}=await this.db.query('SELECT v.classroom_id,v.student_id FROM visits v JOIN classrooms c ON c.id=v.classroom_id WHERE v.id=$1 AND c.teacher_id=$2',[id,user.id]);
  if(!previous)throw new AppError(404,'Pass not found.');
  await this.db.transaction(async tx=>{
   await lockClasses(tx,[String(previous.classroom_id)]);await currentActor(tx,user,'teacher',true);
   const {rows:[student]}=await tx.query("SELECT * FROM users WHERE id=$1 AND role='student' FOR UPDATE",[previous.student_id]);
   if(!student||student.classroom_id!==previous.classroom_id)throw new AppError(409,'This student is no longer in the original class. Resolve their current enrollment before reopening this break.');
   const {rows:[visit]}=await tx.query("SELECT *,returned_at>=statement_timestamp()-INTERVAL '24 hours' AS recent FROM visits WHERE id=$1 FOR UPDATE",[id]);
   if(visit.status!=='returned'||!visit.left_at||!visit.returned_at||new Date(String(visit.returned_at))<new Date(String(visit.left_at)))throw new AppError(409,'Only a completed break with valid departure and return times can be reopened.');
   const reason=input.reason?.trim()||'Teacher confirmed the student is still outside.';
   if(reason.length>2000)throw new AppError(400,'Keep the correction reason under 2000 characters.');
   if(!visit.recent&&(!input.resolveOlder||reason.length<10||!input.reason?.trim()))throw new AppError(409,'This return is older than 24 hours. Confirm the older correction and provide a reason of at least 10 characters.');
   const {rows:active}=await tx.query("SELECT id FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out')",[student.id]);
   if(active.length)throw new AppError(409,'This student already has an active break or queue entry. Resolve it before reopening this break.');
   await promote(tx,String(previous.classroom_id));
   await tx.query('INSERT INTO break_corrections(id,visit_id,teacher_id,incorrect_returned_at,reason) SELECT $1,id,$3,returned_at,$4 FROM visits WHERE id=$2',[randomUUID(),id,user.id,reason]);
   await tx.query("UPDATE visits SET status='out',returned_at=NULL,ready_expires_at=NULL,capacity_paused=FALSE WHERE id=$1",[id]);
   await tx.query('UPDATE quizzes SET used=TRUE WHERE student_id=$1 AND used=FALSE',[student.id]);
   await promote(tx,String(previous.classroom_id));
  });
 }
 async submitReport(user:User,input:ReportInput) {return this.db.transaction(async tx=>{await currentActor(tx,user,'teacher',true,true);return submitProblemReport(tx,user.id,input);});}
 async problemReports(user:User,filters:ReportFilters={}) {await currentActor(this.db,user,'admin',true);return listProblemReports(this.db,filters);}
 async problemReport(user:User,id:string) {await currentActor(this.db,user,'admin',true);return problemReportDetail(this.db,id);}
 async changeReportStatus(user:User,id:string,status:'need_attention'|'solved') {return this.db.transaction(async tx=>{await currentActor(tx,user,'admin',true,true);await updateProblemReport(tx,user.id,id,status);});}
 async exportCsv(user:User,classroomId?:string):Promise<string> {
  const classroom=await this.selectedClass(user,classroomId);const {rows}=await this.db.query(`${visitSelect} WHERE v.classroom_id=$1 ORDER BY v.requested_at DESC`,[classroom.id]);
  const cell=(v:unknown)=>{let text=String(v??'');if(/^[\s]*[=+\-@]|^[\t\r]/.test(text))text=`'${text}`;return`"${text.replaceAll('"','""')}"`;};
  return[['Student','Class','Purpose','Status','Requested (UTC)','Left (UTC)','Returned (UTC)','Minutes'],...rows.map(r=>[`${r.first_name} ${r.last_name}`,r.classroom_name,r.purpose==='restroom'?'Restroom':r.purpose==='water'?'Drink Water':'',r.status,iso(r.requested_at),iso(r.left_at),iso(r.returned_at),r.left_at&&r.returned_at?((new Date(r.returned_at as string).getTime()-new Date(r.left_at as string).getTime())/60000).toFixed(1):''])].map(r=>r.map(cell).join(',')).join('\r\n');
 }
 async adminState(user:User):Promise<AdminState> {
  await currentActor(this.db,user,'admin');
  const {rows:queueClasses}=await this.db.query("SELECT DISTINCT classroom_id FROM visits WHERE status IN ('waiting','ready') ORDER BY classroom_id");
  for(const row of queueClasses)await this.maintainQueue(String(row.classroom_id));
  const [{rows:teachers},{rows:classes},{rows:students},{rows:[usage]}]=await Promise.all([
   this.db.query(`${teacherSelect} WHERE u.role='teacher' ORDER BY u.last_name,u.first_name`),this.db.query(`${classSelect} ORDER BY c.archived,t.last_name,c.name`),
   this.db.query(`SELECT u.*,e.classroom_id AS current_classroom_id,c.name AS classroom_name,c.teacher_id,t.first_name AS teacher_first_name,t.last_name AS teacher_last_name,(SELECT COUNT(*) FROM visits v WHERE v.student_id=u.id AND v.left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS visits_today FROM users u LEFT JOIN enrollments e ON e.student_id=u.id AND e.active=TRUE LEFT JOIN classrooms c ON c.id=e.classroom_id LEFT JOIN users t ON t.id=c.teacher_id WHERE u.role='student' ORDER BY u.last_name,u.first_name`),
   this.db.query("SELECT COUNT(*) AS total,COUNT(*) FILTER(WHERE left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS today,COUNT(*) FILTER(WHERE status='out') AS out,COUNT(*) FILTER(WHERE status='waiting') AS waiting FROM visits")
  ]);
  const teacherModels=teachers.map(teacherFrom);const studentModels:AdminStudent[]=students.map(row=>({...rosterFrom(row),classroomName:nullable(row.classroom_name),teacherId:nullable(row.teacher_id),teacherName:row.teacher_id?`${row.teacher_first_name} ${row.teacher_last_name}`:null}));
  const {rows:[tickets]}=await this.db.query("SELECT COUNT(*) AS n FROM problem_reports WHERE status='need_attention'");
  return{user,attentionTickets:Number(tickets.n),teachers:teacherModels,classes:classes.map(classroomFrom),students:studentModels,stats:{teachers:teachers.length,activeTeachers:teacherModels.filter(t=>t.enabled).length,inactiveTeachers:teacherModels.filter(t=>!t.enabled).length,activeClasses:classes.filter(c=>!c.archived).length,students:studentModels.filter(s=>s.registered).length,tripsToday:Number(usage.today),totalTrips:Number(usage.total),out:Number(usage.out),waiting:Number(usage.waiting)}};
 }
 async adminClass(user:User,id:string):Promise<ClassDetail> {
  await currentActor(this.db,user,'admin');const {rows:[classroom]}=await this.db.query(`${classSelect} WHERE c.id=$1`,[id]);if(!classroom)throw new AppError(404,'Class not found.');
  await this.maintainQueue(id);
  const [{rows:students},{rows:visits}]=await Promise.all([this.db.query(`${rosterSelect} WHERE e.classroom_id=$1 ORDER BY u.last_name,u.first_name`,[id]),this.db.query(`${visitSelect} WHERE v.classroom_id=$1 AND (v.status IN ('waiting','ready','out') OR v.id IN (SELECT id FROM visits WHERE classroom_id=$1 AND status IN ('returned','cancelled') ORDER BY requested_at DESC,id DESC LIMIT 1000)) ORDER BY v.requested_at DESC,v.id DESC`,[id])]);return{classroom:classroomFrom(classroom),students:students.map(rosterFrom),visits:visits.map(visitFrom)};
 }
 async createTeacher(user:User,input:z.infer<typeof teacherCreateSchema>):Promise<TeacherAccount> {
  await currentActor(this.db,user,'admin',true);const hash=await hashPassword(input.password);const id=randomUUID();
  const {rows:[row]}=await this.db.query("INSERT INTO users(id,role,first_name,last_name,username,email,password_hash,classroom_id,enabled,must_change_password) VALUES($1,'teacher',$2,$3,$4,$5,$6,NULL,$7,TRUE) RETURNING *",[id,input.firstName,input.lastName,input.username,input.email ?? null,hash,input.enabled]);return teacherFrom(row);
 }
 async updateTeacher(user:User,id:string,input:z.infer<typeof teacherUpdateSchema>) {
  await currentActor(this.db,user,'admin',true);const hash=input.password?await hashPassword(input.password):undefined;
  await this.db.transaction(async tx=>{await currentActor(tx,user,'admin',true);const {rows:[current]}=await tx.query("SELECT * FROM users WHERE id=$1 AND role='teacher' FOR UPDATE",[id]);if(!current)throw new AppError(404,'Teacher account not found.');
   await tx.query('UPDATE users SET first_name=$1,last_name=$2,username=$3,email=$4,enabled=$5,password_hash=$6,must_change_password=$7 WHERE id=$8',[input.firstName??current.first_name,input.lastName??current.last_name,input.username??current.username,input.email!==undefined?input.email:current.email,input.enabled??current.enabled,hash??current.password_hash,hash?true:current.must_change_password,id]);
   if(input.enabled===false||hash)await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);
  });
 }
 async updateAdminProfile(user:User,input:z.infer<typeof adminProfileSchema>) {const current=await currentActor(this.db,user,'admin',true);await this.db.query("UPDATE users SET first_name=$1,last_name=$2,email=$3 WHERE id=$4 AND role='admin' AND username=$5",[input.firstName,input.lastName,input.email!==undefined?input.email:current.email,user.id,ADMIN_USERNAME]);}
}
