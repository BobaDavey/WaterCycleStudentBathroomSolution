export type Role = "teacher" | "student";
export interface User { id: string; role: Role; firstName: string; lastName: string; username: string; classroomId: string; mustChangePassword: boolean; }
export interface Classroom { id: string; name: string; code: string; capacity: number; }
export type VisitStatus = "waiting" | "ready" | "out" | "returned" | "cancelled";
export interface Visit { id: string; studentId: string; studentName: string; status: VisitStatus; requestedAt: string; readyAt: string | null; leftAt: string | null; returnedAt: string | null; position?: number; }
export interface Question { id: string; prompt: string; options: string[]; correctIndex: number; topic: string; explanation: string; active: boolean; }
export type QuizQuestion = Omit<Question, "correctIndex" | "explanation" | "active">;
export interface Quiz { id: string; questions: QuizQuestion[]; }
export interface RosterStudent { id: string; firstName: string; lastName: string; username: string; enabled: boolean; registered: boolean; mustChangePassword: boolean; visitsToday: number; }
export interface StudentState { user: User; classroom: Classroom; currentVisit: Visit | null; activeCount: number; waitingCount: number; recentVisits: Visit[]; availableQuestions: number; }
export interface TeacherState { user: User; classroom: Classroom; students: RosterStudent[]; questions: Question[]; visits: Visit[]; stats: { out: number; ready: number; waiting: number; tripsToday: number; averageMinutes: number }; }
export interface AuthState { user: User | null; setupAvailable?: boolean; demo?: boolean; }
export interface QuizResult { passed: boolean; correctCount: number; feedback: { questionId: string; correct: boolean; explanation: string }[]; visit?: Visit; }
// JSON API: all successful responses use these direct objects; errors use { error: string }.
// GET /api/auth/me -> AuthState
// POST /api/auth/login { username, password, role } -> { user }
// POST /api/auth/signup { firstName, lastName, password, classroomCode } -> { user }
// POST /api/auth/setup { firstName, lastName, username, password, classroomName, setupKey } -> { user }
// POST /api/auth/logout -> { ok: true }
// POST /api/auth/password { currentPassword, newPassword } -> { ok: true }
// GET /api/student/state -> StudentState
// POST /api/student/quiz -> Quiz
// POST /api/student/quiz/submit { quizId, answers: number[] } -> QuizResult
// POST /api/student/leave | return | cancel -> { ok: true }
// GET /api/teacher/state -> TeacherState
// POST /api/teacher/roster { firstName, lastName } -> { student }
// PATCH /api/teacher/roster/:id { enabled?: boolean, password?: string } -> { ok: true }
// POST /api/teacher/questions { prompt, options, correctIndex, topic, explanation, active } -> { question }
// PATCH /api/teacher/questions/:id same as POST -> { ok: true }
// DELETE /api/teacher/questions/:id -> { ok: true } (soft delete / active false)
// POST /api/teacher/visits/:id/return | cancel -> { ok: true }
// PATCH /api/teacher/classroom { name: string, regenerateCode?: boolean } -> { classroom }
// GET /api/teacher/export -> text/csv download
