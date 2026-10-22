"use client";
import { useEffect, useRef } from 'react';
import { GraduationCap, X } from 'lucide-react';

export function TeacherAccountRequest({ onClose }: { onClose: () => void }) {
  const dialog=useRef<HTMLElement>(null);
  const close=useRef(onClose);
  useEffect(()=>{close.current=onClose;},[onClose]);
  useEffect(()=>{
    const element=dialog.current;
    if(!element)return;
    const previous=document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    element.focus({preventScroll:true});
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();close.current();}
      if(event.key!=='Tab')return;
      const controls=Array.from(element.querySelectorAll<HTMLElement>('button,a[href]'));
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===element)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===element)){event.preventDefault();first?.focus();}
    };
    const contain=(event:FocusEvent)=>{if(event.target instanceof Node&&!element.contains(event.target))element.focus({preventScroll:true});};
    document.addEventListener('keydown',key);document.addEventListener('focusin',contain);
    return()=>{document.removeEventListener('keydown',key);document.removeEventListener('focusin',contain);document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[]);
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section className="modal teacher-request-modal" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="teacher-registration-title" aria-describedby="teacher-registration-copy">
      <div className="modal-header"><div><GraduationCap size={29}/><h2 id="teacher-registration-title">Teacher Account Registration</h2></div><button className="button ghost small" aria-label="Close teacher registration" onClick={onClose}><X size={20}/></button></div>
      <p id="teacher-registration-copy">This app is still under small scale classroom testing phase, please contact David Zhang (<a href="mailto:bestbiologuy@gmail.com">bestbiologuy@gmail.com</a>) to request a teachers account set-up.</p>
      <div className="modal-actions"><button className="button primary" onClick={onClose}>Got It</button></div>
    </section>
  </div>;
}
