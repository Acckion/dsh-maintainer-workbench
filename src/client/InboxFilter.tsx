import React, {useEffect, useRef, useState} from 'react';
import {Check, Filter} from 'lucide-react';
const options = [['all','所有开放问题'],['untriaged','尚未分诊'],['priority','高优先级'],['duplicates','疑似重复'],['closed','已关闭']] as const;
export function InboxFilter({value,onChange}:{value:string;onChange:(value:string)=>void}) {
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null), trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!open)return;
    root.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  return <div ref={root} className="mw-inbox-filter" onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node))setOpen(false);}}>
    <button ref={trigger} className={`mw-icon-button mw-filter-toggle ${value!=='all'?'active':''}`} aria-label="展开筛选" aria-expanded={open} aria-haspopup="dialog" title={`筛选：${options.find(([key])=>key===value)?.[1]}`} onClick={()=>setOpen(v=>!v)}><Filter size={16}/></button>
    {open&&<div role="dialog" aria-label="筛选问题" className="mw-filter-popover">{options.map(([key,label])=><button key={key} aria-pressed={value===key} onClick={()=>{onChange(key);setOpen(false);trigger.current?.focus();}}><span>{label}</span>{value===key&&<Check size={15}/>}</button>)}</div>}
  </div>;
}
