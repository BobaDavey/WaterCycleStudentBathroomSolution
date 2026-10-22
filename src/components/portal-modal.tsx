'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function PortalModal({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}) {
 const id=useId(),ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null;
  const elements=()=>Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]')??[]);
  elements()[0]?.focus();const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose();if(event.key==='Tab'){const list=elements(),first=list[0],last=list.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}};
  document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);document.body.style.overflow=overflow;previous?.focus();};
 },[onClose]);
 return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={id}><div className="modal-header"><h2 id={id}>{title}</h2><button type="button" className="button ghost small" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></div>{children}</div></div>;
}
