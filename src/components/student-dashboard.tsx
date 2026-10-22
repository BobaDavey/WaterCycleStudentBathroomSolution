"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, BellRing, BookOpen, Check, CheckCircle2, ChevronRight, CircleHelp, Clock3, Droplets, Footprints, History, Home, Leaf, LoaderCircle, LogOut, ShieldCheck, Sparkles, Sprout, Timer, Users, Volume2, VolumeX, X } from "lucide-react";
import { api, duration, post, time } from "@/lib/client";
import type { Quiz, QuizResult, StudentState, User, Visit } from "@/lib/contracts";
import styles from "./student-dashboard.module.css";

function elapsed(start: string | null, now: number) {
  if (!start) return "00:00";
  const seconds = Math.max(0, Math.floor((now - new Date(start).getTime()) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export function StudentDashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [state, setState] = useState<StudentState | null>(null);
  const [view, setView] = useState<"home" | "activity">("home");
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<number[]>([-1, -1]);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [sound, setSound] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [help, setHelp] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const previousStatus = useRef<string | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const soundEnabled = useRef(false);
  const notificationsEnabled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api<StudentState>("/student/state");
      setState(data);
      setConnectionError("");
      return data;
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : "Could not connect to your classroom.");
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
    const status = state.currentVisit?.status ?? null;
    if (status === "ready" && previousStatus.current === "waiting") {
      setMessage("It's your turn! A bathroom space is ready for you.");
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
        try { new Notification("WaterCycle · It's your turn", { body: "A bathroom space is ready. Open WaterCycle and tap I'm leaving." }); } catch { /* Browser support varies. */ }
      }
    }
    previousStatus.current = status;
    document.title = status === "ready" ? "It's your turn! · WaterCycle" : status === "out" ? "Your pass is active · WaterCycle" : "Student home · WaterCycle";
  }, [state]);

  useEffect(() => () => { document.title = "WaterCycle"; void audio.current?.close(); }, []);

  async function action(path: string, success?: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      await post(path);
      await refresh();
      if (success) setMessage(success);
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }

  async function startQuiz() {
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await post<Quiz>("/student/quiz");
      setQuiz(data); setAnswers(data.questions.map(() => -1)); setResult(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load questions."); }
    finally { setBusy(false); }
  }

  async function submitQuiz(event: React.FormEvent) {
    event.preventDefault();
    if (!quiz || answers.some(answer => answer < 0)) return;
    setBusy(true); setError("");
    try {
      const feedback = await post<QuizResult>("/student/quiz/submit", { quizId: quiz.id, answers });
      setResult(feedback);
      if (feedback.passed) {
        setQuiz(null); setResult(null);
        setMessage("Two for two! Your bathroom pass request is in.");
        await refresh();
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Could not check your answers."); }
    finally { setBusy(false); }
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
    event.preventDefault(); setBusy(true); setError("");
    try {
      await post("/auth/password", { currentPassword, newPassword });
      setCurrentPassword(""); setNewPassword("");
      await refresh(); setMessage("Your new password is saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not change your password."); }
    finally { setBusy(false); }
  }

  const mustChangePassword = state ? state.user.mustChangePassword : user.mustChangePassword;
  const history = state?.recentVisits.filter(item => item.status === "returned" || item.status === "cancelled") ?? [];
  const capacity = state?.classroom.capacity ?? 2;
  const used = state?.activeCount ?? 0;

  return <div className="app-shell">
    <aside className="sidebar">
      <a href="/" className="sidebar-brand" aria-label="WaterCycle home"><Droplets size={29} /><span>WaterCycle<span className={styles.brandSub}>A BETTER CLASSROOM FLOW</span></span></a>
      <div className={styles.classLabel}><span className="eyebrow">YOUR CLASSROOM</span><strong>{state?.classroom.name ?? "Biology classroom"}</strong><span><span className={styles.liveDot} /> Student space</span></div>
      <nav className="sidebar-nav" aria-label="Student navigation">
        <button className={`nav-item ${view === "home" ? "active" : ""}`} onClick={() => setView("home")}><Home size={19} /> My dashboard</button>
        <button className={`nav-item ${view === "activity" ? "active" : ""}`} onClick={() => setView("activity")}><History size={19} /> My activity</button>
        <button className="nav-item" onClick={() => setHelp(true)}><CircleHelp size={19} /> How it works</button>
      </nav>
      <div className={styles.sidebarNote}><Leaf size={25} /><strong>Small questions.<br />Growing minds.</strong><p>A little biology before a little break.</p></div>
      <div className="sidebar-bottom"><div className={styles.profile}><span className="avatar">{user.firstName[0]}{user.lastName[0]}</span><div><strong>{user.firstName} {user.lastName}</strong><span>Student account</span></div></div><button className="nav-item" onClick={onLogout}><LogOut size={18} /> Sign out</button></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div className="topbar-left"><span className="muted">Student space</span><ChevronRight size={14} /><strong>{view === "home" ? "My dashboard" : "My activity"}</strong></div><div className="topbar-right"><span className={`badge ${state && !connectionError ? "green" : "gray"} ${styles.desktopBadge}`}><span className={styles.liveDot} />{connectionError ? "Reconnecting" : state ? "Classroom connected" : "Connecting"}</span><button type="button" className={`button ghost small ${styles.alertToggle}`} onClick={() => void enableAlerts()} aria-pressed={sound} aria-label={sound ? "Turn off sound alerts" : "Enable turn alerts"}>{sound ? <Volume2 size={17} /> : <VolumeX size={17} />}<span>{sound ? "Alerts on" : "Enable alerts"}</span></button></div></header>
      <div className="page-content">
        <div className="page-heading"><div><p className="eyebrow">A LITTLE LEARNING. A BETTER FLOW.</p><h1>{view === "home" ? `Hey, ${user.firstName}.` : "Your activity."}<span className={styles.headingDot}> ✦</span></h1><p className="muted">{view === "home" ? "Think, take a break, and get back to growing." : "Every break, from your first step out to your return."}</p></div><span className={styles.dateLabel}><Clock3 size={16} />{new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</span></div>
        {(error || connectionError) && <div className="alert error" role="alert"><span>{error || connectionError}</span><button type="button" className="button ghost small" onClick={() => { setError(""); void refresh(); }}>Retry</button></div>}
        {message && <div className="alert success" role="status"><CheckCircle2 size={18} /><span>{message}</span><button className="button ghost small" aria-label="Dismiss message" onClick={() => setMessage("")}><X size={15} /></button></div>}
        {notificationMessage && <div className="alert info" role="status"><Bell size={17} /><span>{notificationMessage}</span><button className="button ghost small" aria-label="Dismiss alert settings message" onClick={() => setNotificationMessage("")}><X size={15} /></button></div>}
        {mustChangePassword ? <section className={`card ${styles.passwordCard}`}><div className={styles.circleIcon}><ShieldCheck size={27} /></div><p className="eyebrow">MAKE IT YOURS</p><h2>Choose a new password</h2><p className="muted">Your teacher reset your password. Set a new one before requesting a pass.</p><form onSubmit={changePassword}><label className="field">Temporary password<input className="input" type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label><label className="field">New password<input className="input" type="password" aria-label="New password" autoComplete="new-password" minLength={8} maxLength={128} required value={newPassword} onChange={event => setNewPassword(event.target.value)} /><span className="muted">Use at least 8 characters.</span></label><button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={17} className={styles.spin} /> : <ShieldCheck size={17} />}Save new password</button></form></section>
          : !state ? <section className={`card ${styles.loading}`} aria-busy="true"><LoaderCircle className={styles.spin} size={28} /><p>Finding your classroom…</p></section>
            : view === "activity" ? <section className="card"><div className="card-header"><div><h2>Your trip history</h2><p className="muted">Recent completed trips and cancelled requests.</p></div><span className="badge gray">{history.length} records</span></div><HistoryTable visits={history} /></section>
              : <>
                <div className={styles.studentGrid}>
                  <div className={styles.mainColumn}>
                    {visit ? <section className={`${styles.passCard} ${styles[visit.status]}`} aria-live="polite">
                      <div className={styles.passCardTop}><span className={styles.passTag}>{visit.status === "waiting" ? <Users size={16} /> : visit.status === "ready" ? <BellRing size={16} /> : <Footprints size={16} />}{visit.status === "waiting" ? "IN THE QUEUE" : visit.status === "ready" ? "YOUR TURN IS HERE" : "PASS IN PROGRESS"}</span><span className={styles.passId}>BATHROOM PASS</span></div>
                      {visit.status === "waiting" ? <><div className={styles.queueNumber}>{visit.position ?? "—"}<span>in line</span></div><h2>Your break is on its way.</h2><p>You&apos;re in the queue. We&apos;ll let you know as soon as a space opens. Keep this page open.</p><div className={styles.passActions}><button className="button secondary" onClick={() => void enableAlerts()}>{sound ? <Volume2 size={17} /> : <Bell size={17} />}{sound ? "Turn alerts off" : "Enable turn alerts"}</button><button className="button ghost" disabled={busy} onClick={() => void action("/student/cancel", "Your request was cancelled.")}>Leave the queue</button></div></>
                        : visit.status === "ready" ? <><div className={styles.bigPassIcon}><CheckCircle2 size={46} strokeWidth={1.4} /></div><h2>It&apos;s your turn!</h2><p>A space is reserved for you. Tap below when you&apos;re actually heading out so your time is recorded correctly.</p><div className={styles.passActions}><button className="button primary" disabled={busy} onClick={() => void action("/student/leave")}><Footprints size={18} />I&apos;m leaving<ArrowRight size={17} /></button><button className="button ghost" disabled={busy} onClick={() => void action("/student/cancel", "Your pass was cancelled. The next student can go.")}>Cancel my pass</button></div></>
                          : <><div className={styles.tripTimer}><Timer size={28} /><span>{elapsed(visit.leftAt, now)}</span></div><h2>Enjoy your little break.</h2><p>You left at {time(visit.leftAt)}. Remember to check in when you return to the classroom.</p><div className={styles.passActions}><button className="button primary" disabled={busy} onClick={() => void action("/student/return", "Welcome back! Your return time has been saved.")}><CheckCircle2 size={19} />I&apos;m back<ArrowRight size={17} /></button></div></>}
                    </section> : quiz ? <section className={`card ${styles.quizCard}`}><div className="card-header"><div><p className="eyebrow">YOUR TWO-QUESTION CHECK-IN</p><h2>A moment for biology.</h2></div><span className="badge green"><BookOpen size={14} />{answers.filter(answer => answer >= 0).length} / {quiz.questions.length}</span></div><p className="muted">Answer both questions correctly to request your pass. You can try again if you miss one.</p><form onSubmit={submitQuiz}>{quiz.questions.map((question, index) => {
                      const feedback = result?.feedback.find(item => item.questionId === question.id);
                      return <fieldset key={question.id} className={styles.question} disabled={busy || Boolean(result)}><legend><span className={styles.questionNumber}>{index + 1}</span><span>{question.prompt}</span></legend><span className={`badge gray ${styles.topic}`}>{question.topic}</span><div className={styles.answers}>{question.options.map((option, optionIndex) => <label key={optionIndex} className={`${styles.answer} ${answers[index] === optionIndex ? styles.selectedAnswer : ""}`}><input type="radio" name={`answer-${question.id}`} value={optionIndex} checked={answers[index] === optionIndex} onChange={() => setAnswers(previous => previous.map((answer, answerIndex) => answerIndex === index ? optionIndex : answer))} required /><span className={styles.optionLetter}>{String.fromCharCode(65 + optionIndex)}</span><span>{option}</span>{answers[index] === optionIndex && <Check size={17} />}</label>)}</div>{feedback && <p className={`${styles.feedback} ${feedback.correct ? styles.correct : styles.incorrect}`}><strong>{feedback.correct ? "That's right. " : "Not quite. "}</strong>{feedback.explanation}</p>}</fieldset>;
                    })}{result ? <div className={styles.quizFooter}><p className="muted">{result.correctCount} of 2 correct. A fresh pair is waiting for you.</p><button type="button" className="button primary" disabled={busy} onClick={() => void startQuiz()}>Try two new questions<ArrowRight size={17} /></button></div> : <div className={styles.quizFooter}><button type="button" className="button ghost" disabled={busy} onClick={() => { setQuiz(null); setResult(null); }}>Come back later</button><button className="button primary" disabled={busy || answers.some(answer => answer < 0)}>{busy ? <LoaderCircle className={styles.spin} size={17} /> : <CheckCircle2 size={17} />}Check my answers</button></div>}</form></section> : <section className={styles.hero}><div className={styles.heroCopy}><span className={styles.heroPill}><Sparkles size={14} />A BRAIN BREAK STARTS HERE</span><h2>Ready for a<br />little break?</h2><p>Two biology questions, then you&apos;re on your way.<br className={styles.desktopBreak} /> Let&apos;s keep our classroom flowing.</p><button className="button primary" disabled={busy || state.availableQuestions < 2} onClick={() => void startQuiz()}>{busy ? <LoaderCircle size={18} className={styles.spin} /> : <BookOpen size={18} />}Request a bathroom pass<ArrowRight size={18} /></button>{state.availableQuestions < 2 && <p className={styles.unavailable}>Your teacher needs to add at least two active questions before you can request a pass.</p>}<div className={styles.heroFootnote}><ShieldCheck size={15} />Your time starts only when you tap &ldquo;I&apos;m leaving.&rdquo;</div></div><div className={styles.heroArt} aria-hidden="true"><div className={styles.orbitOne} /><div className={styles.orbitTwo} /><div className={styles.plant}><Sprout size={144} strokeWidth={1.2} /></div><span className={styles.artSpark}>✦</span><span className={styles.artLeaf}><Leaf size={25} /></span><span className={styles.artLabel}>ROOM TO GROW</span></div></section>}
                    <section className={`card ${styles.recentCard}`}><div className="card-header"><div><h2>Your recent activity</h2><p className="muted">A quick look at your last few breaks.</p></div><button className="button ghost small" onClick={() => setView("activity")}>View all<ArrowRight size={15} /></button></div><HistoryTable visits={history.slice(0, 3)} /></section>
                  </div>
                  <aside className={styles.rightColumn}>
                    <section className={`card ${styles.capacityCard}`}><div className="card-header"><h2>Classroom flow</h2><span className={styles.liveLabel}><span className={styles.liveDot} />LIVE</span></div><p className="muted">A maximum of {capacity} students at a time keeps things moving.</p><div className={styles.capacitySlots}>{Array.from({ length: capacity }, (_, index) => <div key={index} className={`${styles.capacitySlot} ${index < used ? styles.slotUsed : ""}`}><div><Footprints size={24} strokeWidth={1.6} /></div><strong>{index < used ? "In use" : "Available"}</strong><span>Space {index + 1}</span></div>)}</div><div className={styles.queueSummary}><Users size={17} /><span>{state.waitingCount === 0 ? "No one is waiting" : `${state.waitingCount} ${state.waitingCount === 1 ? "student" : "students"} in the queue`}</span></div><p className={styles.capacityNote}>Spaces include students getting ready to leave.</p></section>
                    <section className={styles.stepsCard}><span className="eyebrow">A GOOD FLOW, IN THREE STEPS</span><h2>Think. Go. Grow.</h2><ol><li><span>01</span><div><strong>Give your brain a moment</strong><p>Answer two random biology questions correctly.</p></div></li><li><span>02</span><div><strong>Wait for your green light</strong><p>Join the line if both spaces are taken. We&apos;ll signal your turn.</p></div></li><li><span>03</span><div><strong>Check out, then check in</strong><p>Tap when you leave and when you&apos;re back. That&apos;s it.</p></div></li></ol></section>
                  </aside>
                </div>
                <footer className={styles.footer}><span><Droplets size={15} />A little structure. A lot more learning.</span><span>Made for your classroom.</span></footer>
              </>}
      </div>
    </main>
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className={`modal ${styles.helpModal}`} role="dialog" aria-modal="true" aria-labelledby="help-heading" onClick={event => event.stopPropagation()}><div className="modal-header"><h2 id="help-heading">Your pass, step by step</h2><button className="button ghost small" onClick={() => setHelp(false)} aria-label="Close help"><X size={20} /></button></div><ol><li><strong>Answer two questions.</strong> Both need to be correct. If you miss one, read the explanation and try a fresh pair.</li><li><strong>Join the flow.</strong> Two spaces are available. If they&apos;re taken, you&apos;ll join the queue in order.</li><li><strong>Watch for your turn.</strong> Leave this page open. Enable alerts for sound and optional browser notifications; your browser may limit alerts while the page is closed or asleep.</li><li><strong>Tap &ldquo;I&apos;m leaving.&rdquo;</strong> Your departure time is recorded when you tap, even if a space was reserved earlier.</li><li><strong>Tap &ldquo;I&apos;m back.&rdquo;</strong> This records your return and gives the next student a turn.</li></ol><button className="button primary" onClick={() => setHelp(false)}>Got it<Check size={17} /></button></section></div>}
  </div>;
}

function HistoryTable({ visits }: { visits: Visit[] }) {
  if (visits.length === 0) return <div className="empty-state"><div className={styles.emptyIcon}><History size={25} /></div><h3>A fresh start.</h3><p className="muted">Your completed breaks will appear here.</p></div>;
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>Date</th><th>Left</th><th>Returned</th><th>Duration</th><th>Status</th></tr></thead><tbody>{visits.map(visit => <tr key={visit.id}><td>{new Date(visit.requestedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</td><td>{time(visit.leftAt)}</td><td>{time(visit.returnedAt)}</td><td>{duration(visit.leftAt, visit.returnedAt)}</td><td><span className={`badge ${visit.status === "returned" ? "green" : "gray"}`}>{visit.status === "returned" ? "Returned" : "Cancelled"}</span></td></tr>)}</tbody></table></div>;
}
