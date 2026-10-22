export type Role = "admin" | "teacher" | "student";
export interface User { id: string; role: Role; firstName: string; lastName: string; username: string; classroomId: string | null; mustChangePassword: boolean; email?: string | null; }
export interface Classroom { id: string; teacherId: string; teacherName?: string; name: string; period: string | null; code: string | null; legacyCode?: string | null; capacity: number; archived: boolean; studentCount: number; }
export type VisitStatus = "waiting" | "ready" | "out" | "returned" | "cancelled";
export interface Visit { id: string; studentId: string; studentName: string; classroomId?: string; classroomName?: string; status: VisitStatus; requestedAt: string; readyAt: string | null; leftAt: string | null; returnedAt: string | null; position?: number; }
export interface Question { id: string; prompt: string; options: string[]; correctIndex: number; topic: string; explanation: string; active: boolean; }
export type QuizQuestion = Omit<Question, "correctIndex" | "explanation" | "active">;
export interface Quiz { id: string; questions: QuizQuestion[]; }
export interface RosterStudent { id: string; firstName: string; lastName: string; username: string; enabled: boolean; registered: boolean; mustChangePassword: boolean; visitsToday: number; classroomId: string | null; }
export interface StudentState { user: User; classroom: Classroom | null; currentVisit: Visit | null; activeCount: number; waitingCount: number; recentVisits: Visit[]; availableQuestions: number; canRequestPass: boolean; unavailableReason?: string; }
export interface TeacherState { user: User; classes: Classroom[]; classroom: Classroom | null; students: RosterStudent[]; questions: Question[]; visits: Visit[]; stats: { out: number; ready: number; waiting: number; tripsToday: number; averageMinutes: number }; }
export interface AuthState { user: User | null; setupAvailable?: boolean; adminProvisioned?: boolean; demo?: boolean; }
export interface QuizResult { passed: boolean; correctCount: number; feedback: { questionId: string; correct: boolean; explanation: string }[]; visit?: Visit; }
export interface TeacherAccount { id: string; firstName: string; lastName: string; username: string; email: string | null; enabled: boolean; mustChangePassword: boolean; classCount: number; studentCount: number; createdAt: string; }
export interface AdminStudent extends RosterStudent { classroomName: string | null; teacherId: string | null; teacherName: string | null; }
export interface AdminState { user: User; teachers: TeacherAccount[]; classes: Classroom[]; students: AdminStudent[]; stats: { teachers: number; activeTeachers: number; inactiveTeachers: number; activeClasses: number; students: number; tripsToday: number; totalTrips: number; out: number; waiting: number }; }
export interface ClassDetail { classroom: Classroom; students: RosterStudent[]; visits: Visit[]; }
export interface StudentDetail { student: RosterStudent; visits: Visit[]; }
// JSON errors: {error:string}; every successful JSON response is a direct contract object.
// GET /api/auth/me -> AuthState (setupAvailable always false; public teacher setup removed)
// POST /api/auth/login {username,password,role} -> {user}
// POST /api/auth/signup {firstName,lastName,username?:string,password,classroomCode} -> {user}
// POST /api/auth/logout -> {ok:true}; POST /api/auth/password {currentPassword,newPassword} -> {ok:true}
// GET /api/student/state -> StudentState; POST /api/student/enroll {classroomCode} -> {ok:true} (only unenrolled accounts)
// POST /api/student/quiz -> Quiz; POST /api/student/quiz/submit {quizId,answers:number[]} -> QuizResult
// POST /api/student/leave | return | cancel -> {ok:true}
// GET /api/teacher/state?classroomId=optional -> TeacherState (default first active owned class; null if none)
// POST /api/teacher/classes {name,period?:string,code:string} -> {classroom}
// PATCH /api/teacher/classes/:id {name?:string,period?:string,code?:string,archived?:boolean} -> {classroom}
// POST /api/teacher/roster?classroomId=id {firstName,lastName} -> {student}
// PATCH /api/teacher/roster/:studentId {enabled?:boolean,password?:string} -> {ok:true}
// POST /api/teacher/roster/:studentId/remove {} -> {ok:true}
// POST /api/teacher/roster/:studentId/transfer {classroomId:string} -> {ok:true}
// GET /api/teacher/roster/:studentId?classroomId=optional -> StudentDetail (own current/historical class only)
// POST /api/teacher/questions?classroomId=id {prompt,options,correctIndex,topic,explanation,active} -> {question}
// PATCH /api/teacher/questions/:id?classroomId=id same question fields -> {ok:true}
// DELETE /api/teacher/questions/:id?classroomId=id -> {ok:true}
// POST /api/teacher/visits/:id/return | cancel -> {ok:true} (ownership from visit, preserves historical class)
// GET /api/teacher/export?classroomId=id -> text/csv
// GET /api/admin/state -> AdminState; GET /api/admin/classes/:id -> ClassDetail
// POST /api/admin/teachers {firstName,lastName,username,email?:string,password,enabled:boolean} -> {teacher}
// PATCH /api/admin/teachers/:id {firstName?:string,lastName?:string,username?:string,email?:string,enabled?:boolean,password?:string} -> {ok:true}
// PATCH /api/admin/profile {firstName,lastName,email?:string} -> {ok:true}; username immutable davidanzezhang
// No administrator account creation, deletion, demotion or enrollment-management API.
