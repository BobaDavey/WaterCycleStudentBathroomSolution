import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, SQL } from './db';
import { AppError, hashPassword, userFrom, usernameFor, verifyPassword } from './auth';
import { allowedAdministrator, reservedAdministratorUsername } from './bootstrap-admin';
import type { BreakPurpose, AdminState, AdminStudent, ClassDetail, Classroom, Question, Quiz, QuizResult, RosterStudent, StudentDetail, StudentState, StudentEnrollment, TeacherAccount, TeacherState, User, Visit } from './contracts';
import { isClassInSession } from './class-schedule';
import { DEFAULT_TIME_ZONE, effectiveTimeZone } from './time-zones';
import { classroomScope, assertClassroomTeacher } from './classroom-access';
import { eligibleQuestionPredicate, questionFromRow, questionLibrary, defaultQuestionSet, linkQuestion, assertSet, assertQuestion, createQuestionSet, questionSetSchema } from './question-sets';
import { defaultQuestions } from './default-questions';
import { submitProblemReport, listProblemReports, problemReportDetail, updateProblemReport, type ReportInput, type ReportFilters } from './problem-reports';
import { loadRuleOffenders, type RuleOffendersFilters } from './rule-offenders';

const name = z.string().trim().min(1, 'Please enter a name.').max(50);
const password = z.string().min(8, 'Passwords must have at least 8 characters.').max(128);
const username = z.string().trim().min(2).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._@+\-]*$/, 'Use letters, numbers, or an email address for the username.').transform(v => v.toLowerCase()).refine(v => !reservedAdministratorUsername(v), 'That username is reserved for the administrator.');
const email = z.union([z.email().max(254), z.literal(''), z.null()]).transform(v => v || null).optional();
const code = z.string().regex(/^[A-Za-z0-9]{5}$/, 'Enrollment codes must contain exactly five English letters or numbers.').transform(value => value.toUpperCase());
const className = z.string().trim().min(1, 'Please enter a class name.').max(100);
const period = z.string().trim().max(50).optional();
const timeZone = z.string().trim().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; } catch { return false; } }, 'Choose a valid IANA timezone, such as America/New_York.');
export const loginSchema = z.object({ username: z.string().trim().min(1).max(1024), password: z.string().min(1).max(128), role: z.enum(['student','teacher','admin']) });
export const signupSchema = z.object({ firstName: name, lastName: name, password });
export const enrollmentSchema = z.object({ classroomCode: code, classroomId: z.string().min(1).max(200).optional() });
export const setupSchema = z.object({}).passthrough();
const wallTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Choose a valid class time.');
export const classCreateSchema = z.object({ name: className, period, code, timeZone: timeZone.optional(), startTime: wallTime, endTime: wallTime }).refine(v=>v.startTime<v.endTime, 'Class end must be after start. Identical and overnight times are not supported.');
export const classUpdateSchema = z.object({ name: className.optional(), period: z.union([z.string().trim().max(50), z.null()]).optional(), code: code.optional(), archived: z.boolean().optional(), timeZone: timeZone.optional(), startTime: wallTime.optional(), endTime: wallTime.optional() }).refine(v => Object.keys(v).length > 0, 'Choose a change.');
export const classroomSchema = classUpdateSchema;
export const questionSchema = z.object({ prompt: z.string().trim().min(8).max(1000), options: z.array(z.string().trim().min(1).max(300)).length(4), correctIndex: z.number().int().min(0).max(3), topic: z.string().trim().min(1).max(80), explanation: z.string().trim().max(2000).default(''), active: z.boolean().default(true), setIds:z.array(z.string().min(1).max(200)).max(200).optional() }).refine(q => new Set(q.options.map(s => s.toLowerCase())).size === 4, { message: 'Each answer option must be different.' });
export const rosterSchema = z.object({ username:z.string().trim().min(1).max(100).transform(v=>v.toLowerCase()),studentId:z.string().min(1).max(200) });
export const rosterUpdateSchema = z.object({ enabled: z.boolean().optional(), accountStatus: z.enum(['active','deactivated']).optional(), password: password.optional() }).refine(v => v.enabled !== undefined || v.accountStatus !== undefined || v.password !== undefined, 'Choose a change.');
export const transferSchema = z.object({ classroomId: z.string().min(1).max(200) });
export const passwordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
export const submitSchema = z.object({ quizId: z.string().uuid(), answers: z.array(z.number().int().min(0).max(3)).length(2) });
export const teacherCreateSchema = z.object({ firstName: name, lastName: name, username, email, password, enabled: z.boolean().default(true) });
export const teacherUpdateSchema = z.object({ firstName: name.optional(), lastName: name.optional(), username: username.optional(), email, password: password.optional(), enabled: z.boolean().optional() }).refine(v => Object.values(v).some(value => value !== undefined), 'Choose a change.');
export const adminProfileSchema = z.object({ firstName: name, lastName: name, email });

type Row = Record<string, unknown>;
function iso(value: unknown): string | null { return value ? new Date(value as string | Date).toISOString() : null; }
function nullable(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
export function classroomFrom(row: Row): Classroom { return { id: String(row.id), teacherId: String(row.teacher_id), teacherName: `${row.teacher_first_name ?? ''} ${row.teacher_last_name ?? ''}`.trim() || undefined, name: String(row.name), period: nullable(row.period), code: nullable(row.code), timeZone: effectiveTimeZone(row.time_zone as string | null), legacyCode: nullable(row.legacy_code), capacity: Number(row.capacity), startTime: nullable(row.start_time), endTime: nullable(row.end_time), scheduleDays: (row.schedule_days ?? [1,2,3,4,5]) as number[], archived: Boolean(row.archived), studentCount: Number(row.student_count || 0) }; }
const questionFrom=questionFromRow;
function visitFrom(row: Row): Visit { return { id: String(row.id), studentId: String(row.student_id), studentName: `${row.first_name} ${row.last_name}`, studentUsername: String(row.username??''), classroomId: String(row.classroom_id), classroomName: String(row.classroom_name ?? ''), timeZone: effectiveTimeZone(row.classroom_time_zone as string | null), status: row.status as Visit['status'], cancellationReason: nullable(row.cancellation_reason), purpose: (row.purpose ?? null) as BreakPurpose | null, requestedAt: iso(row.requested_at)!, readyAt: iso(row.ready_at), readyExpiresAt: iso(row.ready_expires_at), reservationPaused: Boolean(row.capacity_paused), leftAt: iso(row.left_at), returnedAt: iso(row.returned_at), warningAcknowledgedAt: iso(row.warning_acknowledged_at), corrections: (row.corrections ?? []) as Visit['corrections'] }; }
function rosterFrom(row: Row): RosterStudent { return { enrollmentId: String(row.enrollment_id ?? ''), accountSuspended: Boolean(row.account_suspended), enrollmentStatus: (row.enrollment_status ?? 'pending') as RosterStudent['enrollmentStatus'], id: String(row.id), firstName: String(row.first_name), lastName: String(row.last_name), username: String(row.username), enabled: Boolean(row.enabled), accountStatus: row.enrollment_status === 'approved' ? 'active' : (row.enrollment_status ?? row.account_status) as RosterStudent['accountStatus'], registeredAt: iso(row.registered_at ?? row.created_at)!, approvedAt: iso(row.enrollment_approved_at), registered: Boolean(row.password_hash), mustChangePassword: Boolean(row.must_change_password), visitsToday: Number(row.visits_today || 0), classroomId: nullable(row.current_classroom_id ?? row.classroom_id) }; }
function teacherFrom(row: Row): TeacherAccount { return { id: String(row.id), firstName: String(row.first_name), lastName: String(row.last_name), username: String(row.username), email: nullable(row.email), enabled: Boolean(row.enabled), mustChangePassword: Boolean(row.must_change_password), classCount: Number(row.class_count || 0), studentCount: Number(row.student_count || 0), createdAt: iso(row.created_at)! }; }
function assertRole(user: User, role: User['role']) { if (user.role !== role) throw new AppError(403, role === 'admin' ? 'Administrator access required.' : role === 'teacher' ? 'Teacher access required.' : 'This action is for students.'); }
export function requirePasswordChange(user: User) { if (user.mustChangePassword) throw new AppError(403, 'Please change your temporary password before continuing.'); }
async function currentActor(tx: SQL, user: User, role: User['role'], changing = false, lock = false) {
 assertRole(user,role);
 const { rows: [row] } = await tx.query(`SELECT * FROM users WHERE id=$1 AND role=$2 AND (enabled=TRUE OR role='student')${lock?' FOR UPDATE':''}`, [user.id,role]);
 if (!row || (role === 'admin' && !allowedAdministrator(tx,row.username))) throw new AppError(403, 'Your account is unavailable. Please sign in again.');
 if (changing && row.must_change_password) throw new AppError(403, 'Please change your temporary password before continuing.');
 return row;
}
async function lockClasses(tx: SQL, ids: (string | null | undefined)[]) { for (const id of [...new Set(ids.filter((id): id is string => Boolean(id)))].sort()) await tx.query('SELECT id FROM classrooms WHERE id=$1 FOR UPDATE',[id]); }
async function serverClock(tx: SQL, override?: Date): Promise<Date> {
 if(override)return override;
 const {rows:[row]}=await tx.query('SELECT statement_timestamp() AS now');return new Date(row.now as string);
}
async function checkStudentAccess(tx: SQL, user: User, classroomId: string, allowInactive = false, now?: Date) {
 const current=await currentActor(tx,user,'student',true,true);
 if(allowInactive)return current; // Returns remain possible after session/enrollment changes.
 if(current.account_suspended)throw new AppError(403,'Your account is currently deactivated. Please contact your school administrator.');
 const {rows:[membership]}=await tx.query(`SELECT c.*,e.status,t.enabled AS teacher_enabled FROM enrollments e JOIN classrooms c ON c.id=e.classroom_id JOIN users t ON t.id=c.teacher_id WHERE e.student_id=$1 AND e.classroom_id=$2 AND e.active=TRUE FOR SHARE OF t`,[user.id,classroomId]);
 if(!membership)throw new AppError(403,'You are not enrolled in this class. Join it from My Classes first.');
 if(membership.status!=='approved')throw new AppError(403,membership.status==='pending'?'Your enrollment is awaiting teacher approval.':'Your enrollment is deactivated. Please contact this class’s teacher.');
 if(membership.archived||!membership.teacher_enabled)throw new AppError(409,'This class is inactive. Your records are preserved.');
 if(!isClassInSession(classroomFrom(membership),await serverClock(tx,now)))throw new AppError(409,'Class Not in Session. New breaks are only available during the scheduled Monday–Friday session. Ask your teacher to configure missing class times.');
 return current;
}
// Every caller holds the classroom row lock, so reservations and available spots
// have a single ordering even when different students poll or answer together.
async function promote(tx: SQL, classroomId: string, now?: Date) {
 const { rows: [classroom] } = await tx.query('SELECT c.*,t.enabled AS teacher_enabled FROM classrooms c JOIN users t ON t.id=c.teacher_id WHERE c.id=$1',[classroomId]);
 if (!classroom) return;
 await tx.query(`UPDATE visits v SET status='cancelled' WHERE v.classroom_id=$1 AND v.status IN ('waiting','ready') AND (
  (v.status='ready' AND v.capacity_paused=FALSE AND (v.ready_expires_at IS NULL OR v.ready_expires_at<=statement_timestamp())) OR
  NOT EXISTS(SELECT 1 FROM users u JOIN enrollments e ON e.student_id=u.id AND e.active=TRUE WHERE u.id=v.student_id AND u.account_suspended=FALSE AND u.must_change_password=FALSE AND e.status='approved' AND e.classroom_id=$1)
 )`,[classroomId]);
 if (classroom.archived || !classroom.teacher_enabled || !isClassInSession(classroomFrom(classroom),await serverClock(tx,now))) {
  await tx.query("UPDATE visits SET status='cancelled',cancellation_reason='This class session ended or became inactive. Your waiting request was cancelled; active break timers continue.' WHERE classroom_id=$1 AND status IN ('waiting','ready')",[classroomId]);
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
 return {classroomId:String(row.classroom_id),id:String(row.id),purpose:row.purpose as BreakPurpose,correctCount:Number(row.correct_count),question:{id:question.id,prompt:question.prompt,options:question.options,topic:question.topic},questionToken:String(row.question_token),expiresAt:iso(row.expires_at)!,...((row.answer_history as AnswerRecord[]).length>=questions.length?{notice:'You have worked through the question bank. Questions may repeat as you work toward two correct answers.'}:{})};
}
async function attachEnrollment(tx: SQL, studentId: string, classroomId: string, status = 'pending') {
 await tx.query(`INSERT INTO enrollments(id,student_id,classroom_id,active,status) VALUES($1,$2,$3,TRUE,$4)
 ON CONFLICT(student_id,classroom_id) DO UPDATE SET active=TRUE,status=$4,joined_at=statement_timestamp(),left_at=NULL,approved_at=NULL,approved_by=NULL WHERE enrollments.active=FALSE`,[randomUUID(),studentId,classroomId,status]);
 // Legacy pointer is a convenience/default only, never an authorization source.
 await tx.query('UPDATE users SET classroom_id=$1 WHERE id=$2 AND classroom_id IS NULL',[classroomId,studentId]);
}
async function allocatedUsername(tx: SQL, first: string, last: string): Promise<string> {
 const base=usernameFor(first,last)||'student';
 // Reserve numbers atomically. The high-water mark survives renames/deletions.
 const {rows:[existing]}=await tx.query<{n:string}>(`SELECT COALESCE(MAX(substring(username FROM length($1::text)+1)::bigint),0)+1 AS n FROM users WHERE left(username,length($1::text))=$1 AND substring(username FROM length($1::text)+1) ~ '^[0-9]{2,12}$'`,[base]);
 const {rows:[counter]}=await tx.query<{n:string}>(`INSERT INTO student_username_counters(base,next_number) VALUES($1,$2::bigint+1)
 ON CONFLICT(base) DO UPDATE SET next_number=GREATEST(student_username_counters.next_number,$2::bigint)+1 RETURNING (next_number-1)::text AS n`,[base,existing.n]);
 return base+counter.n.padStart(2,'0');
}
const classSelect = `SELECT c.*,t.first_name AS teacher_first_name,t.last_name AS teacher_last_name,t.enabled AS teacher_enabled,(SELECT COUNT(*) FROM enrollments e WHERE e.classroom_id=c.id AND e.active=TRUE) AS student_count FROM classrooms c JOIN users t ON t.id=c.teacher_id`;
const visitSelect = `SELECT v.*,u.first_name,u.last_name,u.username,c.name AS classroom_name,c.time_zone AS classroom_time_zone,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',bc.id,'teacherName',a.first_name||' '||a.last_name,'correctedAt',bc.corrected_at,'incorrectReturnedAt',bc.incorrect_returned_at,'reason',bc.reason) ORDER BY bc.corrected_at,bc.id) FROM break_corrections bc JOIN users a ON a.id=bc.teacher_id WHERE bc.visit_id=v.id),'[]'::jsonb) AS corrections
 FROM visits v JOIN users u ON u.id=v.student_id JOIN classrooms c ON c.id=v.classroom_id`;
const rosterSelect = `SELECT u.*,e.id AS enrollment_id,e.status AS enrollment_status,e.approved_at AS enrollment_approved_at,e.classroom_id AS current_classroom_id,(SELECT COUNT(*) FROM visits v WHERE v.student_id=u.id AND v.classroom_id=e.classroom_id AND v.left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS visits_today FROM users u JOIN enrollments e ON e.student_id=u.id AND e.active=TRUE`;
const teacherSelect = `SELECT u.*,(SELECT COUNT(*) FROM classrooms c WHERE c.teacher_id=u.id) AS class_count,(SELECT COUNT(DISTINCT e.student_id) FROM enrollments e JOIN classrooms c ON c.id=e.classroom_id WHERE c.teacher_id=u.id AND e.active=TRUE) AS student_count FROM users u`;
const emptyStats = {out:0,ready:0,waiting:0,tripsToday:0,averageMinutes:0};

export class WaterCycle {
 constructor(readonly db: Database, private readonly clock?: () => Date) {}
 private promote(tx: SQL, id: string) { return promote(tx,id,this.clock?.()); }
 async login(input: z.infer<typeof loginSchema>, connection: SQL = this.db): Promise<User> {
  const { rows: [row] } = await connection.query('SELECT * FROM users WHERE username=$1 AND role=$2 FOR UPDATE', [input.username.toLowerCase(), input.role]);
  if (!row && this.db.localDevelopment && process.env.NODE_ENV!=='production' && ['teachertest','teststudent'].includes(input.username.toLowerCase())) console.warn('Local demo account not initialized. Stop the server and run npm run dev:setup. Existing account passwords are never reset.');
  if (!await verifyPassword(input.password, row?.password_hash as string | null) || (!row?.enabled && row?.role!=='student') || (input.role === 'admin' && !allowedAdministrator(connection,row.username))) throw new AppError(401, 'The username or password is incorrect.');
  if (this.db.localDevelopment && process.env.NODE_ENV !== 'production' && row.role==='student' && row.account_suspended) console.info('Local student sign-in: account-wide suspension is active. Contact the administrator; class enrollment permissions remain separate.');
  return userFrom(row);
 }
 async setup(_input?: unknown): Promise<User> { throw new AppError(410,'Teacher accounts are created by the administrator. Public teacher registration is unavailable.'); }
 async seedQuestions(tx: SQL, classroomId: string) { const setId=await defaultQuestionSet(tx,classroomId);for (const q of defaultQuestions) {const id=randomUUID();await tx.query('INSERT INTO questions(id,classroom_id,prompt,options,correct_index,topic,explanation,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,classroomId,q.prompt,JSON.stringify(q.options),q.correctIndex,q.topic,q.explanation,q.active]);await linkQuestion(tx,setId,id);} }
 async signup(input: z.infer<typeof signupSchema>): Promise<User> {
  input=signupSchema.parse(input);
  const hash=await hashPassword(input.password);
  return this.db.transaction(async tx=>{
   for(let retry=0;retry<100;retry++){
    const login=await allocatedUsername(tx,input.firstName,input.lastName);
    const {rows:[student]}=await tx.query(`INSERT INTO users(id,role,first_name,last_name,username,password_hash,tutorial_completed,account_status) VALUES($1,'student',$2,$3,$4,$5,FALSE,'active') ON CONFLICT(username) DO NOTHING RETURNING *`,[randomUUID(),input.firstName,input.lastName,login,hash]);
    if(student)return userFrom(student);
   }
   throw new AppError(409,'Could not assign a username. Please try again.');
  });
 }
 async previewEnrollment(user:User,classroomCode:string):Promise<Classroom> {
  await currentActor(this.db,user,'student',true);
  const {rows:[classroom]}=await this.db.query(`${classSelect} WHERE c.code=$1 AND c.archived=FALSE AND t.enabled=TRUE`,[normalizedCode(classroomCode)]);
  if(!classroom)throw new AppError(400,'That enrollment code is invalid or belongs to an inactive class. Check the five-character code with your teacher.');
  return classroomFrom(classroom);
 }
 async enrollStudent(user: User, classroomCode: string, expectedClassroomId?: string) {
  classroomCode=normalizedCode(classroomCode);
  assertRole(user,'student');requirePasswordChange(user);
  return this.db.transaction(async tx=>{
   const {rows:[classroom]}=await tx.query(`SELECT c.* FROM classrooms c JOIN users t ON t.id=c.teacher_id WHERE c.code=$1 AND c.archived=FALSE AND t.enabled=TRUE FOR UPDATE OF c`,[classroomCode]);
   if(!classroom)throw new AppError(400,'That enrollment code is invalid or belongs to an inactive class. Check with your teacher.');
   if(expectedClassroomId&&expectedClassroomId!==classroom.id)throw new AppError(409,'That class code changed. Find the class again and confirm its current teacher.');
   const current=await currentActor(tx,user,'student',true,true);
   if(current.account_suspended)throw new AppError(403,'Your account is currently deactivated. Please contact your school administrator.');
   const {rows:[existing]}=await tx.query('SELECT id,active FROM enrollments WHERE student_id=$1 AND classroom_id=$2',[user.id,classroom.id]);
   if(existing?.active)throw new AppError(409,'You have already joined this class. Its teacher manages your approval status.');
   await attachEnrollment(tx,user.id,String(classroom.id));
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
  await this.db.transaction(async tx=>{await lockClasses(tx,[classroomId]);await this.promote(tx,classroomId);});
 }
 async studentState(user: User): Promise<StudentState> {
  assertRole(user,'student');
  for(let retry=0;retry<3;retry++){
   const discover=async(connection:SQL)=>(await connection.query<{classroom_id:string}>(`SELECT classroom_id FROM enrollments WHERE student_id=$1 AND active=TRUE UNION SELECT classroom_id FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out') UNION SELECT classroom_id FROM quizzes WHERE student_id=$1 AND used=FALSE`,[user.id])).rows.map(row=>row.classroom_id).sort();
   const ids=await discover(this.db);
   const state=await this.db.transaction(async tx=>{
    await lockClasses(tx,ids);const freshUser=userFrom(await currentActor(tx,user,'student',false,true));
    if(JSON.stringify(ids)!==JSON.stringify(await discover(tx)))return null;
    const now=await serverClock(tx);
    const {rows:memberships}=await tx.query(`${classSelect} JOIN enrollments e ON e.classroom_id=c.id AND e.student_id=$1 AND e.active=TRUE ORDER BY c.name,c.id`,[user.id]);
    const {rows:permissions}=await tx.query('SELECT * FROM enrollments WHERE student_id=$1 AND active=TRUE',[user.id]);
    const enrollments:StudentEnrollment[]=[];
    for(const row of memberships){
     const classroom=classroomFrom(row),permission=permissions.find(e=>e.classroom_id===classroom.id)!;
     const inSession=isClassInSession(classroom,this.clock?.()??now);
     const unavailableReason=freshUser.accountStatus==='deactivated'?'Your account is currently deactivated. Contact your school administrator.':freshUser.mustChangePassword?'Please change your temporary password.':permission.status==='pending'?'Waiting for Teacher Approval.':permission.status==='deactivated'?'This enrollment is deactivated. Contact this class’s teacher.':classroom.archived||!row.teacher_enabled?'This class is inactive.':!classroom.startTime?'Your teacher needs to configure this class schedule.':!inSession?'Class Not in Session':undefined;
     enrollments.push({id:String(permission.id),classroom,status:permission.status as StudentEnrollment['status'],joinedAt:iso(permission.joined_at)!,approvedAt:iso(permission.approved_at),inSession,eligible:!unavailableReason,unavailableReason});
    }
    for(const id of ids)await this.promote(tx,id);
    const {rows:visits}=await tx.query(`${visitSelect} WHERE v.student_id=$1 AND (v.status IN ('waiting','ready','out') OR v.id IN (SELECT id FROM visits WHERE student_id=$1 AND status IN ('returned','cancelled') ORDER BY requested_at DESC,id DESC LIMIT 10)) ORDER BY v.requested_at DESC,v.id DESC`,[user.id]);
    const currentRow=visits.find(row=>['waiting','ready','out'].includes(String(row.status))),currentVisit=currentRow?visitFrom(currentRow):null;
    const {rows:[attempt]}=await tx.query('SELECT * FROM quizzes WHERE student_id=$1 AND used=FALSE AND expires_at>statement_timestamp() ORDER BY expires_at DESC,id DESC LIMIT 1',[user.id]);
    const eligible=enrollments.filter(e=>e.eligible);
    const focus=enrollments.find(e=>e.classroom.id===currentVisit?.classroomId)||enrollments.find(e=>e.classroom.id===attempt?.classroom_id)||eligible[0]||enrollments[0];
    const classroom=focus?.classroom??null;
    const {rows:[counts]}=await tx.query("SELECT COUNT(*) FILTER(WHERE status IN ('ready','out')) AS active,COUNT(*) FILTER(WHERE status='waiting') AS waiting FROM visits WHERE classroom_id=$1",[classroom?.id??null]);
    const {rows:[questions]}=await tx.query(`SELECT COUNT(*) AS n FROM questions q WHERE ${eligibleQuestionPredicate}`,[classroom?.id??null]);
    if(currentVisit?.status==='waiting'){const {rows:waiting}=await tx.query("SELECT id FROM visits WHERE classroom_id=$1 AND status='waiting' ORDER BY requested_at,id",[currentVisit.classroomId]);currentVisit.position=waiting.findIndex(v=>v.id===currentVisit.id)+1;}
    const canRequestPass=eligible.length>0;
    const activeQuiz=attempt&&enrollments.find(e=>e.classroom.id===attempt.classroom_id)?.eligible&&!currentVisit?quizFrom(attempt):null;
    if(attempt&&!activeQuiz&&!currentVisit)await tx.query('UPDATE quizzes SET used=TRUE WHERE id=$1',[attempt.id]);
    return{user:freshUser,enrollments,eligibleClassroomIds:eligible.map(e=>e.classroom.id),classroom,currentVisit,activeQuiz,serverNow:now.toISOString(),activeCount:Number(counts.active),waitingCount:Number(counts.waiting),recentVisits:visits.filter(v=>['returned','cancelled'].includes(String(v.status))).slice(0,10).map(visitFrom),availableQuestions:Number(questions.n),canRequestPass,unavailableReason:!canRequestPass?'You can only request a break during a class you are approved to attend. Please check your class schedule or enrollment status.':undefined};
   });
   if(state)return state;
  }
  throw new AppError(409,'Your enrollments changed while loading. Please refresh.');
 }
 async newQuiz(user: User, purpose: BreakPurpose, requestedClassroomId?: string): Promise<Quiz> {
  assertRole(user,'student');requirePasswordChange(user);
  if(purpose!=='restroom'&&purpose!=='water')throw new AppError(400,'Choose Use Restroom or Drink Water before starting the questions.');
  let classroomId=requestedClassroomId;
  if(!classroomId){const state=await this.studentState(user);if(state.eligibleClassroomIds.length!==1)throw new AppError(!state.eligibleClassroomIds.length&&state.enrollments.length&&!state.enrollments.some(e=>e.status==='approved')?403:409,state.eligibleClassroomIds.length?'Choose which class you are attending.':'No Eligible Class in Session. You can only request a break during an approved class session; pending enrollments need teacher approval and deactivated enrollments cannot request breaks.');classroomId=state.eligibleClassroomIds[0];}
  return this.db.transaction(async tx=>{
   await lockClasses(tx,[classroomId]);await checkStudentAccess(tx,user,classroomId,false,this.clock?.());
   await this.promote(tx,classroomId);
   const {rows:active}=await tx.query("SELECT id FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out')",[user.id]);
   if(active.length)throw new AppError(409,'You already have a break or a place in line.');
   const {rows:[existing]}=await tx.query('SELECT * FROM quizzes WHERE student_id=$1 AND used=FALSE AND expires_at>statement_timestamp() ORDER BY expires_at DESC,id DESC LIMIT 1 FOR UPDATE',[user.id]);
   if(existing&&existing.classroom_id!==classroomId)throw new AppError(409,'Finish or cancel your learning check in the other class first.');
   if(existing){if(existing.purpose!==purpose)throw new AppError(409,'You already started a request for another purpose. Cancel that learning session before choosing a different purpose.');return quizFrom(existing);}
   const {rows}=await tx.query(`SELECT q.* FROM questions q WHERE ${eligibleQuestionPredicate} ORDER BY RANDOM()`,[classroomId]);
   if(rows.length<2)throw new AppError(409,'This class needs at least two active questions in its active Question Sets. Please ask your teacher to manage active sets.');
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
   await lockClasses(tx,[classroomId]);await checkStudentAccess(tx,user,classroomId,false,this.clock?.());
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
    await this.promote(tx,classroomId);
    const {rows:active}=await tx.query("SELECT id FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out')",[user.id]);
    if(active.length)throw new AppError(409,'You already have an active break request.');
    const {rows:[capacity]}=await tx.query("SELECT c.capacity,(SELECT COUNT(*) FROM visits WHERE classroom_id=c.id AND status IN ('ready','out')) AS occupied,(SELECT COUNT(*) FROM visits WHERE classroom_id=c.id AND status='waiting') AS waiting FROM classrooms c WHERE c.id=$1",[classroomId]);
    const immediate=Number(capacity.occupied)<Number(capacity.capacity)&&Number(capacity.waiting)===0;
    const departed=await serverClock(tx);const {rows:[scheduled]}=await tx.query('SELECT * FROM classrooms WHERE id=$1',[classroomId]);
    if(!isClassInSession(classroomFrom(scheduled),this.clock?.()??departed))throw new AppError(409,'Class Not in Session. The session ended before your request completed.');
    const id=randomUUID();await tx.query("INSERT INTO visits(id,classroom_id,student_id,status,purpose,requested_at,left_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $4='out' THEN $6::timestamptz ELSE NULL END)",[id,classroomId,user.id,immediate?'out':'waiting',quiz.purpose,departed.toISOString()]);
    await tx.query('UPDATE quizzes SET used=TRUE,correct_count=2,answer_history=$1,visit_id=$2 WHERE id=$3',[JSON.stringify(history),id,quiz.id]);
    if(!immediate)await this.promote(tx,classroomId);
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
   await lockClasses(tx,[classroomId]);await checkStudentAccess(tx,user,classroomId,action!=='leave',this.clock?.());await this.promote(tx,classroomId);
   const {rows:[visit]}=await tx.query("SELECT * FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out') FOR UPDATE",[user.id]);
   if(!visit||visit.classroom_id!==classroomId)return 'Your reservation expired or your pass changed. Please refresh.';
   if(action==='leave') {if(visit.status!=='ready')return 'Please wait for your turn before leaving.';const {rows:[occupied]}=await tx.query("SELECT (SELECT COUNT(*) FROM visits WHERE classroom_id=$1 AND status='out') AS n,capacity FROM classrooms WHERE id=$1",[classroomId]);if(Number(occupied.n)>=Number(occupied.capacity))return 'All spots are occupied after a teacher correction. Keep your place and wait for a spot to open.';const departed=await serverClock(tx);const {rows:[scheduled]}=await tx.query('SELECT * FROM classrooms WHERE id=$1',[classroomId]);if(!isClassInSession(classroomFrom(scheduled),this.clock?.()??departed))return 'Class Not in Session. The session ended before departure.';await tx.query("UPDATE visits SET status='out',left_at=$2,ready_expires_at=NULL,capacity_paused=FALSE WHERE id=$1",[visit.id,departed.toISOString()]);}
   else if(action==='return') {if(visit.status!=='out')return 'You can record your return after you have left.';await tx.query("UPDATE visits SET status='returned',returned_at=statement_timestamp() WHERE id=$1",[visit.id]);}
   else {if(visit.status==='out')return 'Use I’m back to finish your current trip.';await tx.query("UPDATE visits SET status='cancelled' WHERE id=$1",[visit.id]);}
   await this.promote(tx,classroomId);return null;
  });
  if(error)throw new AppError(409,error);
 }
 private async accessibleClass(user: User, requested?: string, connection: SQL=this.db, lock=false):Promise<Row|null> {
  await currentActor(connection,user,'teacher');
  if(requested) {if(lock)await lockClasses(connection,[requested]);const {rows:[row]}=await connection.query(`${classSelect} WHERE c.id=$1 AND ${classroomScope('c','$2')}`,[requested,user.id]);if(!row)throw new AppError(404,'Class not found.');return row;}
  const {rows}=await connection.query(`${classSelect} WHERE ${classroomScope('c','$1')} ORDER BY c.archived,c.name,c.id`,[user.id]);
  const row=rows.find(r=>!r.archived&&r.id===user.classroomId)||rows.find(r=>!r.archived)||rows[0]||null;
  if(row&&lock){await lockClasses(connection,[String(row.id)]);return this.accessibleClass(user,String(row.id),connection);}return row;
 }
 private async selectedClass(user: User, requested?: string, connection:SQL=this.db, lock=false):Promise<Row> {const row=await this.accessibleClass(user,requested,connection,lock);if(!row)throw new AppError(400,'Create a class before managing students, questions, or passes.');return row;}
 async teacherState(user: User, classroomId?: string): Promise<TeacherState> {
  const classroom=await this.accessibleClass(user,classroomId);
  const {rows:classes}=await this.db.query(`${classSelect} WHERE ${classroomScope('c','$1')} ORDER BY c.archived,c.name,c.id`,[user.id]);
  const {rows:pending}=await this.db.query(`${rosterSelect} JOIN classrooms c ON c.id=e.classroom_id WHERE ${classroomScope('c','$1')} AND e.status='pending' AND u.password_hash IS NOT NULL AND ($2::text IS NULL OR c.id=$2) ORDER BY e.joined_at,e.id`,[user.id,classroom?.id??null]);
  const pendingStudents=pending.map(row=>({...rosterFrom(row),classroomName:String(classes.find(c=>c.id===row.current_classroom_id)?.name??''),period:nullable(classes.find(c=>c.id===row.current_classroom_id)?.period)}));
  if(!classroom)return{user,pendingStudents,classes:classes.map(classroomFrom),classroom:null,students:[],questions:[],questionSets:[],activeSetIds:[],eligibleQuestionCount:0,teachers:[],visits:[],stats:{...emptyStats}};
  const id=String(classroom.id);
  await this.maintainQueue(id);
  const [{rows:students},{rows:questions},{rows:visits},{rows:[stats]}]=await Promise.all([
   this.db.query(`${rosterSelect} WHERE e.classroom_id=$1 ORDER BY u.last_name,u.first_name`,[id]),
   this.db.query('SELECT * FROM questions WHERE classroom_id=$1 AND deleted=FALSE ORDER BY topic,prompt',[id]),
   this.db.query(`${visitSelect} WHERE v.classroom_id=$1 AND (v.status IN ('waiting','ready','out') OR v.id IN (SELECT id FROM visits WHERE classroom_id=$1 AND status IN ('returned','cancelled') ORDER BY requested_at DESC,id DESC LIMIT 1000)) ORDER BY v.requested_at DESC,v.id DESC`,[id]),
   this.db.query("SELECT COUNT(*) FILTER(WHERE status='out') AS out,COUNT(*) FILTER(WHERE status='ready') AS ready,COUNT(*) FILTER(WHERE status='waiting') AS waiting,COUNT(*) FILTER(WHERE left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS trips_today,AVG(EXTRACT(EPOCH FROM(returned_at-left_at))/60) FILTER(WHERE status='returned' AND left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS average_minutes FROM visits WHERE classroom_id=$1",[id])
  ]);
  const library=await questionLibrary(this.db,user,id);const teachers=await this.classroomTeachers(user,id);
  const visitModels=visits.map(visitFrom);visitModels.filter(v=>v.status==='waiting').sort((a,b)=>a.requestedAt.localeCompare(b.requestedAt)||a.id.localeCompare(b.id)).forEach((v,i)=>{v.position=i+1;});
  return{user,pendingStudents,classes:classes.map(classroomFrom),classroom:classroomFrom(classroom),students:students.map(rosterFrom),...library,teachers,visits:visitModels,stats:{out:Number(stats.out),ready:Number(stats.ready),waiting:Number(stats.waiting),tripsToday:Number(stats.trips_today),averageMinutes:Number(stats.average_minutes||0)}};
 }
 async createClass(user: User,input:z.infer<typeof classCreateSchema>):Promise<Classroom> {
  requirePasswordChange(user);input=classCreateSchema.parse(input);
  input={...input,code:normalizedCode(input.code),timeZone:timeZone.parse(input.timeZone ?? DEFAULT_TIME_ZONE)};
  requirePasswordChange(user);return this.db.transaction(async tx=>{
   await currentActor(tx,user,'teacher',true);const id=randomUUID();
   const {rows:[row]}=await tx.query('INSERT INTO classrooms(id,teacher_id,name,period,code,time_zone,start_time,end_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[id,user.id,input.name,input.period || null,input.code,input.timeZone,input.startTime??null,input.endTime??null]);
   await tx.query('UPDATE users SET classroom_id=$1 WHERE id=$2 AND classroom_id IS NULL',[id,user.id]);await this.seedQuestions(tx,id);return classroomFrom(row);
  });
 }
 async updateClass(user:User,id:string,input:z.infer<typeof classUpdateSchema>):Promise<Classroom> {
  if(input.code!==undefined)input={...input,code:normalizedCode(input.code)};
  if(input.timeZone!==undefined)input={...input,timeZone:timeZone.parse(input.timeZone)};
  requirePasswordChange(user);return this.db.transaction(async tx=>{
   const current=await this.selectedClass(user,id,tx,true);await currentActor(tx,user,'teacher',true);
   const start=input.startTime??nullable(current.start_time),end=input.endTime??nullable(current.end_time);
   if((input.startTime!==undefined||input.endTime!==undefined)&&(!start||!end||start>=end))throw new AppError(400,'Class end must be after start. Identical and overnight times are not supported.');
   const nextCode=input.code??nullable(current.code);const archived=input.archived??Boolean(current.archived);
   if(!archived&&!nextCode)throw new AppError(400,'Choose a five-character enrollment code before activating this class.');
   const {rows:[row]}=await tx.query('UPDATE classrooms SET name=$1,period=$2,code=$3,archived=$4,time_zone=$6,start_time=$7,end_time=$8 WHERE id=$5 RETURNING *',[input.name??current.name,input.period!==undefined?(input.period||null):current.period,nextCode,archived,id,input.timeZone??effectiveTimeZone(current.time_zone as string | null),start,end]);
   if(archived&&!current.archived){await tx.query("UPDATE visits SET status='cancelled' WHERE classroom_id=$1 AND status IN ('waiting','ready')",[id]);await tx.query('UPDATE quizzes SET used=TRUE WHERE classroom_id=$1 AND used=FALSE',[id]);}
   await this.promote(tx,id);
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
 async classroomTeachers(user:User,classroomId:string) {
  await this.selectedClass(user,classroomId);
  const {rows}=await this.db.query(`SELECT t.id,t.first_name,t.last_name,t.username,t.enabled,t.id=c.teacher_id AS primary_teacher FROM classrooms c JOIN users t ON t.id=c.teacher_id OR EXISTS(SELECT 1 FROM classroom_teachers ct WHERE ct.classroom_id=c.id AND ct.teacher_id=t.id AND ct.active=TRUE) WHERE c.id=$1 ORDER BY (t.id=c.teacher_id) DESC,t.last_name,t.first_name,t.id`,[classroomId]);
  return rows.map(t=>({id:String(t.id),firstName:String(t.first_name),lastName:String(t.last_name),username:String(t.username),enabled:Boolean(t.enabled),primary:Boolean(t.primary_teacher)}));
 }
 async addCoTeacher(user:User,classroomId:string,login:string) {
  return this.db.transaction(async tx=>{await assertClassroomTeacher(tx,user,classroomId,true);
   const {rows:[teacher]}=await tx.query("SELECT id FROM users WHERE username=$1 AND role='teacher' AND enabled=TRUE FOR SHARE",[login.trim().toLowerCase()]);
   if(!teacher)throw new AppError(404,'An existing active teacher username is required.');
   if(teacher.id===user.id)throw new AppError(409,'The Primary Teacher is already assigned to this class.');
   const {rows}=await tx.query('INSERT INTO classroom_teachers(classroom_id,teacher_id,added_by) VALUES($1,$2,$3) ON CONFLICT(classroom_id,teacher_id) DO UPDATE SET active=TRUE,removed_at=NULL,added_by=EXCLUDED.added_by,added_at=statement_timestamp() WHERE classroom_teachers.active=FALSE RETURNING teacher_id',[classroomId,teacher.id,user.id]);
   if(!rows.length)throw new AppError(409,'This teacher is already a co-teacher.');
  });
 }
 async removeCoTeacher(user:User,classroomId:string,teacherId:string) {
  await this.db.transaction(async tx=>{await assertClassroomTeacher(tx,user,classroomId,true);
   if(teacherId===user.id)throw new AppError(409,'Primary ownership cannot be removed or transferred.');
   const {rows}=await tx.query('UPDATE classroom_teachers SET active=FALSE,removed_at=statement_timestamp() WHERE classroom_id=$1 AND teacher_id=$2 AND active=TRUE RETURNING teacher_id',[classroomId,teacherId]);if(!rows.length)throw new AppError(404,'Co-teacher membership not found.');
  });
 }
 async saveQuestionSet(user:User,classroomId:string,input:z.infer<typeof questionSetSchema>,id?:string) {
  return this.db.transaction(async tx=>{const classroom=await assertClassroomTeacher(tx,user,classroomId);if(classroom.archived)throw new AppError(409,'Archived question banks are read-only.');
   if(!id)return createQuestionSet(tx,user,classroom,input);
   await assertSet(tx,user,classroomId,id);await tx.query('UPDATE question_sets SET name=$1,description=$2 WHERE id=$3',[input.name,input.description,id]);return{id};
  });
 }
 async deleteQuestionSet(user:User,classroomId:string,id:string) {
  await this.db.transaction(async tx=>{const classroom=await assertClassroomTeacher(tx,user,classroomId);if(classroom.archived)throw new AppError(409,'Archived question banks are read-only.');await assertSet(tx,user,classroomId,id);
   await tx.query('UPDATE quizzes SET used=TRUE WHERE used=FALSE AND classroom_id IN (SELECT classroom_id FROM classroom_question_sets WHERE set_id=$1 AND active=TRUE)',[id]);
   await tx.query('UPDATE question_sets SET deleted=TRUE WHERE id=$1',[id]);
  });
 }
 async setQuestionMembership(user:User,classroomId:string,setId:string,questionId:string,active:boolean) {
  await this.db.transaction(async tx=>{const classroom=await assertClassroomTeacher(tx,user,classroomId);if(classroom.archived)throw new AppError(409,'Archived question banks are read-only.');await assertSet(tx,user,classroomId,setId);await assertQuestion(tx,user,classroomId,questionId);
   await linkQuestion(tx,setId,questionId,active);
   await tx.query('UPDATE quizzes SET used=TRUE WHERE used=FALSE AND classroom_id IN (SELECT classroom_id FROM classroom_question_sets WHERE set_id=$1 AND active=TRUE)',[setId]);
  });
 }
 async setActiveQuestionSets(user:User,classroomId:string,setIds:string[]) {
  await this.db.transaction(async tx=>{const classroom=await assertClassroomTeacher(tx,user,classroomId);if(classroom.archived)throw new AppError(409,'Archived question banks are read-only.');
   for(const id of setIds)await assertSet(tx,user,classroomId,id);
   await tx.query('UPDATE classroom_question_sets SET active=FALSE WHERE classroom_id=$1',[classroomId]);
   for(const id of setIds)await tx.query('INSERT INTO classroom_question_sets(classroom_id,set_id,active) VALUES($1,$2,TRUE) ON CONFLICT(classroom_id,set_id) DO UPDATE SET active=TRUE',[classroomId,id]);
   await tx.query('UPDATE quizzes SET used=TRUE WHERE classroom_id=$1 AND used=FALSE',[classroomId]);
  });
 }
 async lookupStudent(user:User,login:string,classroomId?:string) {
  const classroom=await this.selectedClass(user,classroomId);await currentActor(this.db,user,'teacher',true);
  const {rows:[student]}=await this.db.query('SELECT id,role,first_name,last_name,username,password_hash,account_suspended FROM users WHERE username=$1',[login.trim().toLowerCase()]);
  if(!student)throw new AppError(404,'No account has that username. The student must register first.');
  if(student.role!=='student')throw new AppError(400,'That username belongs to a non-student account.');
  if(student.account_suspended||!student.password_hash)throw new AppError(409,'This student account is restricted or has not completed account setup.');
  if((await this.db.query('SELECT 1 FROM enrollments WHERE student_id=$1 AND classroom_id=$2 AND active=TRUE',[student.id,classroom.id])).rows.length)throw new AppError(409,'This student already has an enrollment in this class. Manage its existing status from the roster.');
  return{id:String(student.id),firstName:String(student.first_name),lastName:String(student.last_name),username:String(student.username)};
 }
 async addRoster(user:User,input:z.infer<typeof rosterSchema>,classroomId?:string):Promise<RosterStudent> {
  requirePasswordChange(user);return this.db.transaction(async tx=>{
   const classroom=await this.selectedClass(user,classroomId,tx,true);await currentActor(tx,user,'teacher',true);if(classroom.archived)throw new AppError(409,'Archived classes cannot accept new students.');
   const {rows:[student]}=await tx.query("SELECT * FROM users WHERE username=$1 FOR UPDATE",[input.username]);
   if(!student||student.role!=='student')throw new AppError(404,'An existing student account with that username is required.');
   if(student.id!==input.studentId)throw new AppError(409,'The matched account changed. Look up the username and confirm again.');
   if(student.account_suspended||!student.password_hash)throw new AppError(409,'This student account is restricted or has not completed account setup.');
   const {rows:[existing]}=await tx.query('SELECT active FROM enrollments WHERE student_id=$1 AND classroom_id=$2',[student.id,classroom.id]);
   if(existing?.active)throw new AppError(409,'This student already has an enrollment in this class.');
   await attachEnrollment(tx,String(student.id),String(classroom.id),'approved');
   await tx.query('UPDATE enrollments SET approved_at=statement_timestamp(),approved_by=$1 WHERE student_id=$2 AND classroom_id=$3',[user.id,student.id,classroom.id]);
   await tx.query('INSERT INTO student_status_events(id,student_id,teacher_id,classroom_id,previous_status,status) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),student.id,user.id,classroom.id,existing?'removed':'none','approved']);
   return rosterFrom({...student,current_classroom_id:classroom.id,enrollment_status:'approved'});
  });
 }
 private async enrolledStudent(user:User,id:string,connection:SQL=this.db,lock=false,classroomId?:string):Promise<Row> {
  await currentActor(connection,user,'teacher');
  const {rows}=await connection.query(`SELECT u.*,e.id AS enrollment_id,e.status AS enrollment_status,e.approved_at AS enrollment_approved_at,e.classroom_id AS current_classroom_id FROM users u JOIN enrollments e ON e.student_id=u.id AND e.active=TRUE JOIN classrooms c ON c.id=e.classroom_id WHERE u.id=$1 AND u.role='student' AND ${classroomScope('c','$2')} AND ($3::text IS NULL OR c.id=$3)${lock?' FOR UPDATE OF u,e':''}`,[id,user.id,classroomId??null]);
  if(!rows.length)throw new AppError(404,'Student not found in your classes.');
  if(rows.length>1)throw new AppError(409,'Select the class enrollment you want to manage.');return rows[0];
 }
 async updateRoster(user:User,id:string,input:z.infer<typeof rosterUpdateSchema>,classroomId?:string) {
  requirePasswordChange(user);const previous=await this.enrolledStudent(user,id,this.db,false,classroomId);const hash=input.password?await hashPassword(input.password):undefined;
  await this.db.transaction(async tx=>{await lockClasses(tx,[String(previous.current_classroom_id)]);const student=await this.enrolledStudent(user,id,tx,true,String(previous.current_classroom_id));await currentActor(tx,user,'teacher',true);
   if(input.accountStatus!==undefined&&input.enabled!==undefined&&(input.accountStatus==='active')!==input.enabled)throw new AppError(400,'Choose one consistent enrollment status.');
   const nextStatus=input.accountStatus??(input.enabled===undefined?undefined:input.enabled?'active':'deactivated');const status=nextStatus==='active'?'approved':nextStatus;
   if(status&&status!==student.enrollment_status){
    if(status==='approved'&&!student.password_hash)throw new AppError(409,'Set a temporary password before approving this roster account.');
    await tx.query("UPDATE enrollments SET status=$1,approved_at=CASE WHEN $1='approved' THEN statement_timestamp() ELSE approved_at END,approved_by=CASE WHEN $1='approved' THEN $2 ELSE approved_by END WHERE id=$3",[status,user.id,student.enrollment_id]);
    await tx.query('INSERT INTO student_status_events(id,student_id,teacher_id,classroom_id,previous_status,status) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,user.id,student.current_classroom_id,student.enrollment_status,status]);
   }
   if(hash){await tx.query('UPDATE users SET password_hash=$1,must_change_password=TRUE WHERE id=$2',[hash,id]);await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);}
   if(status==='deactivated'||hash){
    await tx.query("UPDATE visits SET status='cancelled',cancellation_reason='This class enrollment was deactivated or its account access changed.' WHERE student_id=$1 AND classroom_id=$2 AND status IN ('waiting','ready')",[id,student.current_classroom_id]);
    await tx.query('UPDATE quizzes SET used=TRUE WHERE student_id=$1 AND classroom_id=$2 AND used=FALSE',[id,student.current_classroom_id]);await this.promote(tx,String(student.current_classroom_id));
   }
  });
 }
 async rosterDetail(user:User,id:string,classroomId?:string):Promise<StudentDetail> {
  assertRole(user,'teacher');await currentActor(this.db,user,'teacher');
  let classId=classroomId;
  if(classId)await this.selectedClass(user,classId);
  else {const {rows:[member]}=await this.db.query(`SELECT e.classroom_id FROM enrollments e JOIN classrooms c ON c.id=e.classroom_id WHERE e.student_id=$1 AND ${classroomScope('c','$2')} ORDER BY e.active DESC,e.joined_at DESC LIMIT 1`,[id,user.id]);if(!member)throw new AppError(404,'Student not found in your classes.');classId=String(member.classroom_id);}
  const {rows:[student]}=await this.db.query('SELECT u.*,e.id AS enrollment_id,e.status AS enrollment_status,e.approved_at AS enrollment_approved_at,e.classroom_id AS current_classroom_id FROM users u JOIN enrollments e ON e.student_id=u.id WHERE u.id=$1 AND e.classroom_id=$2',[id,classId]);if(!student)throw new AppError(404,'Student not found in this class.');
  const {rows:visits}=await this.db.query(`${visitSelect} WHERE v.student_id=$1 AND v.classroom_id=$2 ORDER BY v.requested_at DESC LIMIT 1000`,[id,classId]);return{student:rosterFrom(student),visits:visits.map(visitFrom)};
 }
 async removeStudent(user:User,id:string,source?:string) {await this.moveStudent(user,id,null,source);}
 async transferStudent(user:User,id:string,classroomId:string,source?:string) {await this.moveStudent(user,id,classroomId,source);}
 private async moveStudent(user:User,id:string,destination:string|null,requestedSource?:string) {
  requirePasswordChange(user);const previous=await this.enrolledStudent(user,id,this.db,false,requestedSource);const source=String(previous.current_classroom_id);if(destination===source)throw new AppError(409,'The student is already enrolled in that class.');
  await this.db.transaction(async tx=>{await lockClasses(tx,[source,destination]);await currentActor(tx,user,'teacher',true);
   const student=await this.enrolledStudent(user,id,tx,true,source);if(student.current_classroom_id!==source)throw new AppError(409,'This student’s class changed. Refresh and try again.');
   if(destination){const target=await this.selectedClass(user,destination,tx);if(target.archived)throw new AppError(409,'Students cannot transfer into an archived class.');}
   await tx.query("UPDATE visits SET status=CASE WHEN status='out' THEN 'returned' ELSE 'cancelled' END,returned_at=CASE WHEN status='out' THEN statement_timestamp() ELSE returned_at END WHERE student_id=$1 AND classroom_id=$2 AND status IN ('waiting','ready','out')",[id,source]);await tx.query('UPDATE quizzes SET used=TRUE WHERE student_id=$1 AND classroom_id=$2 AND used=FALSE',[id,source]);await tx.query('UPDATE enrollments SET active=FALSE,left_at=statement_timestamp() WHERE student_id=$1 AND classroom_id=$2 AND active=TRUE',[id,source]);await tx.query('UPDATE users SET classroom_id=(SELECT classroom_id FROM enrollments WHERE student_id=$1 AND active=TRUE ORDER BY joined_at LIMIT 1) WHERE id=$1',[id]);if(destination)await attachEnrollment(tx,id,destination,String(student.enrollment_status));await this.promote(tx,source);
  });
 }
 async saveQuestion(user:User,input:z.infer<typeof questionSchema>,id?:string,classroomId?:string):Promise<Question|void> {
  requirePasswordChange(user);return this.db.transaction(async tx=>{
   const classroom=await this.selectedClass(user,classroomId,tx,true);await currentActor(tx,user,'teacher',true);if(classroom.archived)throw new AppError(409,'Archived question banks are read-only.');
   if(id)await assertQuestion(tx,user,String(classroom.id),id);
   if(input.setIds)for(const setId of input.setIds)await assertSet(tx,user,String(classroom.id),setId);
   const questionId=id??randomUUID();
   if(id)await tx.query('UPDATE questions SET prompt=$1,options=$2,correct_index=$3,topic=$4,explanation=$5,active=$6 WHERE id=$7',[input.prompt,JSON.stringify(input.options),input.correctIndex,input.topic,input.explanation,input.active,id]);
   else await tx.query('INSERT INTO questions(id,classroom_id,prompt,options,correct_index,topic,explanation,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[questionId,classroom.id,input.prompt,JSON.stringify(input.options),input.correctIndex,input.topic,input.explanation,input.active]);
   const ids=input.setIds??(!id?[await defaultQuestionSet(tx,String(classroom.id))]:undefined);
   if(ids){
    const library=await questionLibrary(tx,user,String(classroom.id)),before=library.questions.find(q=>q.id===questionId)?.setIds??[];
    for(const set of library.questionSets)await tx.query('UPDATE question_set_questions SET active=FALSE WHERE question_id=$1 AND set_id=$2',[questionId,set.id]);
    for(const setId of ids)await linkQuestion(tx,setId,questionId);
    if(id&&JSON.stringify([...before].sort())!==JSON.stringify([...new Set(ids)].sort()))await tx.query('UPDATE quizzes SET used=TRUE WHERE used=FALSE AND classroom_id IN (SELECT classroom_id FROM classroom_question_sets WHERE set_id=ANY($1::text[]) AND active=TRUE)',[[...new Set([...before,...ids])]]);
   }
   const {rows:[row]}=await tx.query('SELECT * FROM questions WHERE id=$1',[questionId]);return questionFrom(row);
  });
 }
 async deleteQuestion(user:User,id:string,classroomId?:string) {
  await this.db.transaction(async tx=>{const classroom=await this.selectedClass(user,classroomId,tx,true);await currentActor(tx,user,'teacher',true);if(classroom.archived)throw new AppError(409,'Archived question banks are read-only.');await assertQuestion(tx,user,String(classroom.id),id);await tx.query('UPDATE questions SET active=FALSE,deleted=TRUE WHERE id=$1',[id]);});
 }
 async teacherVisit(user:User,id:string,action:'return'|'cancel') {
  requirePasswordChange(user);await currentActor(this.db,user,'teacher',true);const {rows:[previous]}=await this.db.query(`SELECT v.classroom_id FROM visits v JOIN classrooms c ON c.id=v.classroom_id WHERE v.id=$1 AND ${classroomScope('c','$2')}`,[id,user.id]);if(!previous)throw new AppError(404,'Pass not found.');
  await this.db.transaction(async tx=>{await lockClasses(tx,[String(previous.classroom_id)]);await assertClassroomTeacher(tx,user,String(previous.classroom_id));await currentActor(tx,user,'teacher',true);const {rows:[visit]}=await tx.query('SELECT * FROM visits WHERE id=$1 FOR UPDATE',[id]);
   if(action==='return'){if(visit.status!=='out')throw new AppError(409,'This student is not currently out.');await tx.query("UPDATE visits SET status='returned',returned_at=statement_timestamp() WHERE id=$1",[id]);}
   else {if(!['ready','waiting'].includes(String(visit.status)))throw new AppError(409,'Only a queued or ready pass can be cancelled.');await tx.query("UPDATE visits SET status='cancelled' WHERE id=$1",[id]);}await this.promote(tx,String(visit.classroom_id));
  });
 }
 async reopenVisit(user:User,id:string,input:{resolveOlder?:boolean;reason?:string}={}) {
  await currentActor(this.db,user,'teacher',true);
  const {rows:[previous]}=await this.db.query(`SELECT v.classroom_id,v.student_id FROM visits v JOIN classrooms c ON c.id=v.classroom_id WHERE v.id=$1 AND ${classroomScope('c','$2')}`,[id,user.id]);
  if(!previous)throw new AppError(404,'Pass not found.');
  await this.db.transaction(async tx=>{
   await lockClasses(tx,[String(previous.classroom_id)]);await assertClassroomTeacher(tx,user,String(previous.classroom_id));await currentActor(tx,user,'teacher',true);
   const {rows:[student]}=await tx.query("SELECT * FROM users WHERE id=$1 AND role='student' FOR UPDATE",[previous.student_id]);
   if(!student||!(await tx.query('SELECT id FROM enrollments WHERE student_id=$1 AND classroom_id=$2 AND active=TRUE',[previous.student_id,previous.classroom_id])).rows.length)throw new AppError(409,'This student is no longer in the original class. Resolve their current enrollment before reopening this break.');
   const {rows:[visit]}=await tx.query("SELECT *,returned_at>=statement_timestamp()-INTERVAL '24 hours' AS recent FROM visits WHERE id=$1 FOR UPDATE",[id]);
   if(visit.status!=='returned'||!visit.left_at||!visit.returned_at||new Date(String(visit.returned_at))<new Date(String(visit.left_at)))throw new AppError(409,'Only a completed break with valid departure and return times can be reopened.');
   const reason=input.reason?.trim()||'Teacher confirmed the student is still outside.';
   if(reason.length>2000)throw new AppError(400,'Keep the correction reason under 2000 characters.');
   if(!visit.recent&&(!input.resolveOlder||reason.length<10||!input.reason?.trim()))throw new AppError(409,'This return is older than 24 hours. Confirm the older correction and provide a reason of at least 10 characters.');
   const {rows:active}=await tx.query("SELECT id FROM visits WHERE student_id=$1 AND status IN ('waiting','ready','out')",[student.id]);
   if(active.length)throw new AppError(409,'This student already has an active break or queue entry. Resolve it before reopening this break.');
   await this.promote(tx,String(previous.classroom_id));
   await tx.query('INSERT INTO break_corrections(id,visit_id,teacher_id,incorrect_returned_at,reason) SELECT $1,id,$3,returned_at,$4 FROM visits WHERE id=$2',[randomUUID(),id,user.id,reason]);
   await tx.query("UPDATE visits SET status='out',returned_at=NULL,ready_expires_at=NULL,capacity_paused=FALSE WHERE id=$1",[id]);
   await tx.query('UPDATE quizzes SET used=TRUE WHERE student_id=$1 AND used=FALSE',[student.id]);
   await this.promote(tx,String(previous.classroom_id));
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
   this.db.query(`SELECT u.*,e.id AS enrollment_id,e.status AS enrollment_status,e.approved_at AS enrollment_approved_at,e.classroom_id AS current_classroom_id,c.name AS classroom_name,c.teacher_id,t.first_name AS teacher_first_name,t.last_name AS teacher_last_name,(SELECT COUNT(*) FROM visits v WHERE v.student_id=u.id AND v.left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS visits_today FROM users u LEFT JOIN enrollments e ON e.student_id=u.id AND e.active=TRUE LEFT JOIN classrooms c ON c.id=e.classroom_id LEFT JOIN users t ON t.id=c.teacher_id WHERE u.role='student' ORDER BY u.last_name,u.first_name`),
   this.db.query("SELECT COUNT(*) AS total,COUNT(*) FILTER(WHERE left_at>=DATE_TRUNC('day',CURRENT_TIMESTAMP)) AS today,COUNT(*) FILTER(WHERE status='out') AS out,COUNT(*) FILTER(WHERE status='waiting') AS waiting FROM visits")
  ]);
  const teacherModels=teachers.map(teacherFrom);const studentModels:AdminStudent[]=[];
  for(const id of [...new Set(students.map(row=>String(row.id)))]){
   const row=students.find(row=>row.id===id)!;
   const {rows:members}=await this.db.query(`${classSelect} JOIN enrollments e ON e.classroom_id=c.id AND e.student_id=$1 AND e.active=TRUE ORDER BY c.name`,[id]);
   const {rows:permissions}=await this.db.query('SELECT * FROM enrollments WHERE student_id=$1 AND active=TRUE',[id]);
   const enrollments:StudentEnrollment[]=members.map(member=>{const permission=permissions.find(e=>e.classroom_id===member.id)!;return{id:String(permission.id),classroom:classroomFrom(member),status:permission.status as StudentEnrollment['status'],joinedAt:iso(permission.joined_at)!,approvedAt:iso(permission.approved_at),inSession:false,eligible:false};});
   studentModels.push({...rosterFrom({...row,enrollment_status:undefined}),accountStatus:row.account_suspended?'deactivated':'active',accountSuspended:Boolean(row.account_suspended),enrollments,classroomName:null,teacherId:null,teacherName:null});
  }
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
 async updateAdminProfile(user:User,input:z.infer<typeof adminProfileSchema>) {const current=await currentActor(this.db,user,'admin',true);await this.db.query("UPDATE users SET first_name=$1,last_name=$2,email=$3 WHERE id=$4 AND role='admin' AND username=$5",[input.firstName,input.lastName,input.email!==undefined?input.email:current.email,user.id,current.username]);}
}
