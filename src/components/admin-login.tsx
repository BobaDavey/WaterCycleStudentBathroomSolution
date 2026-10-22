'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Droplets, Leaf, LoaderCircle, LockKeyhole, ShieldCheck, Users } from 'lucide-react';
import { api, post } from '@/lib/client';
import type { AuthState, User } from '@/lib/contracts';
import styles from './admin-dashboard.module.css';

export function AdminLogin() {
  const [username, setUsername] = useState('');
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to check developer access.'); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void check(); }, [check]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const result = await post<{ user: User }>('/auth/login', { username, password, role: 'admin' });
      if (result.user.role !== 'admin') throw new Error('Developer access is required.');
      setUsername(''); setPassword(''); window.location.assign('/admin/dashboard');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign in was unsuccessful.'); }
    finally { setBusy(false); }
  }
  return <main className="auth-page">
    <section className="auth-story">
      <a href="/" className="auth-logo"><span className="brand-icon"><Droplets size={25} /></span>WaterCycle</a>
      <div className="auth-story-content">
        <span className="story-pill"><ShieldCheck size={13} /> DEVELOPER PORTAL</span>
        <h1>A quick learning.<br />A wider <em>view.</em></h1>
        <p>A thoughtful home for your teachers, classes, and the little moments that keep every classroom flowing.</p>
        <div className={styles.adminStoryCard}><Users size={29} strokeWidth={1.3} /><div><strong>One developer. Every classroom.</strong><p>Manage teacher access and oversee classroom records in one protected space.</p></div></div>
      </div>
      <div className="story-footer"><Leaf size={16} /> A calmer classroom starts with a little flow.</div>
    </section>
    <section className="auth-panel">
      <div className="auth-top-note"><LockKeyhole size={15} /> Protected developer access</div>
      <div className="auth-form-wrap">
        <a href="/" className="auth-back"><ArrowLeft size={15} /> Student and teacher sign in</a>
        <span className="eyebrow">YOUR SCHOOL, CONNECTED</span>
        <h2>Welcome, developer.</h2>
        <p className="auth-subtitle">Sign in to manage teacher access and oversee your classes.</p>
        {state?.adminProvisioned === false && <div className={`alert info ${styles.bootstrapNote}`} role="status"><ShieldCheck size={21} /><div><strong>Your developer account needs provisioning.</strong><p>Set <code>ADMIN_INITIAL_PASSWORD</code> privately in your Codespaces secrets or local environment, then run <code>npm run admin:bootstrap</code>. Remove the initial password secret after provisioning. This page cannot create developer accounts.</p><button type="button" className="button secondary small" disabled={checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Check again'}</button></div></div>}
        <form onSubmit={submit} className={`auth-form ${styles.adminLoginForm}`}>
          <label className="field">Developer username<input className="input" aria-label="Developer username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={100} /></label>
          <label className="field">Password<input className="input" aria-label="Password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" required maxLength={128} /></label>
          {error && <div role="alert" className="alert error">{error}</div>}
          <button type="submit" className="button primary auth-submit" disabled={busy || checking || state?.adminProvisioned === false}>{busy ? <><LoaderCircle className="spin" size={17} /> Signing in…</> : <>Developer Sign In<ArrowRight size={18} /></>}</button>
        </form>
        <p className={styles.loginFootnote}><ShieldCheck size={15} /> One protected account. No public developer registration.</p>
      </div>
      <footer className="auth-panel-footer"><span>WATERCYCLE · DEVELOPER</span><span>A quick learning. A better flow. <Leaf size={13} /></span></footer>
    </section>
  </main>;
}
