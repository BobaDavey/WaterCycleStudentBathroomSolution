"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, BellRing, BookOpen, Check, CheckCircle2, ChevronRight, CircleHelp, Clock3, Droplets, Footprints, History, Home, Leaf, LoaderCircle, LogOut, ShieldCheck, Sparkles, Sprout, Timer, Toilet, TriangleAlert, Users, Volume2, VolumeX, X } from "lucide-react";
import { api, duration, post, time } from "@/lib/client";
import type { BreakPurpose, Quiz, QuizResult, StudentState, User, Visit } from "@/lib/contracts";
import { formatClassDate } from "@/lib/time-zones";
import styles from "./student-dashboard.module.css";

function elapsed(start: string | null, now: number) {
  if (!start) return "00:00";
  const seconds = Math.max(0, Math.floor((now - new Date(start).getTime()) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function remaining(deadline: string | null, now: number) {
  if (!deadline) return "—";
  const seconds = Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000));
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function purposeName(purpose: BreakPurpose | null) { return purpose === "water" ? "Drink Water" : purpose === "restroom" ? "Restroom" : "Classroom Break"; }

export function StudentDashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [state, setState] = useState<StudentState | null>(null);
  const [view, setView] = useState<"home" | "activity">("home");
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [accessNotice,setAccessNotice] = useState(false);
  const [choosingPurpose, setChoosingPurpose] = useState(false);
  const [purpose, setPurpose] = useState<BreakPurpose | null>(null);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [pendingQuiz, setPendingQuiz] = useState<Quiz | null>(null);
  const [answer, setAnswer] = useState(-1);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [sound, setSound] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [help, setHelp] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [tutorialCompleted, setTutorialCompleted] = useState(false);
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [enrollmentCode, setEnrollmentCode] = useState("");
  const previousClassroom = useRef<string | null | undefined>(undefined);
  const previousStatus = useRef<string | null>(null);
  const previousVisit = useRef<Visit | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const soundEnabled = useRef(false);
  const notificationsEnabled = useRef(false);
  const serverOffset = useRef(0);
  const mutationEpoch = useRef(0);
  const mutationPending = useRef(false);
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    const epoch = mutationEpoch.current;
    const sequence = ++refreshSequence.current;
    try {
      const data = await api<StudentState>("/student/state");
      if (mutationPending.current || epoch !== mutationEpoch.current || sequence !== refreshSequence.current) return null;
      const serverTime = Date.parse(data.serverNow);
      if (Number.isFinite(serverTime)) serverOffset.current = serverTime - Date.now();
      setState(data);
      setConnectionError("");
      return data;
    } catch (err) {
      if (epoch === mutationEpoch.current && sequence === refreshSequence.current && !mutationPending.current) setConnectionError(err instanceof Error ? err.message : "Could not connect to your classroom.");
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => { void refresh(); }, 3000);
    const wake = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", wake);
    return () => { window.clearInterval(poll); document.removeEventListener("visibilitychange", wake); };
  }, [refresh]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const visit = state?.currentVisit;
  useEffect(() => {
    if (!state) return;
    const classroomId = state.classroom?.id ?? null;
    const changed = previousClassroom.current !== undefined && previousClassroom.current !== classroomId;
    if (changed || !state.canRequestPass) {
      setQuiz(null); setPendingQuiz(null); setResult(null); setAnswer(-1); setChoosingPurpose(false); setPurpose(null);
    }
    if (changed) setMessage("Your class enrollment has changed. Your earlier activity is still available.");
    previousClassroom.current = classroomId;
  }, [state?.classroom?.id, state?.canRequestPass]);
  useEffect(() => {
    if (!state) return;
    if (state.currentVisit || !state.canRequestPass || !state.activeQuiz) {
      setQuiz(null); setPendingQuiz(null); setResult(null); setAnswer(-1);
      if (state.currentVisit) setChoosingPurpose(false);
      return;
    }
    setChoosingPurpose(false);
    if (pendingQuiz?.questionToken === state.activeQuiz.questionToken) return;
    if (quiz?.questionToken !== state.activeQuiz.questionToken) {
      setQuiz(state.activeQuiz); setPendingQuiz(null); setPurpose(state.activeQuiz.purpose); setAnswer(-1); setResult(null);
    }
  // Synchronize only when a new server snapshot arrives, retaining answer feedback between polls.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  useEffect(() => {
    if (!state) return;
    const status = state.currentVisit?.status ?? null;
    const prior = previousVisit.current;
    if (prior?.status === "ready" && !state.currentVisit && prior.readyExpiresAt && Date.parse(prior.readyExpiresAt) <= Date.parse(state.serverNow)) {
      setMessage("Your response window expired. Request a new break when you’re ready.");
    } else if (prior && ["ready", "waiting"].includes(prior.status) && !state.currentVisit && state.recentVisits.some(item => item.id === prior.id && item.status === "cancelled")) {
      setMessage("Your request has ended. Request a new break when you’re ready.");
    }
    if (status === "ready" && previousStatus.current === "waiting") {
      setMessage("It's your turn! You're cleared to go.");
      if (soundEnabled.current && audio.current) {
        void audio.current.resume().then(() => {
          if (!audio.current) return;
          [0, 0.22, 0.44].forEach((delay, index) => {
            const oscillator = audio.current!.createOscillator();
            const gain = audio.current!.createGain();
            oscillator.connect(gain); gain.connect(audio.current!.destination);
            oscillator.frequency.value = [523, 659, 784][index];
            const at = audio.current!.currentTime + delay;
            gain.gain.setValueAtTime(0, at);
            gain.gain.linearRampToValueAtTime(0.15, at + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, at + 0.4);
            oscillator.start(at); oscillator.stop(at + 0.4);
          });
        }).catch(() => { /* The visible turn alert is always available. */ });
      }
      if (notificationsEnabled.current && "Notification" in window && Notification.permission === "granted") {
        try { new Notification("WaterCycle · It's your turn", { body: "You're cleared to go. Open WaterCycle and tap I'm Leaving Now." }); } catch { /* Browser support varies. */ }
      }
    }
    previousStatus.current = status;
    previousVisit.current = state.currentVisit;
    document.title = status === "ready" ? "It's your turn! · WaterCycle" : status === "out" ? "Your pass is active · WaterCycle" : "Student home · WaterCycle";
  }, [state]);

  useEffect(() => () => { document.title = "WaterCycle"; void audio.current?.close(); }, []);

  function beginMutation() {
    mutationPending.current = true; mutationEpoch.current += 1; refreshSequence.current += 1;
    setBusy(true); setError("");
  }

  async function finishMutation() {
    mutationEpoch.current += 1; mutationPending.current = false;
    await refresh(); setBusy(false);
  }

  async function action(path: string, success?: string) {
    beginMutation(); setMessage(""); setDialogError("");
    try {
      await post(path);
      if (success) setMessage(success);
    } catch (err) {
      const notice = err instanceof Error ? err.message : "Please try again.";
      setError(notice);
      if (path === "/student/return") setDialogError(notice);
    }
    finally { await finishMutation(); }
  }

  async function startQuiz() {
    if (!state?.classroom || !state.canRequestPass) {
      setError(state?.unavailableReason || "Join an active class before requesting a pass.");
      return;
    }
    if (!purpose) return;
    beginMutation(); setMessage("");
    try {
      const data = await post<Quiz>("/student/quiz", { purpose });
      setQuiz(data); setPendingQuiz(null); setAnswer(-1); setResult(null); setChoosingPurpose(false);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load questions."); }
    finally { await finishMutation(); }
  }

  async function submitQuiz(event: React.FormEvent) {
    event.preventDefault();
    if (!quiz || answer < 0 || pendingQuiz || busy) return;
    beginMutation();
    try {
      const feedback = await post<QuizResult>("/student/quiz/answer", { quizId: quiz.id, questionId: quiz.question.id, questionToken: quiz.questionToken, answer });
      setResult(feedback);
      if (feedback.passed) {
        setQuiz(null); setPendingQuiz(null); setResult(null); setAnswer(-1);
        setMessage(feedback.visit?.status === "out" ? "Correct Answers: 2/2. Your break has started." : "Correct Answers: 2/2. Your place in line is saved.");
      } else if (feedback.quiz) setPendingQuiz(feedback.quiz);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not check your answers."); }
    finally { await finishMutation(); }
  }

  async function cancelQuiz() {
    if (!quiz) return;
    beginMutation();
    try { await post("/student/quiz/cancel", { quizId: quiz.id }); setQuiz(null); setPendingQuiz(null); setResult(null); setPurpose(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not cancel your learning check."); }
    finally { await finishMutation(); }
  }

  async function completeTutorial() {
    if (state?.user.tutorialCompleted || tutorialCompleted) { setHelp(false); return; }
    beginMutation(); setDialogError("");
    try { await post("/student/tutorial"); setTutorialCompleted(true); setHelp(false); }
    catch (err) { setDialogError(err instanceof Error ? err.message : "Could not save your welcome guide. Please try again."); }
    finally { await finishMutation(); }
  }

  async function acknowledgeWarning() {
    if (!visit) return;
    beginMutation(); setDialogError(""); setView("home");
    setAcknowledgedWarnings(previous => new Set(previous).add(visit.id));
    try { await post(`/student/visits/${visit.id}/warning`); }
    catch (err) { setAcknowledgedWarnings(previous => { const next = new Set(previous); next.delete(visit.id); return next; }); setDialogError(err instanceof Error ? err.message : "Could not save your acknowledgement. Please try again."); }
    finally { await finishMutation(); }
  }

  async function enableAlerts() {
    const next = !sound;
    setSound(next); soundEnabled.current = next;
    if (!next) { notificationsEnabled.current = false; setNotificationMessage("Sound alerts off. Your turn still appears on this page."); return; }
    try {
      if (!audio.current) audio.current = new AudioContext();
      await audio.current.resume();
    } catch { setNotificationMessage("Sound is unavailable in this browser. Watch for the on-screen alert."); }
    if ("Notification" in window) {
      try {
        const permission = await Notification.requestPermission();
        notificationsEnabled.current = permission === "granted";
        setNotificationMessage(permission === "granted" ? "Sound and browser alerts enabled. Keep this page open." : "Sound enabled. Browser notifications are off; keep this page open.");
      } catch { setNotificationMessage("Sound enabled. Keep this page open for your turn."); }
    } else setNotificationMessage("Sound enabled. Keep this page open for your turn.");
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault(); beginMutation();
    try {
      await post("/auth/password", { currentPassword, newPassword });
      setCurrentPassword(""); setNewPassword("");
      setMessage("Your new password is saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not change your password."); }
    finally { await finishMutation(); }
  }

  async function enroll(event: React.FormEvent) {
    event.preventDefault();
    if (!/^[A-Z0-9]{5}$/.test(enrollmentCode)) {
      setError("Enter the five-character code your teacher gave you. Use English letters and numbers.");
      return;
    }
    beginMutation(); setMessage("");
    try {
      await post("/student/enroll", { classroomCode: enrollmentCode });
      setEnrollmentCode(""); setQuiz(null); setResult(null);
      setMessage("You’re enrolled. Your teacher must approve your account before you can request a break.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not join this class. Check the code with your teacher."); }
    finally { await finishMutation(); }
  }

  const mustChangePassword = state ? state.user.mustChangePassword : user.mustChangePassword;
  const accountStatus = state?.user.accountStatus ?? user.accountStatus;
  const restricted = accountStatus === 'pending' || accountStatus === 'deactivated';
  useEffect(() => { if (!restricted) setAccessNotice(false); }, [restricted]);
  const history = state?.recentVisits.filter(item => item.status === "returned" || item.status === "cancelled") ?? [];
  const classroom = state?.classroom;
  const capacity = classroom?.capacity ?? 2;
  const periodLabel = classroom?.period ? (/^period\b/i.test(classroom.period) ? classroom.period : `Period ${classroom.period}`) : "";
  const showPeriod = periodLabel && !classroom?.name.toLowerCase().includes(periodLabel.toLowerCase());
  const used = state?.activeCount ?? 0;
  const serverNow = now + serverOffset.current;
  const breakMilliseconds = visit?.status === "out" && visit.leftAt ? Math.max(0, serverNow - Date.parse(visit.leftAt)) : 0;
  const showTutorial = !mustChangePassword && Boolean(state?.classroom) && !state?.user.tutorialCompleted && !tutorialCompleted;
  const showWarning = visit?.status === "out" && breakMilliseconds >= 12 * 60000 && !visit.warningAcknowledgedAt && !acknowledgedWarnings.has(visit.id);

  return <div className="app-shell">
    <aside className="sidebar">
      <a href="/" className="sidebar-brand" aria-label="WaterCycle home"><Droplets size={29} /><span>WaterCycle<span className={styles.brandSub}>A BETTER CLASSROOM FLOW</span></span></a>
      <div className={styles.classLabel}><span className="eyebrow">YOUR CLASSROOM</span><strong>{classroom?.name ?? (state ? "No active class" : "Biology classroom")}</strong>{showPeriod && <small className={styles.periodLabel}>{periodLabel}</small>}<span><span className={styles.liveDot} />{classroom?.archived ? "Archived class" : "Student space"}</span></div>
      <nav className="sidebar-nav" aria-label="Student navigation">
        <button className={`nav-item ${view === "home" ? "active" : ""}`} onClick={() => setView("home")}><Home size={19} /> My dashboard</button>
        <button className={`nav-item ${view === "activity" ? "active" : ""}`} onClick={() => setView("activity")}><History size={19} /> My activity</button>
        <button className="nav-item" onClick={() => { setDialogError(""); setHelp(true); }}><CircleHelp size={19} /> How Breaks Work</button>
      </nav>
      <div className={styles.sidebarNote}><Leaf size={25} /><strong>Small questions.<br />Growing minds.</strong><p>A little biology before a little break.</p></div>
      <div className="sidebar-bottom"><div className={styles.profile}><span className="avatar">{user.firstName[0]}{user.lastName[0]}</span><div><strong>{user.firstName} {user.lastName}</strong><span>Student account</span></div></div><button className="nav-item" onClick={onLogout}><LogOut size={18} /> Sign out</button></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div className="topbar-left"><span className="muted">Student space</span><ChevronRight size={14} /><strong>{view === "home" ? "My dashboard" : "My activity"}</strong></div><div className="topbar-right"><span className={`badge ${classroom && !classroom.archived && !connectionError ? "green" : "gray"} ${styles.desktopBadge}`}><span className={styles.liveDot} />{connectionError ? "Reconnecting" : classroom?.archived ? "Archived classroom" : classroom ? "Classroom connected" : state ? "Enrollment needed" : "Connecting"}</span><button type="button" className={`button ghost small ${styles.alertToggle}`} onClick={() => void enableAlerts()} aria-pressed={sound} aria-label={sound ? "Turn off sound alerts" : "Enable turn alerts"}>{sound ? <Volume2 size={17} /> : <VolumeX size={17} />}<span>{sound ? "Alerts on" : "Enable alerts"}</span></button></div></header>
      <div className="page-content">
        <div className="page-heading"><div><p className="eyebrow">A QUICK LEARNING. A BETTER FLOW.</p><h1>{view === "home" ? `Hey, ${user.firstName}.` : "Your activity."}<span className={styles.headingDot}> ✦</span></h1><p className="muted">{view === "home" ? "Think, take a break, and get back to growing." : "Every break, from your first step out to your return."}</p></div><span className={styles.dateLabel}><Clock3 size={16} />{formatClassDate(now, state?.classroom?.timeZone, { weekday: "long", month: "short", day: "numeric" })}</span></div>
        {(error || connectionError) && <div className="alert error" role="alert"><span>{error || connectionError}</span><button type="button" className="button ghost small" onClick={() => { setError(""); void refresh(); }}>Retry</button></div>}
        {message && <div className="alert success" role="status"><CheckCircle2 size={18} /><span>{message}</span><button className="button ghost small" aria-label="Dismiss message" onClick={() => setMessage("")}><X size={15} /></button></div>}
        {notificationMessage && <div className="alert info" role="status"><Bell size={17} /><span>{notificationMessage}</span><button className="button ghost small" aria-label="Dismiss alert settings message" onClick={() => setNotificationMessage("")}><X size={15} /></button></div>}
        {restricted && <section className="alert info" role="status"><ShieldCheck size={22}/><div><strong>{accountStatus === "pending" ? "Your account is awaiting teacher approval." : "Your account is currently deactivated."}</strong><p>{accountStatus === "pending" ? "Your teacher must approve your account before you can request a break." : "Please contact your teacher if you believe this is a mistake."}</p></div></section>}
        {state?.classroom && !restricted && !state.canRequestPass && !mustChangePassword && <div className={`alert info ${styles.classNotice}`} role="status"><BookOpen size={18} /><span>{state.unavailableReason || "New passes are unavailable for this class right now. Your trip records are still available, and you can check in from an active trip."}</span></div>}
        {mustChangePassword ? <section className={`card ${styles.passwordCard}`}><div className={styles.circleIcon}><ShieldCheck size={27} /></div><p className="eyebrow">MAKE IT YOURS</p><h2>Choose a new password</h2><p className="muted">Your teacher reset your password. Set a new one before requesting a pass.</p><form onSubmit={changePassword}><label className="field">Temporary password<input className="input" type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label><label className="field">New password<input className="input" type="password" aria-label="New password" autoComplete="new-password" minLength={8} maxLength={128} required value={newPassword} onChange={event => setNewPassword(event.target.value)} /><span className="muted">Use at least 8 characters.</span></label><button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={17} className={styles.spin} /> : <ShieldCheck size={17} />}Save new password</button></form></section>
          : !state ? <section className={`card ${styles.loading}`} aria-busy="true"><LoaderCircle className={styles.spin} size={28} /><p>Finding your classroom…</p></section>
            : view === "activity" ? <section className="card"><div className="card-header"><div><h2>Your trip history</h2><p className="muted">Recent completed trips and cancelled requests.</p></div><span className="badge gray">{history.length} records</span></div><HistoryTable visits={history} /></section>
              : <>
                <div className={styles.studentGrid}>
                  <div className={styles.mainColumn}>
                    {visit ? <section className={`${styles.passCard} ${styles[visit.status]}`}>
                      <div className={styles.passCardTop}><span className={styles.passTag}>{visit.status === "waiting" ? <Users size={16} /> : visit.status === "ready" ? <BellRing size={16} /> : <Footprints size={16} />}{visit.status === "waiting" ? "IN THE QUEUE" : visit.status === "ready" ? "YOUR TURN IS HERE" : "CURRENTLY ON BREAK"}</span><span className={styles.passId}>CLASSROOM BREAK</span></div>
                      <span className={styles.purposeBadge}>{visit.purpose === "water" ? <Droplets size={15} /> : <Toilet size={15} />}{purposeName(visit.purpose)}</span>
                      {visit.status === "waiting" ? <>
                        <h2 aria-live="polite">You&apos;re in line!</h2>
                        <div className={styles.queueNumber}><span>Your position:</span> #{visit.position ?? "—"}</div>
                        <p>We&apos;ll notify you here when a space opens. Keep this page open. Your break timer hasn&apos;t started.</p>
                        <div className={styles.passActions}><button className="button secondary" onClick={() => void enableAlerts()}>{sound ? <Volume2 size={17} /> : <Bell size={17} />}{sound ? "Turn alerts off" : "Enable turn alerts"}</button><button className="button ghost" disabled={busy} onClick={() => void action("/student/cancel", "Your request was cancelled.")}>Cancel Request</button></div>
                      </> : visit.status === "ready" ? <>
                        <div className={styles.bigPassIcon}><CheckCircle2 size={46} strokeWidth={1.4} /></div>
                        <h2 aria-live="polite">{visit.reservationPaused ? "Your place is saved. Please wait for a spot." : "It's your turn! You're cleared to go."}</h2>
                        {visit.reservationPaused && <div className="alert info">All spots are currently occupied after a teacher correction. Keep your place; your response window is paused until a spot opens.</div>}
                        <p>Your space is reserved. Your timer starts when you tap &ldquo;I&apos;m Leaving Now.&rdquo;</p>
                        {visit.readyExpiresAt && !visit.reservationPaused && <div className={styles.reservation}><Clock3 size={15} /> You have 2 minutes to respond. <strong>{remaining(visit.readyExpiresAt, serverNow)}</strong> remaining to keep your turn. If you miss this window, the space goes to the next student.</div>}
                        <div className={styles.passActions}><button className="button primary" disabled={busy || !state.canRequestPass || visit.reservationPaused || Boolean(visit.readyExpiresAt && Date.parse(visit.readyExpiresAt) <= serverNow)} onClick={() => void action("/student/leave")}><Footprints size={18} />I&apos;m Leaving Now<ArrowRight size={17} /></button><button className="button ghost" disabled={busy} onClick={() => void action("/student/cancel", "Your pass was cancelled. The next student can go.")}>Cancel Request</button></div>
                      </> : <>
                        <h2 className={styles.successHeading} aria-live="polite">Your time is NOW, GRAB A PASS</h2>
                        <p className={styles.returnReminder}>Remember: You must return to class within 10 minutes.</p>
                        <div className={styles.tripTimer}><Timer size={28} /><output aria-label="Elapsed break time" aria-live="off">{elapsed(visit.leftAt, serverNow)}</output></div>
                        <span className={styles.timerCaption}>ELAPSED BREAK TIME · STARTED {time(visit.leftAt, visit.timeZone)}</span>
                        {breakMilliseconds >= 10 * 60000 && <div className={styles.timeReminder} role="status"><Clock3 size={18} /><span>You&apos;ve reached the 10-minute limit. Please return to class and click &ldquo;I&apos;m Back.&rdquo;</span></div>}
                        <div className={styles.passActions}><button className="button primary" disabled={busy} onClick={() => void action("/student/return", "Welcome back! Your return time has been saved.")}><CheckCircle2 size={19} />I&apos;m Back<ArrowRight size={17} /></button></div>
                      </>}
                    </section> : !classroom ? <section className={`card ${styles.enrollmentCard}`}>
                      <div className={styles.circleIcon}><Users size={27} /></div><p className="eyebrow">FIND YOUR CLASSROOM</p><h2>Join a class to get started.</h2><p className="muted">Your account and past activity are safe. Enter your teacher’s five-character code to join the right class automatically.</p>
                      <form onSubmit={enroll}><label className="field">Class enrollment code<input className={`input ${styles.codeInput}`} aria-label="Class enrollment code" aria-describedby="enrollment-code-help" pattern="[A-Za-z0-9]{5}" minLength={5} maxLength={5} autoComplete="off" autoCapitalize="characters" spellCheck={false} required placeholder="e.g. BIO01" value={enrollmentCode} onChange={event => setEnrollmentCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5))} /></label><p id="enrollment-code-help" className="field-hint">Use five English letters or numbers, including any zeros at the beginning.</p><button className="button primary" disabled={busy || enrollmentCode.length !== 5}>{busy ? <LoaderCircle className={styles.spin} size={18} /> : <Users size={18} />}Join class<ArrowRight size={18} /></button></form>
                    </section> : quiz ? <section className={`card ${styles.quizCard}`}>
                      <div className="card-header"><div><p className="eyebrow">A QUICK LEARNING</p><h2>A moment for biology.</h2></div><span className={`badge green ${styles.quizProgress}`} role="status"><BookOpen size={14} />Correct Answers: {result?.correctCount ?? quiz.correctCount}/2</span></div>
                      <span className={styles.purposeBadge}>{quiz.purpose === "water" ? <Droplets size={15} /> : <Toilet size={15} />}{purposeName(quiz.purpose)}</span>
                      <p className="muted">Get two answers right in total. Every correct answer counts, even if you miss one along the way.</p>
                      <div className={styles.progress} role="progressbar" aria-label="Correct answers" aria-valuemin={0} aria-valuemax={2} aria-valuenow={result?.correctCount ?? quiz.correctCount}><span style={{ width: `${(result?.correctCount ?? quiz.correctCount) * 50}%` }} /></div>
                      {result?.feedback[0] && <div className={styles.questionStatus} role="status"><p className={`${styles.feedback} ${result.feedback[0].correct ? styles.correct : styles.incorrect}`}>{result.feedback[0].correct ? <CheckCircle2 size={17} /> : <Sprout size={17} />}<span><strong>{result.feedback[0].correct ? "Nice work! " : "Keep going! "}</strong>{result.feedback[0].correct ? "One step closer. " : "Your correct answers are saved. "}{result.feedback[0].explanation}</span></p></div>}
                      {quiz.notice && <p className={styles.learningNote}>{quiz.notice}</p>}
                      <form onSubmit={submitQuiz}>
                        <fieldset key={quiz.questionToken} className={styles.question} disabled={busy || Boolean(pendingQuiz)}><legend><span className={styles.questionNumber}><Leaf size={14} /></span><span>{quiz.question.prompt}</span></legend><span className={`badge gray ${styles.topic}`}>{quiz.question.topic}</span><div className={styles.answers}>{quiz.question.options.map((option, optionIndex) => <label key={optionIndex} className={`${styles.answer} ${answer === optionIndex ? styles.selectedAnswer : ""}`}><input type="radio" name={`answer-${quiz.questionToken}`} value={optionIndex} checked={answer === optionIndex} onChange={() => setAnswer(optionIndex)} required /><span className={styles.optionLetter}>{String.fromCharCode(65 + optionIndex)}</span><span>{option}</span>{answer === optionIndex && <Check size={17} />}</label>)}</div></fieldset>
                        <div className={styles.quizFooter}><button type="button" className="button ghost" disabled={busy} onClick={() => void cancelQuiz()}>Cancel learning check</button>{pendingQuiz ? <button key="next-question" type="button" className="button primary" disabled={busy} onClick={() => { setQuiz(pendingQuiz); setPendingQuiz(null); setAnswer(-1); setResult(null); }}>Next question<ArrowRight size={17} /></button> : <button key="check-answer" type="submit" className="button primary" disabled={busy || answer < 0}>{busy ? <LoaderCircle className={styles.spin} size={17} /> : <CheckCircle2 size={17} />}Check my answer</button>}</div>
                      </form>
                    </section> : choosingPurpose ? <section className={`card ${styles.purposeCard}`}>
                      <p className="eyebrow">FIRST, A LITTLE DIRECTION</p><h2>What kind of break?</h2><p className="muted">Choose your purpose, then give your brain a quick biology moment.</p>
                      <fieldset className={styles.purposeFieldset} disabled={busy}><legend className={styles.purposeLegend}>Choose a break purpose</legend><div className={styles.purposeOptions}>
                        <label className={`${styles.purposeOption} ${purpose === "restroom" ? styles.purposeSelected : ""}`}><input type="radio" name="break-purpose" aria-label="Use Restroom" value="restroom" checked={purpose === "restroom"} onChange={() => setPurpose("restroom")} /><span><Toilet size={34} strokeWidth={1.5} /></span><strong>Use Restroom</strong><small>A quick restroom break</small></label>
                        <label className={`${styles.purposeOption} ${styles.waterOption} ${purpose === "water" ? styles.purposeSelected : ""}`}><input type="radio" name="break-purpose" aria-label="Drink Water" value="water" checked={purpose === "water"} onChange={() => setPurpose("water")} /><span><Droplets size={34} strokeWidth={1.5} /></span><strong>Drink Water</strong><small>A moment to refresh</small></label>
                      </div></fieldset>
                      <div className={styles.quizFooter}><button type="button" className="button ghost" disabled={busy} onClick={() => { setChoosingPurpose(false); setPurpose(null); }}>Back to dashboard</button><button className="button primary" disabled={busy || !purpose || !state.canRequestPass} onClick={() => void startQuiz()}>{busy ? <LoaderCircle className={styles.spin} size={17} /> : <BookOpen size={17} />}Continue<ArrowRight size={17} /></button></div>
                    </section> : <section className={styles.hero}><div className={styles.heroCopy}><span className={styles.heroPill}><Sparkles size={14} />A BRAIN BREAK STARTS HERE</span><h2>Ready for a<br />little break?</h2><p>A quick learning, then a little breathing room.<br className={styles.desktopBreak} /> Let&apos;s keep our classroom flowing.</p><button className="button primary" disabled={busy || (!restricted && (!state.canRequestPass || state.availableQuestions < 2))} onClick={() => { if(restricted){setAccessNotice(true);return;} setChoosingPurpose(true); setPurpose(null); setError(""); }}>{busy ? <LoaderCircle size={18} className={styles.spin} /> : <BookOpen size={18} />}Request a Break<ArrowRight size={18} /></button>{state.canRequestPass && state.availableQuestions < 2 && <p className={styles.unavailable}>Your teacher needs to add at least two active questions before you can request a break.</p>}<div className={styles.heroFootnote}><ShieldCheck size={15} />Two correct answers. A fair turn. Back in 10 minutes.</div></div><div className={styles.heroArt} aria-hidden="true"><div className={styles.orbitOne} /><div className={styles.orbitTwo} /><div className={styles.plant}><Sprout size={144} strokeWidth={1.2} /></div><span className={styles.artSpark}>✦</span><span className={styles.artLeaf}><Leaf size={25} /></span><span className={styles.artLabel}>ROOM TO GROW</span></div></section>}
                    <section className={`card ${styles.recentCard}`}><div className="card-header"><div><h2>Your recent activity</h2><p className="muted">A quick look at your last few breaks.</p></div><button className="button ghost small" onClick={() => setView("activity")}>View all<ArrowRight size={15} /></button></div><HistoryTable visits={history.slice(0, 3)} /></section>
                  </div>
                  <aside className={styles.rightColumn}>
                    {classroom ? <section className={`card ${styles.capacityCard}`}><div className="card-header"><h2>Classroom flow</h2><span className={styles.liveLabel}><span className={styles.liveDot} />LIVE</span></div><p className="muted">A maximum of {capacity} students at a time keeps things moving.</p><div className={styles.capacitySlots}>{Array.from({ length: capacity }, (_, index) => <div key={index} className={`${styles.capacitySlot} ${index < used ? styles.slotUsed : ""}`}><div><Footprints size={24} strokeWidth={1.6} /></div><strong>{index < used ? "In use" : "Available"}</strong><span>Space {index + 1}</span></div>)}</div><div className={styles.queueSummary}><Users size={17} /><span>{state.waitingCount === 0 ? "No one is waiting" : `${state.waitingCount} ${state.waitingCount === 1 ? "student" : "students"} in the queue`}</span></div><p className={styles.capacityNote}>Spaces include students getting ready to leave.</p></section> : <section className={`card ${styles.enrollmentInfo}`}><div className="card-header"><h2>A place for your learning.</h2><Sprout size={24} /></div><p>Each teacher’s code connects you to a specific class period. You won’t need to choose a teacher or class yourself.</p><div><ShieldCheck size={19} /><p>Your existing account and previous trip records stay with you when your enrollment changes.</p></div></section>}
                    <section className={styles.stepsCard}><span className="eyebrow">A GOOD FLOW, IN THREE STEPS</span><h2>Think. Go. Grow.</h2><ol><li><span>01</span><div><strong>Give your brain a moment</strong><p>Choose your break purpose. Get two biology answers right in total.</p></div></li><li><span>02</span><div><strong>Wait for your green light</strong><p>Your timer starts if a space is open. Otherwise, join the line and watch for your turn.</p></div></li><li><span>03</span><div><strong>Return within 10 minutes</strong><p>Click &ldquo;I&apos;m Back&rdquo; when you return so the next student can go.</p></div></li></ol></section>
                  </aside>
                </div>
                <footer className={styles.footer}><span><Droplets size={15} />A little structure. A lot more learning.</span><span>Made for your classroom.</span></footer>
              </>}
      </div>
    </main>
    {accessNotice && !showWarning && <StudentModal labelledBy="access-heading" onDismiss={()=>setAccessNotice(false)}><h2 id="access-heading">{accountStatus==="deactivated"?"Break Access Unavailable":"Account Approval Required"}</h2><p>{accountStatus==="deactivated"?"Your account is currently deactivated. Please contact your teacher if you believe this is a mistake.":"Your account has not been approved by your teacher yet. Please contact your teacher to request approval before using WaterCycle's break system."}</p><div className="modal-actions"><button className="button primary" onClick={()=>setAccessNotice(false)}>Got It</button></div></StudentModal>}
    {(showTutorial || help) && !showWarning && <StudentModal labelledBy="help-heading" onDismiss={showTutorial ? undefined : () => setHelp(false)}>
      <div className={styles.tutorialArt}><Sprout size={34} strokeWidth={1.5} /></div>
      <div className="modal-header"><div><p className="eyebrow">A LITTLE GUIDE TO A GOOD FLOW</p><h2 id="help-heading">Welcome to WaterCycle</h2><p>A quick learning. A little breathing room. Here&apos;s how your break works.</p></div>{!showTutorial && <button className="button ghost small" onClick={() => setHelp(false)} aria-label="Close How Breaks Work"><X size={20} /></button>}</div>
      <ol className={styles.tutorialSteps}>
        <li><div className={styles.tutorialStepTop}><Footprints size={27} strokeWidth={1.5} /><span>STEP 01</span></div><div><h3>Request a Break</h3><p>Choose whether you need to use the restroom or drink water.</p></div></li>
        <li><div className={styles.tutorialStepTop}><BookOpen size={27} strokeWidth={1.5} /><span>STEP 02</span></div><div><h3>Quick Learning</h3><p>Answer two biology questions correctly. Your correct answers add up.</p></div></li>
        <li><div className={styles.tutorialStepTop}><BellRing size={27} strokeWidth={1.5} /><span>STEP 03</span></div><div><h3>Get Your Turn</h3><p>An open space starts your timer immediately. Otherwise, wait for your turn and tap &ldquo;I&apos;m Leaving Now.&rdquo;</p></div></li>
        <li><div className={styles.tutorialStepTop}><CheckCircle2 size={27} strokeWidth={1.5} /><span>STEP 04</span></div><div><h3>Return to Class</h3><p>Return within 10 minutes and click &ldquo;I&apos;m Back&rdquo; when you return.</p></div></li>
      </ol>
      {dialogError && <p className={`alert error ${styles.dialogError}`} role="alert">{dialogError}</p>}
      <button className={`button primary ${styles.dialogAction}`} disabled={busy} onClick={() => void completeTutorial()}>{busy ? <LoaderCircle className={styles.spin} size={17} /> : <Check size={17} />}Got It! Let&apos;s Go<ArrowRight size={17} /></button>
    </StudentModal>}
    {showWarning && visit && <StudentModal labelledBy="warning-heading" describedBy="warning-copy" warning>
      <div className={`${styles.tutorialArt} ${styles.warningIcon}`}><TriangleAlert size={32} strokeWidth={1.5} /></div>
      <div className="modal-header"><h2 id="warning-heading">⚠️ You Have Used 12 Minutes!</h2></div>
      <p id="warning-copy" className={styles.warningCopy}>You have exceeded the 10-minute bathroom break limit.</p><p className={styles.seriousWarning}><strong>IF YOU EXCEED 10 MINUTES AGAIN, YOUR BREAK PRIVILEGES WILL BE TAKEN AWAY.</strong></p>
      <div className={styles.warningTimer}><span>YOUR BREAK TIMER IS STILL RUNNING</span><strong>{elapsed(visit.leftAt, serverNow)}</strong></div>
      {dialogError && <p className={`alert error ${styles.dialogError}`} role="alert">{dialogError}</p>}
      <div className={styles.warningActions}><button className="button primary" disabled={busy} onClick={() => void acknowledgeWarning()}>{busy ? <LoaderCircle className={styles.spin} size={17} /> : <Check size={17} />}I Got It</button></div>
    </StudentModal>}
  </div>;
}

function StudentModal({ children, labelledBy, describedBy, onDismiss, warning = false }: { children: React.ReactNode; labelledBy: string; describedBy?: string; onDismiss?: () => void; warning?: boolean }) {
  const dialog = useRef<HTMLElement>(null);
  const dismiss = useRef(onDismiss);
  useEffect(() => { dismiss.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(element.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(node => node.getClientRects().length > 0);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismiss.current?.(); return; }
      if (event.key !== "Tab") return;
      const controls = focusable();
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); element.focus({ preventScroll: true }); return; }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === element || !element.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || active === element || !element.contains(active))) { event.preventDefault(); first.focus(); }
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) element.focus({ preventScroll: true });
    };
    element.focus({ preventScroll: true });
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", keydown); document.removeEventListener("focusin", containFocus);
      document.body.style.overflow = originalOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return <div className="modal-backdrop"><section ref={dialog} className={`modal ${styles.studentDialog} ${warning ? styles.warningDialog : ""}`} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-describedby={describedBy}>{children}</section></div>;
}

function HistoryTable({ visits }: { visits: Visit[] }) {
  if (visits.length === 0) return <div className="empty-state"><div className={styles.emptyIcon}><History size={25} /></div><h3>A fresh start.</h3><p className="muted">Your completed breaks will appear here.</p></div>;
  const showClass = visits.some(visit => Boolean(visit.classroomName));
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>Date</th>{showClass && <th>Class</th>}<th>Purpose</th><th>Left</th><th>Returned</th><th>Duration</th><th>Status</th></tr></thead><tbody>{visits.map(visit => <tr key={visit.id}><td>{formatClassDate(visit.requestedAt, visit.timeZone, { month: "short", day: "numeric" })}</td>{showClass && <td>{visit.classroomName || "Earlier class"}</td>}<td>{visit.purpose ? purposeName(visit.purpose) : "Not recorded"}</td><td>{time(visit.leftAt, visit.timeZone)}</td><td>{time(visit.returnedAt, visit.timeZone)}</td><td>{duration(visit.leftAt, visit.returnedAt)}</td><td><span className={`badge ${visit.status === "returned" ? "green" : "gray"}`}>{visit.status === "returned" ? "Returned" : "Cancelled"}</span></td></tr>)}</tbody></table></div>;
}
