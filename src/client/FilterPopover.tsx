import {useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {Filter, X} from 'lucide-react';

/** Shared list filter controls; use the top layer so scrolling sidebars cannot clip the panel. */
export function FilterPopover({count,title,label,heading,children}:{count:number;title:string;label:string;heading:string;children:ReactNode}) {
  const [open,setOpen]=useState(false);
  const id=useId(),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),popup=useRef<HTMLDivElement>(null);
  const close=()=>{setOpen(false);trigger.current?.focus();};
  useLayoutEffect(()=>{
    const element=popup.current;
    if(!open||!element)return;
    const place=()=>{
      const rect=trigger.current!.getBoundingClientRect();
      const width=Math.min(310,window.innerWidth-32);
      element.style.left=`${Math.max(16,Math.min(rect.right-width,window.innerWidth-width-16))}px`;
      element.style.top=`${rect.bottom+6}px`;
      element.style.maxHeight=`${Math.max(150,Math.min(window.innerHeight*.7,window.innerHeight-rect.bottom-22))}px`;
    };
    place();element.setAttribute('popover','manual');element.showPopover?.();
    window.addEventListener('resize',place);
    document.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);document.removeEventListener('scroll',place,true);};
  },[open]);
  useEffect(()=>{
    if(!open)return;
    (popup.current?.querySelector<HTMLElement>('select,input')??popup.current?.querySelector<HTMLElement>('button'))?.focus();
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  return <div ref={root} className="mw-inbox-filter">
    <button type="button" ref={trigger} className={`mw-icon-button mw-filter-toggle ${count?'active':''}`} aria-label="展开筛选" aria-expanded={open} aria-haspopup="dialog" aria-controls={open?id:undefined} title={title} onClick={()=>setOpen(v=>!v)}><Filter size={16}/>{count>0&&<span className="mw-filter-count">{count}</span>}</button>
    {open&&<div id={id} ref={popup} role="dialog" aria-label={label} className="mw-filter-popover mw-facet-popover"><header><strong>{heading}</strong><button type="button" className="mw-icon-button" aria-label="关闭筛选" onClick={close}><X size={15}/></button></header>{children}</div>}
  </div>;
}
