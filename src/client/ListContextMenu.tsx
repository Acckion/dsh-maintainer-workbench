import {useEffect,useLayoutEffect,useRef,useState,type KeyboardEvent,type MouseEvent} from 'react';

export type ListMenuAction={label:string;run:()=>void;disabled?:boolean;hint?:string};
/** Native-style list actions, including keyboard access without a permanent toolbar. */
export function useListContextMenu(scope:string) {
  const [menu,setMenu]=useState<{x:number;y:number;actions:ListMenuAction[];label:string}>();
  const popup=useRef<HTMLDivElement>(null),origin=useRef<HTMLElement|null>(null);
  const close=(restore=false)=>{setMenu(undefined);if(restore)origin.current?.focus({preventScroll:true});};
  useEffect(()=>{setMenu(undefined);},[scope]);
  useLayoutEffect(()=>{
    if(!menu||!popup.current)return;
    const node=popup.current;
    node.setAttribute('popover','manual');node.showPopover?.();
    const rect=node.getBoundingClientRect();
    node.style.left=`${Math.max(8,Math.min(menu.x,window.innerWidth-rect.width-8))}px`;
    node.style.top=`${Math.max(8,Math.min(menu.y,window.innerHeight-rect.height-8))}px`;
    node.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    const outside=(e:PointerEvent)=>{if(!node.contains(e.target as Node))close();};
    const dismiss=()=>close();
    document.addEventListener('pointerdown',outside);window.addEventListener('resize',dismiss);document.addEventListener('scroll',dismiss,true);
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',dismiss);document.removeEventListener('scroll',dismiss,true);};
  },[menu]);
  const show=(event:MouseEvent<HTMLElement>|KeyboardEvent<HTMLElement>,actions:ListMenuAction[],label='列表操作')=>{
    if((event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]'))return;
    if('key' in event&&event.key!=='ContextMenu'&&!(event.shiftKey&&event.key==='F10'))return;
    event.preventDefault();event.stopPropagation();
    const target=event.target instanceof HTMLElement?event.target:event.currentTarget;
    origin.current=target.closest<HTMLElement>('button')??(event.currentTarget.matches('[tabindex]')?event.currentTarget:event.currentTarget.querySelector<HTMLElement>('button'))??event.currentTarget;
    const rect=origin.current.getBoundingClientRect();
    const mouse='clientX' in event&&(event.clientX!==0||event.clientY!==0);
    setMenu({x:mouse?event.clientX:rect.left+16,y:mouse?event.clientY:rect.top+Math.min(rect.height,36),actions,label});
  };
  const content=menu&&<div ref={popup} role="menu" aria-label={menu.label} className="mw-list-context-menu" onContextMenu={e=>{e.preventDefault();e.stopPropagation();}} onKeyDown={event=>{
    const buttons=[...popup.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
    if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();event.stopPropagation();close(true);}
    const next=event.key==='ArrowDown'?(index+1)%buttons.length:event.key==='ArrowUp'?(index+buttons.length-1)%buttons.length:event.key==='Home'?0:event.key==='End'?buttons.length-1:undefined;
    if(next!==undefined){event.preventDefault();buttons[next]?.focus();}
  }}>{menu.actions.map((item,index)=><button type="button" role="menuitem" key={index} disabled={item.disabled} title={item.hint} onClick={()=>{close(true);item.run();}}>{item.label}</button>)}</div>;
  return {show,content};
}
