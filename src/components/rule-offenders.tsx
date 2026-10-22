"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock3, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/client';
import type { Classroom, RuleOffendersState, RuleViolation } from '@/lib/contracts';
import styles from './rule-offenders.module.css';

function duration(row:RuleViolation,now:number) {
  const seconds=Math.max(0,Math.floor(row.ongoing?(now-Date.parse(row.leftAt))/1000:row.durationSeconds));
  return `${Math.floor(seconds/60)}m ${String(seconds%60).padStart(2,'0')}s`;
}
export function RuleOffenders({ classes }: { classes:Classroom[] }) {
  const [classId,setClassId]=useState('');
  const [search,setSearch]=useState('');
  const [query,setQuery]=useState('');
  const [pages,setPages]=useState(1);
  const [data,setData]=useState<RuleOffendersState|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [now,setNow]=useState(()=>Date.now());
  const offset=useRef(0);
  const sequence=useRef(0);
  const inFlight=useRef<number|null>(null);
  useEffect(()=>{const timer=setTimeout(()=>{setQuery(search.trim());setPages(1);},250);return()=>clearTimeout(timer);},[search]);
  const refresh=useCallback(async()=>{
    const id=++sequence.current;
    inFlight.current=id;
    try {
      let cursor:string|null=null;
      let response:RuleOffendersState|null=null;
      const rows:RuleViolation[]=[];
      for(let page=0;page<pages;page++) {
        const params=new URLSearchParams({limit:'50'});
        if(classId)params.set('classroomId',classId);
        if(query)params.set('search',query);
        if(cursor)params.set('cursor',cursor);
        response=await api<RuleOffendersState>(`/teacher/violations?${params}`);
        if(id!==sequence.current)return;
        rows.push(...response.violations);cursor=response.nextCursor;
        if(!cursor)break;
      }
      if(response&&id===sequence.current) {
        offset.current=Date.parse(response.serverNow)-Date.now();
        setNow(Date.now()+offset.current);
        setData({...response,violations:Array.from(new Map(rows.map(row=>[row.id,row])).values()),nextCursor:cursor});
        setError('');
      }
    }catch(cause){if(id===sequence.current)setError(cause instanceof Error?cause.message:'Could not load rule violations.');}
    finally{if(inFlight.current===id)inFlight.current=null;if(id===sequence.current)setBusy(false);}
  },[classId,query,pages]);
  useEffect(()=>{setBusy(true);void refresh();const timer=setInterval(()=>{if(inFlight.current===null)void refresh();},5000);return()=>{clearInterval(timer);sequence.current++;inFlight.current=null;};},[refresh]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()+offset.current),1000);return()=>clearInterval(timer);},[]);
  return <section className={`card ${styles.panel}`} aria-labelledby="rule-offenders-heading">
    <div className="card-header"><div><h2 id="rule-offenders-heading">Rule Offenders</h2><p>One record for each break longer than 12 minutes. Teacher decisions remain yours.</p></div><ShieldCheck size={22}/></div>
    <div className={styles.filters}>
      <label className="field">Search by student name<div className={styles.search}><Search size={16}/><input className="input" aria-label="Search rule offenders" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Find a student…" maxLength={100}/></div></label>
      <label className="field">Class / period<select className="select" aria-label="Filter rule offenders by class" value={classId} onChange={event=>{setClassId(event.target.value);setPages(1);setData(null);}}><option value="">All your classes</option>{classes.map(c=><option key={c.id} value={c.id}>{c.name}{c.period?` · Period ${c.period.replace(/^period\s*/i,'')}`:''}{c.archived?' · Archived':''}</option>)}</select></label>
    </div>
    {error&&<div className="alert error" role="alert">{error}<button className="button ghost small" onClick={()=>void refresh()}>Retry</button></div>}
    {!data&&busy?<p className={styles.loading} role="status"><RefreshCw size={18}/>Loading classroom activity…</p>:data?.violations.length?<>
      <div className={styles.scroll} role="region" aria-label="Rule Offenders records" tabIndex={0}>
        <table className="data-table"><thead><tr><th>Student Name</th><th>Class / Period</th><th>Date of Violation</th><th>Break Duration</th><th>Total Violations</th></tr></thead><tbody>{data.violations.map(row=><tr key={row.id} data-violation-id={row.id}>
          <td><strong>{row.studentName}</strong></td><td>{row.classroomName}{row.period&&<small>Period {row.period.replace(/^period\s*/i,'')}</small>}</td>
          <td><time dateTime={row.violatedAt}>{new Intl.DateTimeFormat(undefined,{timeZone:row.timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(row.violatedAt))}</time><small>{row.timeZone}</small></td>
          <td><span className={styles.duration}>{row.ongoing&&<Clock3 size={14}/>} {duration(row,now)}</span>{row.ongoing&&<small className={styles.ongoing}>Ongoing break</small>}</td><td><span className="badge red">{row.totalViolations}</span></td>
        </tr>)}</tbody></table>
      </div>
      {data.nextCursor&&<button className={`button secondary ${styles.more}`} disabled={busy} onClick={()=>{setBusy(true);setPages(value=>value+1);}}>{busy?'Loading…':'Load older violations'}</button>}
      <p className={styles.note}>Newest first · Dates use each class’s timezone · Includes archived classes and original class history.</p>
    </>:!error&&<div className="empty-state"><ShieldCheck size={29}/><h3>No rule violations recorded.</h3><p>{query||classId?'Try another class or student name.':'Breaks lasting more than 12 minutes will appear here automatically.'}</p></div>}
  </section>;
}
