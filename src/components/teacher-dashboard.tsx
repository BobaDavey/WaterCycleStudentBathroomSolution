"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownToLine, ArrowRight, BookOpen, Check, CheckCircle2, ChevronRight, Clock3, Copy, Droplets, GraduationCap, LayoutDashboard, Leaf, ListOrdered, LogOut, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Trash2, Users, X } from "lucide-react";
import type { Question, RosterStudent, TeacherState, User, Visit } from "@/lib/contracts";
import { api, duration, post, time } from "@/lib/client";
import styles from "./teacher-dashboard.module.css";

type Section = "overview" | "roster" | "questions" | "history" | "settings";
type DialogState = { type: "student" } | { type: "reset"; student: RosterStudent } | { type: "question"; question?: Question } | { type: "delete"; question: Question } | null;
const sections: { id: Section; label: string; icon: typeof Users }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "roster", label: "Student roster", icon: Users },
  { id: "questions", label: "Question bank", icon: BookOpen },
  { id: "history", label: "Trip history", icon: Clock3 },
  { id: "settings", label: "Classroom settings", icon: Settings2 },
];
const initials = (name: string) => name.split(" ").filter(Boolean).map(part => part[0]).slice(0, 2).join("").toUpperCase();
const visitLabel = (status: Visit["status"]) => ({ ready: "Ready to leave", out: "Out now", waiting: "In line", returned: "Returned", cancelled: "Cancelled" })[status];
const visitColor = (status: Visit["status"]) => ({ ready: "green", out: "orange", waiting: "gray", returned: "green", cancelled: "gray" })[status];

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const container = ref.current;
    const focusables = () => Array.from(container?.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, textarea, a[href], [tabindex="0"]') ?? []);
    focusables()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const elements = focusables();
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    const scroll = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", keydown); document.body.style.overflow = scroll; previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className={`modal ${styles.modal}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-header"><h2 id={titleId}>{title}</h2><button className="button ghost small" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>
      {children}
    </div>
  </div>;
}

export function TeacherDashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [section, setSection] = useState<Section>("overview");
  const [data, setData] = useState<TeacherState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [rosterSearch, setRosterSearch] = useState("");
  const [questionSearch, setQuestionSearch] = useState("");
  const [topic, setTopic] = useState("all");
  const [historySearch, setHistorySearch] = useState("");
  const [historyDate, setHistoryDate] = useState("");
  const [historyStatus, setHistoryStatus] = useState("all");
  const [classroomName, setClassroomName] = useState("");
  const [confirmCode, setConfirmCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const initialized = useRef(false);
  const closeDialog = useCallback(() => { setDialog(null); setError(""); }, []);

  const refresh = useCallback(async () => {
    try {
      const state = await api<TeacherState>("/teacher/state");
      setData(state); setLoadError("");
      if (!initialized.current) { setClassroomName(state.classroom.name); initialized.current = true; }
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : "Could not refresh your classroom."); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 4000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(""), 6500); return () => clearTimeout(timer); } }, [notice]);

  async function mutate(key: string, path: string, body?: unknown, method = "POST", success = "Changes saved.") {
    setBusy(key); setError("");
    try {
      await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      await refresh(); setNotice(success); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your changes could not be saved."); return false; }
    finally { setBusy(""); }
  }
  const chooseSection = (next: Section) => { setSection(next); setError(""); };
  const showDialog = (next: DialogState) => { setError(""); setDialog(next); };
  const copyCode = async () => {
    if (!data) return;
    try { await navigator.clipboard.writeText(data.classroom.code); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setNotice(`Class code: ${data.classroom.code}. Share this code with your students.`); }
  };
  async function downloadExport() {
    setBusy("export"); setError("");
    try {
      const response = await fetch("/api/teacher/export", { cache: "no-store" });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || "Export failed."); }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `watercycle-trips-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
      setNotice("Your trip history export is ready.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Export failed."); }
    finally { setBusy(""); }
  }

  const active = data?.visits.filter(visit => visit.status === "out" || visit.status === "ready").sort((a, b) => (a.readyAt || a.requestedAt).localeCompare(b.readyAt || b.requestedAt)) ?? [];
  const waiting = data?.visits.filter(visit => visit.status === "waiting").sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)) ?? [];
  const roster = data?.students.filter(student => `${student.firstName} ${student.lastName} ${student.username}`.toLowerCase().includes(rosterSearch.toLowerCase())) ?? [];
  const questions = data?.questions.filter(question => (topic === "all" || question.topic === topic) && `${question.prompt} ${question.topic}`.toLowerCase().includes(questionSearch.toLowerCase())) ?? [];
  const visits = data?.visits.filter(visit => visit.studentName.toLowerCase().includes(historySearch.toLowerCase()) && (historyStatus === "all" || visit.status === historyStatus) && (!historyDate || localDate(visit.requestedAt) === historyDate)) ?? [];
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const title = { overview: `Hello, ${user.firstName}.`, roster: "Your class, all together.", questions: "A little learning, every trip.", history: "Every trip, accounted for.", settings: "Make it your classroom." }[section];
  const subtitle = { overview: "A calmer classroom starts with a better flow.", roster: "Manage your students, accounts, and classroom access.", questions: "Two questions. A quick refresh. Knowledge that sticks.", history: "A clear record of departures, returns, and time away.", settings: "The little details that keep your classroom moving." }[section];

  return <div className={`app-shell ${styles.teacherShell}`}>
    <aside className="sidebar">
      <a className="sidebar-brand" href="/" aria-label="WaterCycle home"><span className={styles.brandIcon}><Droplets size={25} strokeWidth={1.6} /></span><span>WaterCycle<span className={styles.brandSub}>A BETTER CLASSROOM FLOW</span></span></a>
      <div className={styles.portalLabel}>TEACHER WORKSPACE</div>
      <nav className="sidebar-nav" aria-label="Teacher navigation">{sections.map(item => <button key={item.id} className={`nav-item ${section === item.id ? "active" : ""}`} aria-current={section === item.id ? "page" : undefined} onClick={() => chooseSection(item.id)}><item.icon size={19} strokeWidth={1.7} /><span>{item.label}</span>{item.id === "overview" && <span className={styles.navDot} />}</button>)}</nav>
      <div className={styles.sidebarNote}><Leaf size={24} strokeWidth={1.5} /><strong>Small breaks.<br />Big learning moments.</strong><p>Keep curiosity flowing, even on the way out.</p></div>
      <div className="sidebar-bottom"><span className={`avatar ${styles.teacherAvatar}`}>{initials(`${user.firstName} ${user.lastName}`)}</span><div className={styles.profileName}><strong>{user.firstName} {user.lastName}</strong><span>Teacher account</span></div><button className={styles.logout} onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={18} /></button></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div className="topbar-left"><span className={styles.breadcrumb}>Workspace</span><ChevronRight size={14} /><strong>{sections.find(item => item.id === section)?.label}</strong></div><div className="topbar-right"><span className={styles.liveStatus}><span />Live classroom</span><span className={styles.headerDivider} /><span className={styles.classLabel}><GraduationCap size={17} />{data?.classroom.name || "Your classroom"}</span></div></header>
      <div className="page-content">
        <div className={`page-heading ${styles.pageHeading}`}><div><p className="eyebrow">{section === "overview" ? today : "YOUR CLASSROOM, CONNECTED"}</p><h1>{title}</h1><p className="muted">{subtitle}</p></div>{section === "overview" && data && <button className={styles.classCode} onClick={copyCode} title="Copy classroom code"><span>CLASS CODE</span><strong>{data.classroom.code}</strong>{copied ? <Check size={15} /> : <Copy size={15} />}</button>}{section === "roster" && <button className="button primary" onClick={() => showDialog({ type: "student" })}><Plus size={17} />Add student</button>}{section === "questions" && <button className="button primary" onClick={() => showDialog({ type: "question" })}><Plus size={17} />Add question</button>}{section === "history" && <button className="button secondary" disabled={!!busy} onClick={() => void downloadExport()}><ArrowDownToLine size={17} />{busy === "export" ? "Exporting…" : "Export all CSV"}</button>}</div>
        {loadError && <div role="alert" className="alert error">{loadError}<button className="button ghost small" onClick={() => void refresh()}>Retry</button></div>}
        {error && !dialog && <div role="alert" className="alert error">{error}</div>}
        {notice && <div role="status" className="alert success"><CheckCircle2 size={18} />{notice}</div>}
        {!data && !loadError && <div className={`card ${styles.loading}`} role="status"><RefreshCw size={23} className={styles.spinning} /><p>Opening your classroom…</p></div>}
        {data && <>
          {section === "overview" && <>
            <div className="stat-grid">
              <Stat icon={<ArrowRight size={21} />} label="OUT RIGHT NOW" value={String(data.stats.out)} detail={`${data.stats.ready} more ${data.stats.ready === 1 ? "student has" : "students have"} a reserved spot`} color="orange" badge={`of ${data.classroom.capacity} spots`} />
              <Stat icon={<ListOrdered size={21} />} label="IN THE QUEUE" value={String(data.stats.waiting)} detail={data.stats.waiting ? "Next up when a spot opens" : "Everyone is right where they should be"} color="green" />
              <Stat icon={<CheckCircle2 size={21} />} label="TRIPS TODAY" value={String(data.stats.tripsToday)} detail="A little biology with every break" color="green" />
              <Stat icon={<Clock3 size={21} />} label="AVG. TIME AWAY" value={data.stats.averageMinutes > 0 ? data.stats.averageMinutes.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "—"} unit={data.stats.averageMinutes > 0 ? "min" : ""} detail="Based on completed trips today" color="neutral" />
            </div>
            <div className={styles.overviewGrid}>
              <section className={`card ${styles.liveCard}`} aria-labelledby="live-title"><div className="card-header"><div><h2 id="live-title">The current flow <span className={styles.livePill}><span />LIVE</span></h2><p className="muted">Two spots. One smooth-moving classroom.</p></div><span className={`badge ${active.length >= data.classroom.capacity ? "orange" : "green"}`}>{active.length >= data.classroom.capacity ? "At capacity" : "Spots available"}</span></div><div className={styles.capacitySlots}>{Array.from({ length: data.classroom.capacity }, (_, index) => {
                const visit = active[index];
                return <div key={visit?.id || index} className={`${styles.capacitySlot} ${visit ? visit.status === "out" ? styles.slotOut : styles.slotReady : styles.slotEmpty}`}><div className={styles.slotHeading}><span>SPOT 0{index + 1}</span>{visit ? <span className={`badge ${visitColor(visit.status)}`}>{visitLabel(visit.status)}</span> : <span className="badge green">Available</span>}</div>{visit ? <><div className={styles.slotStudent}><span className={`avatar ${styles.slotAvatar}`}>{initials(visit.studentName)}</span><h3>{visit.studentName}</h3></div><p className={styles.slotTime}><Clock3 size={14} />{visit.status === "out" ? `Left ${time(visit.leftAt)} · ${duration(visit.leftAt)}` : `Called at ${time(visit.readyAt)}`}</p><button className={styles.slotAction} disabled={!!busy} onClick={() => void mutate(visit.id, `/teacher/visits/${visit.id}/${visit.status === "out" ? "return" : "cancel"}`, {}, "POST", visit.status === "out" ? `${visit.studentName} is marked back in class.` : "Reservation cancelled. The next student has been called.")}>{visit.status === "out" ? "Mark as returned" : "Release reservation"}<ArrowRight size={14} /></button></> : <><span className={styles.emptySlotIcon}><Users size={24} strokeWidth={1.3} /></span><h3>Ready for a student</h3><p className="muted">The next learning break starts here.</p></>}</div>;
              })}</div><div className={styles.queueArea}><div className={styles.queueHeading}><h3>Up next <span>{waiting.length}</span></h3><span className="muted">First in, first out</span></div>{waiting.length ? <div className={styles.queueList}>{waiting.map((visit, index) => <div key={visit.id} className={styles.queueRow}><span className={styles.queuePosition}>{index + 1}</span><span className="avatar">{initials(visit.studentName)}</span><div><strong>{visit.studentName}</strong><span>Joined at {time(visit.requestedAt)}</span></div><button className="button ghost small" disabled={!!busy} aria-label={`Remove ${visit.studentName} from queue`} onClick={() => void mutate(visit.id, `/teacher/visits/${visit.id}/cancel`, {}, "POST", "Student removed from the queue.")}><X size={16} /></button></div>)}</div> : <div className={styles.emptyQueue}><CheckCircle2 size={19} /><span>No one waiting. Everything is flowing nicely.</span></div>}</div></section>
              <aside className={styles.overviewAside}><section className={styles.learningCard}><span className={styles.learningTag}><Sparkles size={14} />THE LEARNING LOOP</span><div className={styles.leafArt} aria-hidden="true"><Leaf size={90} strokeWidth={0.8} /><span /></div><h2>A small break.<br />A little more biology.</h2><p>Before they go, students answer two random questions from your bank. A quick check-in for a curious mind.</p><div className={styles.bankCount}><strong>{data.questions.filter(q => q.active).length}</strong><span>active questions<br />ready to spark a thought</span></div><button onClick={() => chooseSection("questions")} className={styles.learningLink}>Explore question bank <ArrowRight size={16} /></button></section><section className={`card ${styles.classroomCard}`}><GraduationCap size={23} strokeWidth={1.5} /><div><strong>{data.classroom.name}</strong><p>{data.students.filter(s => s.enabled).length} students · {data.questions.filter(q => q.active).length} active questions</p></div><button className="button ghost small" aria-label="Manage student roster" onClick={() => chooseSection("roster")}><ChevronRight size={17} /></button></section></aside>
            </div>
            <section className={`card ${styles.recentCard}`}><div className="card-header"><div><h2>Recent activity</h2><p className="muted">The latest comings and goings in your classroom.</p></div><button className="button ghost small" onClick={() => chooseSection("history")}>View all history <ArrowRight size={15} /></button></div><VisitTable visits={data.visits.slice(0, 5)} empty="Your classroom story starts here. Completed and active trips will appear as students request a break." compact /></section>
          </>}
          {section === "roster" && <section className="card"><div className={`card-header ${styles.listHeader}`}><div><h2>Student roster <span className={styles.countPill}>{data.students.length}</span></h2><p className="muted">Students can create their own account using class code <strong>{data.classroom.code}</strong>.</p></div><SearchField label="Search students" value={rosterSearch} onChange={setRosterSearch} placeholder="Find a student…" /></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Student</th><th>Username</th><th>Account</th><th>Trips today</th><th><span className={styles.srOnly}>Actions</span></th></tr></thead><tbody>{roster.map(student => <tr key={student.id}><td><div className={styles.studentCell}><span className="avatar">{initials(`${student.firstName} ${student.lastName}`)}</span><strong>{student.firstName} {student.lastName}</strong></div></td><td><code className={styles.username}>{student.username}</code></td><td><span className={`badge ${!student.enabled ? "gray" : student.registered ? "green" : "orange"}`}>{!student.enabled ? "Disabled" : student.registered ? student.mustChangePassword ? "Password reset" : "Active" : "Awaiting sign-up"}</span></td><td>{student.visitsToday}</td><td><div className={styles.rowActions}><button className="button ghost small" disabled={!!busy || !student.registered} onClick={() => showDialog({ type: "reset", student })}>Reset password</button><button className={`button small ${student.enabled ? "ghost" : "secondary"}`} disabled={!!busy} onClick={() => void mutate(student.id, `/teacher/roster/${student.id}`, { enabled: !student.enabled }, "PATCH", `${student.firstName}'s account ${student.enabled ? "disabled" : "enabled"}.`)}>{student.enabled ? "Disable" : "Enable"}</button></div></td></tr>)}</tbody></table></div>{!roster.length && <Empty icon={<Users size={30} />} title={rosterSearch ? "No students found" : "Make room for curious minds"} text={rosterSearch ? "Try another name or username." : "Add your roster now, or share your class code so students can sign up themselves."} />}</section>}
          {section === "questions" && <><div className={styles.questionToolbar}><SearchField label="Search questions" value={questionSearch} onChange={setQuestionSearch} placeholder="Find a question or topic…" /><label className={styles.filterLabel}>Topic<select className="select" value={topic} onChange={event => setTopic(event.target.value)}><option value="all">All topics</option>{Array.from(new Set(data.questions.map(q => q.topic))).sort().map(value => <option key={value}>{value}</option>)}</select></label><span className="muted">{questions.length} {questions.length === 1 ? "question" : "questions"} · {data.questions.filter(q => q.active).length} active</span></div>{data.questions.filter(q => q.active).length < 2 && <div className="alert info"><BookOpen size={18} />Activate at least two questions so students can request a break.</div>}<div className={styles.questionGrid}>{questions.map((question, index) => <article className={`card ${styles.questionCard}`} key={question.id}><div className={styles.questionMeta}><span className="badge gray">{question.topic}</span><span className={`badge ${question.active ? "green" : "gray"}`}>{question.active ? "Active" : "Paused"}</span><span className={styles.questionNumber}>Q{String(index + 1).padStart(2, "0")}</span></div><h2>{question.prompt}</h2><ol className={styles.optionsList}>{question.options.map((option, index) => <li key={index} className={index === question.correctIndex ? styles.correctOption : ""}><span>{String.fromCharCode(65 + index)}</span>{option}{index === question.correctIndex && <Check size={15} />}</li>)}</ol>{question.explanation && <p className={styles.explanation}><Leaf size={14} />{question.explanation}</p>}<div className={styles.questionActions}><button className="button ghost small" disabled={!!busy} onClick={() => void mutate(question.id, `/teacher/questions/${question.id}`, { ...question, active: !question.active }, "PATCH", `Question ${question.active ? "paused" : "activated"}.`)}>{question.active ? "Pause question" : "Activate question"}</button><button className="button ghost small" onClick={() => showDialog({ type: "question", question })}><Pencil size={14} />Edit</button><button className="button ghost small" aria-label={`Delete question: ${question.prompt}`} onClick={() => showDialog({ type: "delete", question })}><Trash2 size={15} /></button></div></article>)}</div>{!questions.length && <section className="card"><Empty icon={<BookOpen size={30} />} title={questionSearch || topic !== "all" ? "No matching questions" : "A fresh page for biology"} text="Add a question or change your filters to see your question bank." /></section>}</>}
          {section === "history" && <section className="card"><div className={`card-header ${styles.historyHeader}`}><SearchField label="Search trip history" value={historySearch} onChange={setHistorySearch} placeholder="Find a student…" /><label className={styles.filterLabel}>Date<input aria-label="Filter by date" className="input" type="date" value={historyDate} onChange={event => setHistoryDate(event.target.value)} /></label><label className={styles.filterLabel}>Status<select className="select" value={historyStatus} onChange={event => setHistoryStatus(event.target.value)}><option value="all">All statuses</option><option value="out">Out now</option><option value="ready">Ready to leave</option><option value="waiting">In line</option><option value="returned">Returned</option><option value="cancelled">Cancelled</option></select></label>{(historyDate || historySearch || historyStatus !== "all") && <button className="button ghost small" onClick={() => { setHistoryDate(""); setHistorySearch(""); setHistoryStatus("all"); }}>Clear filters</button>}<span className={styles.historyCount}>{visits.length} trips</span></div><VisitTable visits={visits} empty="No trips match this view. Try changing your filters or check back after your students take a break." /></section>}
          {section === "settings" && <div className={styles.settingsGrid}><section className="card"><div className="card-header"><div><h2>Classroom details</h2><p className="muted">A familiar name for your students.</p></div><GraduationCap size={23} /></div><form className={styles.settingsForm} onSubmit={event => { event.preventDefault(); void mutate("classroom", "/teacher/classroom", { name: classroomName }, "PATCH", "Classroom name updated."); }}><label className="field">Classroom name<input className="input" value={classroomName} onChange={event => setClassroomName(event.target.value)} required maxLength={100} /></label><div className={styles.settingNote}><ShieldCheck size={18} /><p>Your classroom has <strong>two bathroom spots</strong>. A reserved spot counts toward the limit until the student returns or the reservation is released.</p></div><button className="button primary" disabled={!!busy}>{busy === "classroom" ? "Saving…" : "Save classroom"}</button></form></section><section className="card"><div className="card-header"><div><h2>Student sign-up code</h2><p className="muted">Share with students in your classroom.</p></div><Users size={23} /></div><div className={styles.settingsForm}><button className={styles.largeCode} onClick={copyCode}><strong>{data.classroom.code}</strong>{copied ? <Check size={20} /> : <Copy size={20} />}<span>{copied ? "Copied to clipboard" : "Click to copy"}</span></button><p className="muted">New students use this code when creating an account. Changing it keeps existing accounts and trip records.</p>{confirmCode ? <div className={styles.confirmCode}><p>Replace this code? The current code will stop working for new sign-ups.</p><div className={styles.rowActions}><button className="button secondary small" onClick={() => setConfirmCode(false)}>Keep current code</button><button className="button primary small" disabled={!!busy} onClick={async () => { const saved = await mutate("code", "/teacher/classroom", { name: classroomName || data.classroom.name, regenerateCode: true }, "PATCH", "A new classroom code is ready to share."); if (saved) setConfirmCode(false); }}>Generate new code</button></div></div> : <button className="button secondary" onClick={() => setConfirmCode(true)}><RefreshCw size={15} />Generate new code</button>}</div></section><PasswordSettings onSaved={() => setNotice("Your password has been updated.")} /></div>}
          <footer className={styles.pageFooter}><span><Droplets size={15} />A little learning. A better flow.</span><span>WaterCycle · Teacher workspace</span></footer>
        </>}
      </div>
    </main>
    {dialog && <Modal title={dialog.type === "student" ? "Add a student" : dialog.type === "reset" ? `Reset ${dialog.student.firstName}'s password` : dialog.type === "delete" ? "Delete this question?" : dialog.question ? "Edit question" : "Add a biology question"} onClose={closeDialog}>
      {error && <div className="alert error" role="alert">{error}</div>}
      {dialog.type === "student" && <StudentForm busy={!!busy} onCancel={closeDialog} onSubmit={async body => { if (await mutate("student", "/teacher/roster", body, "POST", "Student added. They can create their account using your class code.")) closeDialog(); }} />}
      {dialog.type === "reset" && <ResetForm student={dialog.student} busy={!!busy} onCancel={closeDialog} onSubmit={async password => { if (await mutate("reset", `/teacher/roster/${dialog.student.id}`, { password }, "PATCH", "Temporary password saved. The student will choose a new password at sign-in.")) closeDialog(); }} />}
      {dialog.type === "question" && <QuestionForm question={dialog.question} busy={!!busy} onCancel={closeDialog} onSubmit={async body => { if (await mutate("question", dialog.question ? `/teacher/questions/${dialog.question.id}` : "/teacher/questions", body, dialog.question ? "PATCH" : "POST", dialog.question ? "Question updated." : "A new question is ready for your students.")) closeDialog(); }} />}
      {dialog.type === "delete" && <><p className="muted">“{dialog.question.prompt}”</p><p>This question will be removed from your bank. Existing trip records will stay in place.</p><div className="modal-actions"><button className="button secondary" onClick={closeDialog}>Keep question</button><button className="button danger" disabled={!!busy} onClick={async () => { if (await mutate("delete", `/teacher/questions/${dialog.question.id}`, undefined, "DELETE", "Question removed from your bank.")) closeDialog(); }}>{busy ? "Deleting…" : "Delete question"}</button></div></>}
    </Modal>}
  </div>;
}

function Stat({ icon, label, value, unit, detail, color, badge }: { icon: ReactNode; label: string; value: string; unit?: string; detail: string; color: string; badge?: string }) {
  return <article className={`stat-card ${styles.statCard}`}><div className={styles.statTop}><span className={`stat-icon ${styles[color]}`}>{icon}</span><span className="stat-label">{label}</span></div><div className={styles.statNumber}><strong className="stat-value">{value}</strong>{unit && <span>{unit}</span>}{badge && <span className={styles.statBadge}>{badge}</span>}</div><p className="stat-description">{detail}</p></article>;
}
function SearchField({ value, onChange, label, placeholder }: { value: string; onChange: (value: string) => void; label: string; placeholder: string }) {
  return <label className={styles.searchField}><Search size={17} /><span className={styles.srOnly}>{label}</span><input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></label>;
}
function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="empty-state"><span className={styles.emptyIcon}>{icon}</span><h3>{title}</h3><p className="muted">{text}</p></div>;
}
function VisitTable({ visits, empty, compact = false }: { visits: Visit[]; empty: string; compact?: boolean }) {
  return <><div className="table-wrap"><table className="data-table"><thead><tr><th>Student</th>{!compact && <th>Date</th>}<th>Departure</th><th>Return</th><th>Time away</th><th>Status</th></tr></thead><tbody>{visits.map(visit => <tr key={visit.id}><td><div className={styles.studentCell}><span className="avatar">{initials(visit.studentName)}</span><strong>{visit.studentName}</strong></div></td>{!compact && <td>{new Date(visit.requestedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</td>}<td>{time(visit.leftAt)}</td><td>{time(visit.returnedAt)}</td><td>{duration(visit.leftAt, visit.returnedAt)}</td><td><span className={`badge ${visitColor(visit.status)}`}><span className={styles.statusDot} />{visitLabel(visit.status)}</span></td></tr>)}</tbody></table></div>{!visits.length && <Empty icon={<Clock3 size={28} />} title="No trips just yet" text={empty} />}</>;
}
function localDate(value: string) { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function StudentForm({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (body: { firstName: string; lastName: string }) => Promise<void>; onCancel: () => void }) {
  const [firstName, setFirstName] = useState(""); const [lastName, setLastName] = useState("");
  const username = `${firstName}${lastName}`.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return <form onSubmit={event => { event.preventDefault(); void onSubmit({ firstName: firstName.trim(), lastName: lastName.trim() }); }}><p className="muted">Add their name now. They’ll choose a password when they sign up with your classroom code.</p><div className="form-grid"><label className="field">First name<input className="input" autoComplete="off" required maxLength={50} value={firstName} onChange={event => setFirstName(event.target.value)} /></label><label className="field">Last name<input className="input" autoComplete="off" required maxLength={50} value={lastName} onChange={event => setLastName(event.target.value)} /></label></div><div className={styles.usernamePreview}><span>Student username</span><code>{username || "firstnamelastname"}</code></div><div className="modal-actions"><button className="button secondary" type="button" onClick={onCancel}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Adding…" : "Add student"}<Plus size={16} /></button></div></form>;
}
function ResetForm({ student, busy, onSubmit, onCancel }: { student: RosterStudent; busy: boolean; onSubmit: (password: string) => Promise<void>; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  return <form onSubmit={event => { event.preventDefault(); void onSubmit(password); }}><p className="muted">Set a temporary password for <strong>{student.username}</strong>. Their current sessions will end, and they’ll choose a new password after signing in.</p><label className="field">Temporary password<input className="input" type="password" required minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder="At least 8 characters" /></label><p className={styles.formHint}>Share the temporary password with this student privately.</p><div className="modal-actions"><button className="button secondary" type="button" onClick={onCancel}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : "Reset password"}</button></div></form>;
}
function QuestionForm({ question, busy, onSubmit, onCancel }: { question?: Question; busy: boolean; onSubmit: (question: Omit<Question, "id">) => Promise<void>; onCancel: () => void }) {
  const [prompt, setPrompt] = useState(question?.prompt || "");
  const [options, setOptions] = useState(question?.options || ["", "", "", ""]);
  const [correctIndex, setCorrectIndex] = useState(question?.correctIndex ?? 0);
  const [topic, setTopic] = useState(question?.topic || "Cell biology");
  const [explanation, setExplanation] = useState(question?.explanation || "");
  const [active, setActive] = useState(question?.active ?? true);
  const [validation, setValidation] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (prompt.trim().length < 8) { setValidation("Write a question with at least 8 characters."); return; }
    if (!topic.trim()) { setValidation("Add a topic for this question."); return; }
    if (options.some(option => !option.trim())) { setValidation("Fill in all four answer options."); return; }
    if (new Set(options.map(option => option.trim().toLowerCase())).size !== options.length) { setValidation("Each answer option must be different."); return; }
    setValidation(""); void onSubmit({ prompt: prompt.trim(), options: options.map(option => option.trim()), correctIndex, topic: topic.trim(), explanation: explanation.trim(), active });
  };
  return <form onSubmit={submit} className={styles.questionForm}>{validation && <div className="alert error" role="alert">{validation}</div>}<label className="field">Question<textarea className="textarea" value={prompt} onChange={event => setPrompt(event.target.value)} required minLength={8} maxLength={1000} rows={3} placeholder="What would you like your students to remember?" /></label><label className="field">Topic<input className="input" value={topic} onChange={event => setTopic(event.target.value)} required maxLength={80} placeholder="e.g. Cell biology" /></label><fieldset className={styles.optionFields}><legend>Answer options <span>Select the correct answer</span></legend>{options.map((option, index) => <label key={index} className={`${styles.optionField} ${correctIndex === index ? styles.optionFieldCorrect : ""}`}><input type="radio" name="correct-answer" checked={correctIndex === index} onChange={() => setCorrectIndex(index)} aria-label={`Option ${String.fromCharCode(65 + index)} is correct`} /><span>{String.fromCharCode(65 + index)}</span><input className="input" aria-label={`Answer option ${String.fromCharCode(65 + index)}`} value={option} onChange={event => setOptions(options.map((current, currentIndex) => currentIndex === index ? event.target.value : current))} required maxLength={300} placeholder={`Answer ${String.fromCharCode(65 + index)}`} /></label>)}</fieldset><label className="field">Explanation <span className="muted">(optional)</span><textarea className="textarea" value={explanation} onChange={event => setExplanation(event.target.value)} maxLength={2000} rows={2} placeholder="A helpful explanation for the learning moment." /></label><label className={styles.checkboxField}><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} />Active — include this question in student quizzes</label><div className="modal-actions"><button className="button secondary" type="button" onClick={onCancel}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : question ? "Save question" : "Add question"}<Check size={16} /></button></div></form>;
}
function PasswordSettings({ onSaved }: { onSaved: () => void }) {
  const [currentPassword, setCurrentPassword] = useState(""); const [newPassword, setNewPassword] = useState(""); const [confirmPassword, setConfirmPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (newPassword !== confirmPassword) { setError("The new passwords do not match."); return; } setBusy(true); setError(""); try { await post("/auth/password", { currentPassword, newPassword }); setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); onSaved(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update password."); } finally { setBusy(false); } };
  return <section className="card"><div className="card-header"><div><h2>Account security</h2><p className="muted">Keep your teacher account just for you.</p></div><ShieldCheck size={23} /></div><form className={styles.settingsForm} onSubmit={event => void submit(event)}>{error && <div role="alert" className="alert error">{error}</div>}<label className="field">Current password<input className="input" type="password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" /></label><div className="form-grid"><label className="field">New password<input className="input" type="password" required minLength={8} maxLength={128} value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" /></label><label className="field">Confirm new password<input className="input" type="password" required minLength={8} maxLength={128} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" /></label></div><button className="button primary" disabled={busy}>{busy ? "Updating…" : "Update password"}</button></form></section>;
}
