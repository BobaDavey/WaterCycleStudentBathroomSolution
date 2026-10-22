'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Droplets, Leaf, LoaderCircle, LockKeyhole, ShieldCheck, Users } from 'lucide-react';
import { api, post } from '@/lib/client';
import type { AuthState, User } from '@/lib/contracts';
import styles from './admin-dashboard.module.css';

export function AdminLogin() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<AuthState | null>(null);
  const [checking, setChecking] = useState(true);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      const next = await api<AuthState>('/auth/me');
      setState(next);
      if (next.user?.role === 'admin') window.location.replace('/admin/dashboard');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to check administrator access.'); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void check(); }, [check]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const result = await post<{ user: User }>('/auth/login', { username: 'davidanzezhang', password, role: 'admin' });
      if (result.user.role !== 'admin') throw new Error('Administrator access is required.');
      setPassword(''); window.location.assign('/admin/dashboard');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign in was unsuccessful.'); }
    finally { setBusy(false); }
  }
  return <main className="auth-page">
    <section className="auth-story">
      <a href="/" className="auth-logo"><span className="brand-icon"><Droplets size={25} /></span>WaterCycle</a>
      <div className="auth-story-content">
        <span className="story-pill"><ShieldCheck size={13} /> ADMINISTRATOR PORTAL</span>
        <h1>A quick learning.<br />A wider <em>view.</em></h1>
        <p>A thoughtful home for your teachers, classes, and the little moments that keep every classroom flowing.</p>
        <div className={styles.adminStoryCard}><Users size={29} strokeWidth={1.3} /><div><strong>One administrator. Every classroom.</strong><p>Manage teacher access and oversee classroom records in one protected space.</p></div></div>
      </div>
      <div className="story-footer"><Leaf size={16} /> A calmer classroom starts with a little flow.</div>
    </section>
    <section className="auth-panel">
      <div className="auth-top-note"><LockKeyhole size={15} /> Protected administrator access</div>
      <div className="auth-form-wrap">
        <a href="/" className="auth-back"><ArrowLeft size={15} /> Student and teacher sign in</a>
        <span className="eyebrow">YOUR SCHOOL, CONNECTED</span>
        <h2>Welcome, administrator.</h2>
        <p className="auth-subtitle">Sign in to manage teacher access and oversee your classes.</p>
        {state?.adminProvisioned === false && <div className={`alert info ${styles.bootstrapNote}`} role="status"><ShieldCheck size={21} /><div><strong>Your administrator account needs provisioning.</strong><p>Set <code>ADMIN_INITIAL_PASSWORD</code> privately in your Codespaces secrets or local environment, then run <code>npm run admin:bootstrap</code>. Remove the initial password secret after provisioning. This page cannot create administrator accounts.</p><button type="button" className="button secondary small" disabled={checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Check again'}</button></div></div>}
        <form onSubmit={submit} className={`auth-form ${styles.adminLoginForm}`}>
          <label className="field">Administrator username<input className="input" aria-label="Administrator username" value="davidanzezhang" readOnly autoComplete="username" /></label>
          <label className="field">Password<input className="input" aria-label="Password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required maxLength={128} /></label>
          {error && <div role="alert" className="alert error">{error}</div>}
          <button type="submit" className="button primary auth-submit" disabled={busy || checking || state?.adminProvisioned === false}>{busy ? <><LoaderCircle className="spin" size={17} /> Signing in…</> : <>Sign in as administrator<ArrowRight size={18} /></>}</button>
        </form>
        <p className={styles.loginFootnote}><ShieldCheck size={15} /> One protected account. No public administrator registration.</p>
      </div>
      <footer className="auth-panel-footer"><span>WATERCYCLE · ADMINISTRATOR</span><span>A quick learning. A better flow. <Leaf size={13} /></span></footer>
    </section>
  </main>;
}
