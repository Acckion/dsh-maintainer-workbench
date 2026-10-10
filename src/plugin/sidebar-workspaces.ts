import type {SidebarRun} from '../domain/sidebar-workspaces.ts';
import type {HostWorkspace} from '../client/host-workspaces.ts';

const statusLabels:Record<SidebarRun['status'],string>={queued:'待执行',running:'执行中',completed:'已完成',awaiting_review:'待审核',approved:'已接受',rejected:'已退回',failed:'失败',cancelled:'已停止',waiting_input:'待补充信息',waiting_environment:'等待环境'};
const pathKey=(path:string)=>path.replace(/^\/private\/var\//,'/var/').replace(/\/$/,'');

export function sidebarWorkspaceGroups(workspaces:readonly HostWorkspace[],runs:SidebarRun[]) {
  const ordered=[...runs].sort((a,b)=>a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const ordinal=new Map<string,number>(),counts=new Map<string,number>();
  for(const run of ordered) {const n=(counts.get(run.group) ?? 0)+1;counts.set(run.group,n);ordinal.set(run.id,n);}
  const groups=new Map<string,{title:string;members:{workspace:HostWorkspace;run:SidebarRun;attempt:number;attempts:{run:SidebarRun;attempt:number}[]}[]}>();
  for(const workspace of workspaces) {
    const matches=ordered.filter(run=>run.path && pathKey(run.path)===pathKey(workspace.path));
    if(!matches.length || new Set(matches.map(run=>run.group)).size!==1 || (matches.length>1 && (matches.some(run=>!run.sessionId) || new Set(matches.map(run=>run.sessionId)).size!==matches.length))) continue; // Only same-stage recovery sessions may share a saved path.
    const run=matches.at(-1)!;let group=groups.get(run.group);
    if(!group) {group={title:run.title,members:[]};groups.set(run.group,group);}
    group.members.push({workspace,run,attempt:ordinal.get(run.id)!,attempts:matches.map(run=>({run,attempt:ordinal.get(run.id)!}))});
  }
  return [...groups.entries()].map(([key,group])=>({key,...group}));
}

/** Decorate the shipped grouped sidebar. Never move React nodes or alter Host accounts. */
export function installSidebarWorkspaceGroups(source:{getSnapshot:()=>{items:readonly HostWorkspace[]};subscribe:(fn:()=>void)=>()=>void},root:Document=document,load:()=>Promise<SidebarRun[]>=async()=>{
  const response=await fetch('/maintainer/api/workspaces/sidebar');
  if(!response.ok) throw Error('阶段工作区信息暂不可用');
  return response.json();
}) {
  let runs:SidebarRun[]=[],disposed=false,loading=false,scheduled=false;
  const undo=new Map<HTMLElement,Map<string,string|null>>();
  const set=(element:HTMLElement,name:string,value:string)=>{
    let attrs=undo.get(element);if(!attrs){attrs=new Map();undo.set(element,attrs);}
    if(!attrs.has(name)) attrs.set(name,element.getAttribute(name));
    if(element.getAttribute(name)!==value) element.setAttribute(name,value);
  };
  const restore=()=>{for(const [element,attrs] of undo)for(const [name,value] of attrs)value===null?element.removeAttribute(name):element.setAttribute(name,value);undo.clear();};
  const refresh=()=>{
    scheduled=false;if(disposed)return;
    restore();
    // Flat/session-search views have no workspace headers and are left untouched.
    const headers=[...root.querySelectorAll<HTMLElement>('[data-row-key^="workspace:"][role="treeitem"]')];
    const prepared=new Set<HTMLElement>();
    const byId=new Map(headers.map(header=>[header.dataset.rowKey!.slice('workspace:'.length),header]));
    for(const group of sidebarWorkspaceGroups(source.getSnapshot().items,runs)) {
      const visible=group.members.map(member=>({...member,header:byId.get(member.workspace.workspaceId)})).filter((m):m is typeof m & {header:HTMLElement}=>!!m.header);
      if(!visible.length)continue;
      const sectionOf=(header:HTMLElement)=>header.closest<HTMLElement>('[class*="groupSection"]');
      const parent=sectionOf(visible[0].header)?.parentElement;
      // Only the shipped direct group structure is decorated; unfamiliar layouts fall back.
      if(!parent || visible.some(m=>sectionOf(m.header)?.parentElement!==parent || sectionOf(m.header)?.querySelector(':scope > [role="group"]') || !m.header.querySelector('[class*="projectText"]')))continue;
      const children=[...parent.children];
      const anchor=Math.min(...visible.map(m=>children.indexOf(sectionOf(m.header)!)));
      visible.sort((a,b)=>children.indexOf(sectionOf(a.header)!)-children.indexOf(sectionOf(b.header)!));
      const leader=visible[0].header,expanded=leader.getAttribute('aria-expanded');
      if(!prepared.has(parent)) {
        prepared.add(parent);set(parent,'data-mw-stage-list','');
        for(const [index,child] of children.entries()) if(child instanceof HTMLElement) set(child,'style',`${child.getAttribute('style') ?? ''};order:${index};`);
      }
      set(leader,'data-mw-stage-selected',String(visible.some(m=>sectionOf(m.header)?.querySelector('[aria-selected="true"]'))));
      for(const member of visible) {
        const header=member.header,section=sectionOf(header)!;
        const title=header.querySelector<HTMLElement>('[class*="projectText"]');
        if(!title)continue;
        set(section,'data-mw-stage-section','');set(section,'data-mw-stage-order',String(anchor));
        set(section,'style',`${section.getAttribute('style') ?? ''};order:${anchor};`);
        set(header,'data-mw-stage-header',header===leader?'leader':'member');
        if(header.parentElement!==section) set(header.parentElement!,'data-mw-stage-header-wrapper',header===leader?'leader':'member');
        if(header===leader) {set(title,'data-mw-stage-title',group.title);set(header,'aria-label',group.title);set(header,'title',`${group.title}；各次尝试保留独立目录。目录处置请使用工作台的检查与预览。`);set(header,'tabindex','0');}
        if(header!==leader && expanded!==null && header.getAttribute('aria-expanded')!==expanded) header.click();
        for(const {run,attempt} of member.attempts) if(run.sessionId) {
          const session=[...section.querySelectorAll<HTMLElement>('[data-row-key^="session:"]')].find(row=>row.dataset.rowKey===`session:${run.sessionId}`);
          const text=session?.querySelector<HTMLElement>(':scope > [class$="_title"]');
          if(session && text) {const label=`第 ${attempt} 次 · ${statusLabels[run.status]}`;set(text,'data-mw-attempt-title',label);set(session,'aria-label',`${group.title} · ${label}`);set(session,'title',`${label}；${run.createdAt}`);}
        }
      }
    }
  };
  const schedule=()=>{if(!scheduled && !disposed){scheduled=true;queueMicrotask(refresh);}};
  const reload=async()=>{if(loading || disposed)return;loading=true;try{const value=await load();if(!Array.isArray(value))throw Error("Invalid sidebar metadata");if(!disposed){runs=value;schedule();}}catch{/* Preserve native UI if the metadata endpoint is unavailable. */}finally{loading=false;}};
  const observer=new MutationObserver(schedule);observer.observe(root.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-expanded','aria-selected','data-row-key']});
  const unsubscribe=source.subscribe(()=>{schedule();void reload();});
  const interval=setInterval(()=>void reload(),5000);
  const blockGroupDrag=(event:Event)=>{const target=event.target as HTMLElement;if(target.closest?.('[data-mw-stage-header]')){event.preventDefault();event.stopPropagation();}};
  const keyboard=(event:KeyboardEvent)=>{const target=event.target as HTMLElement;if(target.dataset.mwStageHeader==='leader' && event.target===target && ['Enter',' '].includes(event.key)){event.preventDefault();target.click();}};
  root.addEventListener('dragstart',blockGroupDrag,true);root.addEventListener('keydown',keyboard,true);
  schedule();void reload();
  return()=>{disposed=true;clearInterval(interval);observer.disconnect();unsubscribe();root.removeEventListener('dragstart',blockGroupDrag,true);root.removeEventListener('keydown',keyboard,true);restore();};
}
