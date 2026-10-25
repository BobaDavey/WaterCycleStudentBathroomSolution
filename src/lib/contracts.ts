export type Role = "admin" | "teacher" | "student";
export type StudentAccountStatus = "pending" | "active" | "deactivated";
export interface User { id: string; role: Role; firstName: string; lastName: string; username: string; classroomId: string | null; mustChangePassword: boolean; email?: string | null; tutorialCompleted: boolean; accountStatus: StudentAccountStatus | null; }
export type EnrollmentStatus = "pending" | "approved" | "deactivated";
export interface Classroom { id: string; teacherId: string; teacherName?: string; name: string; period: string | null; code: string | null; legacyCode?: string | null; timeZone: string; capacity: number; startTime: string | null; endTime: string | null; scheduleDays: number[]; archived: boolean; studentCount: number; }
export interface StudentEnrollment { id: string; classroom: Classroom; status: EnrollmentStatus; joinedAt: string; approvedAt: string | null; inSession: boolean; eligible: boolean; unavailableReason?: string; }
export type VisitStatus = "waiting" | "ready" | "out" | "returned" | "cancelled";
export type BreakPurpose = "restroom" | "water";
export interface Visit { id: string; studentId: string; studentName: string; studentUsername?: string; classroomId?: string; classroomName?: string; timeZone?: string; status: VisitStatus; purpose: BreakPurpose | null; requestedAt: string; readyAt: string | null; readyExpiresAt: string | null; reservationPaused: boolean; leftAt: string | null; returnedAt: string | null; warningAcknowledgedAt: string | null; corrections: BreakCorrection[]; position?: number; cancellationReason?: string | null; }
export interface Question { id: string; prompt: string; options: string[]; correctIndex: number; topic: string; explanation: string; active: boolean; createdAt?:string|null; setIds?:string[]; }
export interface QuestionSet {id:string;name:string;description:string;questionCount:number;classCount:number;ownerTeacherId:string;}
export interface ClassroomTeacher {id:string;firstName:string;lastName:string;username:string;primary:boolean;enabled:boolean;}
export type QuizQuestion = Omit<Question, "correctIndex" | "explanation" | "active">;
export interface Quiz { classroomId: string; id: string; purpose: BreakPurpose; correctCount: number; question: QuizQuestion; questionToken: string; expiresAt: string; notice?: string; }
export interface PendingStudent extends RosterStudent { classroomName: string; period: string | null; }
export interface RosterStudent { accountSuspended?: boolean; enrollmentId: string; enrollmentStatus: EnrollmentStatus; id: string; firstName: string; lastName: string; username: string; enabled: boolean; accountStatus: StudentAccountStatus; registeredAt: string; approvedAt: string | null; registered: boolean; mustChangePassword: boolean; visitsToday: number; classroomId: string | null; }
export interface StudentState { enrollments: StudentEnrollment[]; eligibleClassroomIds: string[]; user: User; classroom: Classroom | null; currentVisit: Visit | null; activeQuiz: Quiz | null; serverNow: string; activeCount: number; waitingCount: number; recentVisits: Visit[]; availableQuestions: number; canRequestPass: boolean; unavailableReason?: string; }
export interface TeacherState { user: User; pendingStudents: PendingStudent[]; classes: Classroom[]; classroom: Classroom | null; students: RosterStudent[]; questions: Question[]; questionSets:QuestionSet[];activeSetIds:string[];eligibleQuestionCount:number;teachers:ClassroomTeacher[]; visits: Visit[]; stats: { out: number; ready: number; waiting: number; tripsToday: number; averageMinutes: number }; }
export interface AuthState { user: User | null; setupAvailable?: boolean; adminProvisioned?: boolean; developmentSetup?: 'missing-secret' | 'restart-required'; demo?: boolean; }
export interface QuizResult { passed: boolean; correctCount: number; feedback: { questionId: string; correct: boolean; explanation: string }[]; quiz?: Quiz; visit?: Visit; }
export interface TeacherAccount { id: string; firstName: string; lastName: string; username: string; email: string | null; enabled: boolean; mustChangePassword: boolean; classCount: number; studentCount: number; createdAt: string; }
export interface AdminStudent extends RosterStudent { enrollments: StudentEnrollment[]; accountSuspended: boolean; classroomName: string | null; teacherId: string | null; teacherName: string | null; }
export interface AdminState { user: User; attentionTickets: number; teachers: TeacherAccount[]; classes: Classroom[]; students: AdminStudent[]; stats: { teachers: number; activeTeachers: number; inactiveTeachers: number; activeClasses: number; students: number; tripsToday: number; totalTrips: number; out: number; waiting: number }; }
export interface ClassDetail { classroom: Classroom; students: RosterStudent[]; visits: Visit[]; }
export interface StudentDetail { student: RosterStudent; visits: Visit[]; }
export interface RuleViolation { id: string; studentId: string; studentName: string; studentUsername?: string; classroomId: string; classroomName: string; period: string | null; timeZone: string; violatedAt: string; leftAt: string; returnedAt: string | null; durationSeconds: number; ongoing: boolean; totalViolations: number; }
export interface RuleOffendersState { violations: RuleViolation[]; nextCursor: string | null; serverNow: string; }
// JSON errors: {error:string}; every successful JSON response is a direct contract object.
// GET /api/auth/me -> AuthState (setupAvailable always false; public teacher setup removed)
// POST /api/auth/login {username,password,role} -> {user}
// POST /api/auth/signup {firstName,lastName,password} -> {user}
// POST /api/auth/logout -> {ok:true}; POST /api/auth/password {currentPassword,newPassword} -> {ok:true}
// GET /api/student/state -> StudentState (all memberships and eligible class IDs)
// POST /api/student/enroll/preview {classroomCode} -> {classroom}
// POST /api/student/enroll {classroomCode,classroomId?:confirmedID} -> {ok:true}; each new membership Pending
// POST /api/student/quiz {purpose:'restroom'|'water',classroomId?:string} -> Quiz (resumes a pending attempt)
// POST /api/student/quiz/answer {quizId,questionId,questionToken,answer:number} -> QuizResult
// POST /api/student/quiz/cancel {quizId} -> {ok:true}; legacy batch submit retired
// POST /api/student/tutorial {} -> {ok:true} (save tutorial completion)
// POST /api/student/visits/:id/warning {} -> {ok:true} (acknowledge own overdue active break)
// POST /api/student/leave | return | cancel -> {ok:true}
// GET /api/teacher/state?classroomId=optional -> TeacherState (default first active owned/shared class; null if none)
// GET /api/teacher/violations?classroomId=optional&search=optional&cursor=optional&limit=50 -> RuleOffendersState
// GET /api/admin/violations same filters -> RuleOffendersState (privileged oversight)
// POST /api/teacher/classes {name,period?:string,code:string,timeZone?:string,startTime,endTime,capacity?:number} -> {classroom}
// PATCH /api/teacher/classes/:id {name?:string,period?:string,code?:string,archived?:boolean,timeZone?:string,startTime?:string,endTime?:string,capacity?:number} -> {classroom}
// POST /api/teacher/roster/lookup?classroomId=id {username} -> {student: confirmed identity}
// POST /api/teacher/roster?classroomId=id {username,studentId} -> {student}; existing registered account, audited Approved enrollment only
// PATCH /api/teacher/roster/:studentId?classroomId=id {accountStatus?:active|deactivated,password?:string} -> {ok:true}
// POST /api/teacher/roster/:studentId/remove?classroomId=source {} -> {ok:true}
// POST /api/teacher/roster/:studentId/transfer?classroomId=source {classroomId:destination} -> {ok:true}
// GET /api/teacher/roster/:studentId?classroomId=optional -> StudentDetail (own current/historical class only)
// POST /api/teacher/questions?classroomId=id {prompt,options,correctIndex,topic,explanation,active} -> {question}
// PATCH /api/teacher/questions/:id?classroomId=id same question fields -> {ok:true}
// DELETE /api/teacher/questions/:id?classroomId=id -> {ok:true}
// POST /api/teacher/visits/:id/return | cancel -> {ok:true} (ownership from visit, preserves historical class)
// GET /api/teacher/export?classroomId=id -> text/csv
// GET /api/admin/state -> AdminState; GET /api/admin/classes/:id -> ClassDetail
// POST /api/admin/teachers {firstName,lastName,username,email?:string,password,enabled:boolean} -> {teacher}
// PATCH /api/admin/teachers/:id {firstName?:string,lastName?:string,username?:string,email?:string,enabled?:boolean,password?:string} -> {ok:true}
// PATCH /api/admin/profile {firstName,lastName,email?:string} -> {ok:true}; username immutable
// No administrator account creation, deletion, demotion or enrollment-management API.

export interface BreakCorrection { id: string; teacherName: string; correctedAt: string; incorrectReturnedAt: string; reason: string; }
export type TicketStatus = "need_attention" | "solved";
export interface ProblemReport { id: string; teacherName: string; email: string; description: string; submittedAt: string; status: TicketStatus; resolvedAt: string | null; }
export interface TicketEvent { id: string; status: TicketStatus; changedAt: string; developerName: string; }
export interface ProblemReportDetail extends ProblemReport { history: TicketEvent[]; }
export interface ProblemReportsState { tickets: ProblemReport[]; nextCursor: string | null; attentionCount: number; }
// PATCH /api/teacher/roster/:id?classroomId=id {accountStatus:'active'|'deactivated'} -> {ok:true}; legacy wire names map to enrollment Approved/Deactivated only. They never change global account security.
// POST /api/teacher/visits/:id/reopen {resolveOlder?:boolean,reason?:string} -> {ok:true}; >24h requires reason and explicit override.
// POST /api/teacher/reports {teacherName,email,description,requestId:uuid} -> {id}; idempotent per teacher/requestId.
// GET /api/admin/reports?status=all|need_attention|solved&search=&cursor=&limit=50 -> ProblemReportsState
// GET /api/admin/reports/:id -> ProblemReportDetail
// PATCH /api/admin/reports/:id {status:'need_attention'|'solved'} -> {ok:true}

// POST /api/teacher/classes/:id/teachers {username}; DELETE /api/teacher/classes/:id/teachers/:teacherId (Primary Teacher only).
// POST/PATCH/DELETE /api/teacher/question-sets[/:id]?classroomId=id {name,description}; delete preserves questions.
// PATCH /api/teacher/question-sets/:id/questions?classroomId=id {questionId,active}.
// PATCH /api/teacher/classes/:id/active-sets {setIds:string[]}; class-specific, deduplicated eligibility.
