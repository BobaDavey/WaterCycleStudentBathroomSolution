"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUpRight, BookOpen, Check, ChevronLeft, Droplets, GraduationCap, Leaf, LoaderCircle, LockKeyhole, ShieldCheck, Sprout, Users } from "lucide-react";
import { api, post } from "@/lib/client";
import type { AuthState, Role, User } from "@/lib/contracts";
import { TeacherDashboard } from "@/components/teacher-dashboard";
import { StudentDashboard } from "@/components/student-dashboard";

type Mode = "login" | "signup";
export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialError, setInitialError] = useState("");
  const [demo, setDemo] = useState(false);
  const [mode, setMode] = useState<Mode>("login");
  const [role, setRole] = useState<Role>("student");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [studentFirstName, setStudentFirstName] = useState("");
  const [studentLastName, setStudentLastName] = useState("");
  const [registrationUsername, setRegistrationUsername] = useState("");
  const [customUsername, setCustomUsername] = useState(false);
  async function loadSession() {
    setLoading(true); setInitialError("");
    try {
      const state = await api<AuthState>("/auth/me");
      setUser(state.user); setDemo(!!state.demo);
    } catch (err) { setInitialError((err as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadSession(); }, []);
  useEffect(() => { if (user?.role === "admin") router.replace("/admin/dashboard"); }, [router, user]);
  useEffect(() => {
    const expired = () => { setUser(null); setPassword(""); setError("Your session ended. Please sign in again."); setMode("login"); };
    window.addEventListener("watercycle:session-expired", expired);
    return () => window.removeEventListener("watercycle:session-expired", expired);
  }, []);
  async function logout() {
    try { await post("/auth/logout"); setUser(null); setPassword(""); setUsername(""); setMode("login"); }
    catch (err) { window.alert((err as Error).message); }
  }
  function changeMode(next: Mode) {
    setMode(next); setError(""); setPassword("");
    if (next === "signup") { setStudentFirstName(""); setStudentLastName(""); setRegistrationUsername(""); setCustomUsername(false); }
  }
  function updateStudentName(first: string, last: string) {
    setStudentFirstName(first); setStudentLastName(last);
    if (!customUsername) setRegistrationUsername(`${first}${last}`.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, ""));
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      let result: { user: User };
      if (mode === "login") result = await post("/auth/login", { username, password, role });
      else if (mode === "signup") result = await post("/auth/signup", {
        firstName: form.get("firstName"), lastName: form.get("lastName"), password,
        username: registrationUsername, classroomCode: form.get("classroomCode"),
      });
      else throw new Error("Please choose a sign-in option.");
      setUser(result.user); setPassword("");
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  if (loading) return <main className="loading-page"><Droplets size={40} /><span>Finding your flow…</span><LoaderCircle className="spin" size={20} /></main>;
  if (initialError) return <main className="loading-page"><Droplets size={40} /><h1>Let’s reconnect.</h1><p role="alert">{initialError}</p><button className="button primary" onClick={() => void loadSession()}>Try again</button></main>;
  if (user?.role === "admin") return <main className="loading-page"><Droplets size={40} /><span>Opening the Administrator Portal…</span></main>;
  if (user) return user.role === "teacher" ? <TeacherDashboard user={user} onLogout={() => void logout()} /> : <StudentDashboard user={user} onLogout={() => void logout()} />;
  return <main className="auth-page">
    <section className="auth-story">
      <a className="auth-logo" href="/" aria-label="WaterCycle home"><span className="brand-icon"><Droplets size={25} /></span>WaterCycle<span className="brand-dot">®</span></a>
      <div className="auth-story-content">
        <span className="story-pill"><span className="pulse-dot" /> BUILT FOR YOUR CLASSROOM</span>
        <h1>A quick learning.<br />A better <em>flow.</em></h1>
        <p>Make room for curiosity. A thoughtful way to manage bathroom breaks, one biology question at a time.</p>
        <div className="flow-illustration" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="leaf-drawing"><Sprout size={107} strokeWidth={1.1} /></div>
          <div className="float-card float-one"><span className="mini-icon"><BookOpen size={18} /></span><div><strong>Learn a little</strong><span>2 questions before you go</span></div><span className="float-check"><Check size={15} /></span></div>
          <div className="float-card float-two"><span className="mini-icon peach"><Users size={18} /></span><div><strong>A fair turn, every time</strong><span>Two passes. One simple queue.</span></div></div>
          <span className="illustration-caption">SMALL MOMENTS. GROWING MINDS.</span>
        </div>
      </div>
      <div className="story-footer"><Leaf size={16} /><span>A calmer classroom starts with a little flow.</span></div>
    </section>
    <section className="auth-panel">
      <div className="auth-top-note"><ShieldCheck size={15} /> Your classroom, connected.</div>
      <div className="auth-form-wrap">
        {mode !== "login" && <button className="auth-back" onClick={() => changeMode("login")}><ChevronLeft size={15} /> Back to sign in</button>}
        <span className="eyebrow">{mode === "signup" ? "LET’S GET YOU SET UP" : "WELCOME TO WATERCYCLE"}</span>
        <h2>{mode === "signup" ? "Hello, new explorer." : "Good to see you."}</h2>
        <p className="auth-subtitle">{mode === "signup" ? "Join your class and make yourself at home." : "Sign in and pick up where you left off."}</p>
        {mode === "login" && <div className="role-tabs" aria-label="Account type"><button className={role === "student" ? "selected" : ""} onClick={() => { setRole("student"); setError(""); }}><Sprout size={17} /> I’m a student</button><button className={role === "teacher" ? "selected" : ""} onClick={() => { setRole("teacher"); setError(""); }}><GraduationCap size={18} /> I’m a teacher</button></div>}
        <form onSubmit={submit} className="auth-form">
          {mode !== "login" && <div className="form-grid"><label className="field">First name<input className="input" name="firstName" aria-label="First name" autoComplete="given-name" required maxLength={50} placeholder="Jamie" value={studentFirstName} onChange={e => updateStudentName(e.target.value, studentLastName)} /></label><label className="field">Last name<input className="input" name="lastName" aria-label="Last name" autoComplete="family-name" required maxLength={50} placeholder="Chen" value={studentLastName} onChange={e => updateStudentName(studentFirstName, e.target.value)} /></label></div>}
          {mode !== "signup" && <label className="field">Username<input className="input" aria-label="Username" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required maxLength={100} placeholder={role === "student" ? "e.g. jamiechen" : "Your teacher username"} spellCheck={false} autoCapitalize="none" />{role === "student" && mode === "login" && <span className="field-hint">Your first + last name, with no spaces.</span>}</label>}
          {mode === "signup" && <><label className="field">Username<input className="input" aria-label="Username" autoComplete="username" value={registrationUsername} onChange={e => { setCustomUsername(true); setRegistrationUsername(e.target.value.toLowerCase()); }} required minLength={2} maxLength={100} pattern="[a-z0-9]+" spellCheck={false} autoCapitalize="none" /><span className="field-hint">Your first + last name is suggested. Use letters and numbers.</span></label><label className="field">Classroom code<input className="input code-input" name="classroomCode" aria-label="Classroom code" autoComplete="off" required minLength={5} maxLength={5} pattern="[0-9]{5}" inputMode="numeric" placeholder="Five digits from your teacher" /><span className="field-hint">Your code enrolls you in the correct teacher’s class automatically.</span></label></>}
          <label className="field">Password<input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "login" ? 1 : 8} maxLength={128} placeholder={mode === "login" ? "Enter your password" : "At least 8 characters"} /></label>
          {mode === "login" && <p className="password-help"><LockKeyhole size={13} /> {role === "student" ? "Forgot your password? Ask your teacher to reset it." : "Use the password you chose for your teacher account."}</p>}
          {error && <div className="alert error" role="alert">{error}</div>}
          <button className="button primary auth-submit" disabled={busy} type="submit">{busy ? <><LoaderCircle size={17} className="spin" /> One moment…</> : <>{mode === "login" ? "Sign in" : "Create my account"}<ArrowRight size={18} /></>}</button>
        </form>
        {mode === "login" && <><p className="auth-signup">New here? <button onClick={() => { setRole("student"); changeMode("signup"); }}>Create a student account <ArrowUpRight size={14} /></button></p>{role === "teacher" && <p className="auth-signup">Teacher accounts are created by your administrator.</p>}<a className="setup-link" href="/admin/login">Administrator sign in</a></>}
        {demo && mode === "login" && <div className="demo-box"><span>TAKE A LOOK AROUND</span><p>This local demo has sample accounts ready to explore.</p><div><button onClick={() => { setRole("teacher"); setUsername("morganreed"); setPassword("WaterCycle2026!"); setError(""); }}>Fill teacher demo <ArrowUpRight size={13} /></button><button onClick={() => { setRole("student"); setUsername("jamiechen"); setPassword("Biology2026!"); setError(""); }}>Fill student demo <ArrowUpRight size={13} /></button></div></div>}
      </div>
      <footer className="auth-panel-footer"><span>LEARN. TAKE A BREAK. COME BACK.</span><span>Made for real classrooms <Leaf size={13} /></span></footer>
    </section>
  </main>;
}
