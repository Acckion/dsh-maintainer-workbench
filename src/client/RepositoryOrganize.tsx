import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, FileSearch, GitBranch, Search, Workflow } from 'lucide-react';
import type { Snapshot } from '../core/types.ts';
import type { MaintenanceSnapshot, MaintenanceDomain, MaintenanceFinding } from '../domain/maintenance.ts';
import { request } from './api.ts';
import { RepositoryPlanEditor } from './RepositoryPlanEditor.tsx';
import { RepositoryJobResult } from './RepositoryJobResult.tsx';
import { RepositoryMarkdown } from './RepositoryDetail.tsx';
import {taskStatus} from './review-evidence.ts';
import {scopedScans,scanIsCurrent,checkStatus,maintenanceJobMatches,documentRole,inventoryIsOutdated,isInventoryReadFailure} from './repository-maintenance-view.ts';
import { Empty, Tag } from './Primitives.tsx';
import {FilterPopover} from './FilterPopover.tsx';
import {RepositoryInventoryNotice} from './RepositoryInventoryNotice.tsx';
const domains={overview:'概览',docs:'文档',agents:'Agent 指引',ci:'CI'};
const decisionNames={open:'待处理',deferred:'已暂缓',ignored:'已忽略',resolved:'已解决'};
const kindNames={contradiction:'事实不一致',missing:'必要内容缺失',suggestion:'可选改进',uncertain:'证据不足'};
const empty:MaintenanceSnapshot={findings:[],scans:[]};
type View={domain:keyof typeof domains;selection:string;tab:'problems'|'content'|'history';prId:string;jobId?:string};
export function RepositoryOrganize(props:{onPRRequestHandled?:()=>void;requestedPR?:{id:string;sequence:number};state:Snapshot;repoId:string;busy:boolean;run:(data:unknown)=>Promise<string|undefined>;open:(id:string)=>void;act:(path:string,data:unknown,message:string)=>Promise<unknown>}) {
  const {state,repoId,busy,open,act}=props;
  const scopeId=useId();
  const [data,setData]=useState<MaintenanceSnapshot>(empty),[view,setView]=useState<View>({domain:'overview',selection:'',tab:'problems',prId:''});
  const [query,setQuery]=useState(''),[status,setStatus]=useState('active'),[detail,setDetail]=useState(false),[editing,setEditing]=useState(false),[selectedFindings,setSelectedFindings]=useState<string[]>([]),[resultJob,setResultJob]=useState('');
  const [auditInstructions,setAuditInstructions]=useState(''),[auditPaths,setAuditPaths]=useState('');
  const [scopeNotice,setScopeNotice]=useState('');
  const [error,setError]=useState(''),[loading,setLoading]=useState(false),[working,setWorking]=useState(false),[reason,setReason]=useState('');
  const [contentReload,setContentReload]=useState(0);
  const [inventoryError,setInventoryError]=useState(''),[inventoryRefreshing,setInventoryRefreshing]=useState(false);
  const [content,setContent]=useState<{path:string;content:string;revision:string;truncated:boolean;source?:string}>(),[contentError,setContentError]=useState('');
  const reader=useRef<HTMLDivElement>(null);
  useEffect(()=>{reader.current?.scrollTo({top:0});},[repoId,view.selection,view.tab,view.domain,editing]);
  const contextRef=useRef('');contextRef.current=JSON.stringify([view.domain,view.selection,view.prId]);
  const generation=useRef(0),snapshotRequest=useRef(0),actionLock=useRef<number>();
  const repoRef=useRef(repoId);repoRef.current=repoId;
  const repo=state.repos.find(r=>r.id===repoId);
  const update=(patch:Partial<View>)=>setView(old=>{const next={...old,...patch};try{localStorage.setItem(`maintainer.maintenance.view:${repoId}`,JSON.stringify(next));}catch{}return next;});
  const refresh=async(inventory=false)=>{
    if(repoRef.current!==repoId)return;const gen=generation.current;
    const live=()=>generation.current===gen&&repoRef.current===repoId;
    if(inventory){
      setInventoryRefreshing(true);
      try{await request('/repository/inventory',{repoId});if(live())setInventoryError('');}
      catch(e){if(live())setInventoryError((e as Error).message);}
      finally{if(live())setInventoryRefreshing(false);}
    }
    if(!live())return;
    const sequence=++snapshotRequest.current;const next=await request('/repository/maintenance?repoId='+encodeURIComponent(repoId));if(live()&&sequence===snapshotRequest.current)setData(next);
  };
  useEffect(()=>{const gen=++generation.current;setData(empty);setError('');setInventoryError('');setInventoryRefreshing(false);setScopeNotice('');setContent(undefined);setEditing(false);setSelectedFindings([]);setResultJob('');setDetail(false);setQuery('');setStatus('active');setAuditPaths('');setAuditInstructions('');setWorking(false);
    try{const saved=JSON.parse(localStorage.getItem(`maintainer.maintenance.view:${repoId}`)??'null');setView(saved&&saved.domain in domains?{domain:saved.domain,selection:String(saved.selection??''),tab:['problems','content','history'].includes(saved.tab)?saved.tab:'problems',prId:String(saved.prId??''),jobId:typeof saved.jobId==='string'?saved.jobId:undefined}:{domain:'overview',selection:'',tab:'problems',prId:''});}catch{setView({domain:'overview',selection:'',tab:'problems',prId:''});}
    setLoading(true);void (async()=>{try{const sequence=++snapshotRequest.current;const saved=await request('/repository/maintenance?repoId='+encodeURIComponent(repoId));if(gen!==generation.current)return;if(sequence===snapshotRequest.current)setData(saved);if(gen===generation.current)await refresh(true);}catch(e){if(gen===generation.current)setError((e as Error).message);}finally{if(gen===generation.current)setLoading(false);}})();
    return()=>{generation.current++;};
  },[repoId]);
  useEffect(()=>{if(props.requestedPR&&state.issues.some(i=>i.id===props.requestedPR!.id&&i.repoId===repoId)){update({domain:'docs',selection:'',tab:'problems',prId:props.requestedPR.id});setSelectedFindings([]);setDetail(true);props.onPRRequestHandled?.();}},[props.requestedPR?.sequence]);
  const prs=state.issues.filter(i=>i.repoId===repoId&&i.type==='pr'&&i.state==='open'&&!i.origin);
  const selectedPR=prs.find(i=>i.id===view.prId);
  const jobStamp=state.jobs.filter(j=>j.repoId===repoId).map(j=>j.id+j.status+j.updatedAt).join('|');
  useEffect(()=>{const gen=generation.current;void refresh().catch(e=>{if(gen===generation.current)setError((e as Error).message);});},[jobStamp]);
  const inventoryOutdated=inventoryIsOutdated(data.inventory,repo?.headSha);
  const inventoryUnavailable=!!inventoryError||inventoryOutdated;
  const assets=data.inventory?.assets.filter(a=>view.domain==='overview'||a.domain===view.domain)??[];
  const filtered=assets.filter(a=>`${a.path} ${a.role}`.toLowerCase().includes(query.toLowerCase()));
  const selectedAsset=assets.find(a=>a.path===view.selection);
  const relevant=data.findings.filter(f=>f.pr?.issueId===(view.prId||undefined)&&(view.domain==='overview'||f.domain===view.domain)&&(!view.selection||f.paths.includes(view.selection)));
  const findings=relevant.filter(f=>(status==='all'||status==='active'&&(f.decision==='open'||f.stale&&f.decision!=='resolved')||f.decision===status));
  const scans=scopedScans(data,view),latest=scans[0],latestJob=state.jobs.find(j=>j.id===latest?.jobId);
  const current=!!latest&&(!!latest.pr||!inventoryOutdated)&&scanIsCurrent(latest,data,selectedPR);
  const openPending=current&&latest?.state==='pending'&&!auditPaths.trim()&&!auditInstructions.trim();
  const targetPaths=assets.filter(a=>!view.selection||a.path===view.selection).map(a=>a.path);
  const check=checkStatus(latest,latestJob,current,targetPaths);
  const jobs=state.jobs.filter(j=>j.repoId===repoId&&maintenanceJobMatches(j,data,view)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const displayedJob=jobs.find(j=>j.id===(resultJob||view.jobId))??jobs[0];
  const displayedScan=data.scans.find(s=>s.jobId===displayedJob?.id);
  const activeJobs=jobs.filter(j=>['running','queued'].includes(j.status));
  useEffect(()=>{setContent(undefined);setContentError('');if(!selectedAsset||view.tab!=='content')return;let live=true;void request(`/repository/asset?repoId=${encodeURIComponent(repoId)}&path=${encodeURIComponent(selectedAsset.path)}`).then(v=>{if(live)setContent(v);}).catch(e=>{if(live)setContentError(e.message);});return()=>{live=false;};},[repoId,selectedAsset?.path,selectedAsset?.oid,data.inventory?.revision,view.tab,contentReload]);
  const perform=async(fn:()=>Promise<void>)=>{if(actionLock.current===generation.current)return;actionLock.current=generation.current;setWorking(true);setError('');const gen=generation.current,context=contextRef.current;try{await fn();if(gen===generation.current)await refresh();}catch(e){if(gen===generation.current&&contextRef.current===context){const message=(e as Error).message;if(isInventoryReadFailure(message))setInventoryError(message);else setError(message);}}finally{if(actionLock.current===gen)actionLock.current=undefined;if(gen===generation.current)setWorking(false);}};
  const scan=(force=false)=>perform(async()=>{const gen=generation.current,context=contextRef.current;if(inventoryUnavailable)throw Error('请先重新读取文件清单，再检查当前版本');if(view.prId&&!selectedPR)throw Error('所选 PR 已关闭或不可用，请重新选择');if(!auditPaths.trim()&&!view.selection&&view.domain!=='overview'&&assets.length>100)throw Error('当前分类超过 100 个文件，请在检查范围中填写目录路径，或选择具体文件');const result=await request('/repository/audit',{repoId,scope:auditPaths.trim()?auditPaths.split('\n').map(p=>p.trim().replace(/\/$/,'')).filter(Boolean):view.selection?[view.selection]:view.domain==='overview'?[]:assets.map(a=>a.path),instructions:auditInstructions,force:force||!!latest&&['failed','partial','cancelled'].includes(latest.state),prId:view.prId||undefined});if(gen!==generation.current)return;await refresh();if(contextRef.current!==context)return;const id=result.created?.[0]??result.reused?.[0];if(id){setResultJob(id);update({tab:'history',jobId:id});}setDetail(true);});
  const decide=(f:MaintenanceFinding,decision:'open'|'deferred'|'ignored')=>perform(async()=>{await act('/repository/decision',{repoId,id:f.id,decision,reason,fingerprint:f.fingerprint},'处理决定已保存');setReason('');});
  const mode:MaintenanceDomain=view.prId?'docs':view.domain==='overview'?'docs':view.domain;
  const selected=relevant.filter(f=>selectedFindings.includes(f.id));
  const document=documentRole(data,view.selection);
  const planPaths=view.selection?[view.selection]:selected.length?[...new Set(selected.flatMap(f=>f.paths))]:assets.filter(a=>a.domain===mode).map(a=>a.path);
  const selectDomain=(domain:View['domain'])=>{const leavePR=!!view.prId&&domain!=='docs';update({domain,prId:leavePR?'':view.prId,selection:'',tab:'problems',jobId:undefined});setScopeNotice(leavePR?'已切换到当前仓库；PR 来源目前用于文档影响检查与同步。':'');setAuditPaths('');setAuditInstructions('');setSelectedFindings([]);setResultJob('');setEditing(false);setDetail(true);};
  const selectSource=(prId:string)=>{update({prId,domain:prId?'docs':view.domain,selection:'',tab:'problems',jobId:undefined});setScopeNotice('');setAuditPaths('');setAuditInstructions('');setResultJob('');setEditing(false);setSelectedFindings([]);};
  const sourceName=view.prId?`PR #${selectedPR?.number??'不可用'}`:'当前仓库';
  return <div className={`mw-organize-workspace mw-repository-browser ${detail?'detail-open':''}`}>
    <aside className="mw-organize-sidebar mw-list-panel" aria-label="仓库文件与问题">
    <div className="mw-repository-scopes" role="tablist" aria-label="查看范围">
      {Object.entries(domains).map(([key,name])=><button key={key} type="button" role="tab" id={`${scopeId}-${key}`} aria-controls={`${scopeId}-panel`} aria-selected={view.domain===key} tabIndex={view.domain===key?0:-1} onClick={()=>selectDomain(key as View['domain'])} onKeyDown={e=>{
        const keys=Object.keys(domains) as View['domain'][];
        const index=keys.indexOf(key as View['domain']);
        const next=e.key==='ArrowRight'?keys[(index+1)%keys.length]:e.key==='ArrowLeft'?keys[(index+keys.length-1)%keys.length]:e.key==='Home'?keys[0]:e.key==='End'?keys[keys.length-1]:undefined;
        if(next){e.preventDefault();selectDomain(next);e.currentTarget.ownerDocument.getElementById(`${scopeId}-${next}`)?.focus();}
      }}>{name}</button>)}
    </div>
      <div className="mw-toolbar">
        <label className="mw-search"><Search size={16}/><input aria-label="搜索仓库文件与问题" placeholder="搜索文件或问题…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
        <FilterPopover key={repoId+view.domain} count={Number(!!view.prId)} title={view.prId?`来源：${sourceName}`:'筛选检查来源'} label="筛选仓库文件与问题" heading="筛选来源">
          <label>检查来源<select aria-label="仓库检查来源" value={view.prId} onChange={e=>selectSource(e.target.value)}><option value="">当前仓库</option>{view.prId&&!selectedPR&&<option value={view.prId}>已关闭或不可用的 PR</option>}{prs.map(pr=><option key={pr.id} value={pr.id}>PR #{pr.number} · {pr.title}</option>)}</select></label>
          <p className="mw-filter-hint">PR 来源用于文档影响检查；文件预览显示当前仓库版本。</p>
          <footer><button className="mw-text-button" onClick={()=>selectSource('')}>清除来源筛选</button></footer>
        </FilterPopover>
      </div>
      <div className="mw-filter-summary mw-repository-filter-summary" aria-live="polite"><span>{view.tab==='history'?`${jobs.length} 条记录`:`${filtered.length} 个文件`} · <span title={selectedPR?.title}>{sourceName}</span>{inventoryUnavailable&&' · 缓存'}</span>{(query||view.prId)&&<button className="mw-text-button" onClick={()=>{setQuery('');if(view.prId)selectSource('');}}>重置</button>}</div>
      <button className={`mw-task-row ${!view.selection?'focused':''}`} onClick={()=>{update({selection:'',tab:'problems'});setDetail(true);}}><span className="mw-task-icon"><FileSearch size={16}/></span><div><strong>{domains[view.domain]}</strong><p>{relevant.some(f=>f.decision==='open'||f.stale&&f.decision!=='resolved')?`${relevant.filter(f=>f.decision==='open'||f.stale&&f.decision!=='resolved').length} 个待处理问题`:'查看检查结果'}</p></div></button>
      <nav aria-label="仓库文件" hidden={view.tab==='history'}>{filtered.slice(0,300).map(a=>{const Icon=a.domain==='ci'?Workflow:a.domain==='agents'?GitBranch:BookOpen;return <button className={`mw-task-row ${view.selection===a.path?'focused':''}`} key={a.path} onClick={()=>{update({selection:a.path,tab:'content',jobId:undefined});setEditing(false);setSelectedFindings([]);setAuditPaths('');setAuditInstructions('');setResultJob('');setDetail(true);}}><span className="mw-task-icon"><Icon size={15}/></span><div><strong>{a.path}</strong><p>{documentRole(data,a.path)?.role??(/(^|\/)readme\./i.test(a.path)?'README 文档':a.role)}</p></div></button>;})}</nav>
      {view.tab==='history'&&<nav aria-label="维护执行列表">{jobs.map(j=><button key={j.id} className={`mw-task-row ${resultJob===j.id?'focused':''}`} onClick={()=>{setResultJob(j.id);update({jobId:j.id});setDetail(true);}}><span className="mw-task-icon"><FileSearch size={15}/></span><div><strong>{j.issueSnapshot.title}</strong><p>{j.kind} · {j.status}</p></div></button>)}</nav>}
      {filtered.length>300&&view.tab!=='history'&&<p className="mw-repository-list-footer">共 {filtered.length} 个匹配文件，显示前 300 个；可搜索缩小范围。</p>}
      {!filtered.length&&view.tab!=='history'&&<p className="mw-repository-list-footer">{loading?'正在读取文件清单…':!data.inventory?'尚未读取文件清单':inventoryUnavailable?'缓存清单中没有匹配文件；更新后可确认当前版本。':'当前范围没有匹配文件'}</p>}
      <div className="mw-repository-list-footer">{activeJobs.length} 个运行中 · {jobs.filter(j=>j.status==='awaiting_review').length} 个待审阅</div>
    </aside>
    <section className="mw-organize-main" role="tabpanel" id={`${scopeId}-panel`} aria-labelledby={`${scopeId}-${view.domain}`}>
      <header className="mw-reader-header"><h2><button className="mw-icon-button mw-repository-back" aria-label="返回仓库文件列表" onClick={()=>setDetail(false)}><ArrowLeft size={16}/></button>{view.selection||domains[view.domain]}{view.prId&&<small> · PR #{selectedPR?.number??'不可用'}</small>}</h2>
        {!editing&&<div className="mw-repository-actions"><button className="mw-button" disabled={working||loading||busy} onClick={()=>void perform(()=>refresh(true))}>刷新清单</button><button className="mw-button primary" disabled={!state.capabilities.harness||working||loading||busy||inventoryUnavailable||!data.inventory||(view.domain!=='overview'&&!assets.length)} onClick={()=>{if(openPending&&latest){setResultJob(latest.jobId);update({tab:'history',jobId:latest.jobId});}else void scan(false);}}>{working?'处理中…':auditPaths.trim()?'检查自定义范围':openPending?'查看检查进度':view.selection?'检查此文件':`检查${domains[view.domain]}`}</button><button className="mw-button" disabled={!state.capabilities.harness||working||busy||inventoryUnavailable||!data.inventory||data.inventory.source==='folder'} onClick={()=>setEditing(true)}>{mode==='ci'?'配置或修复 CI':mode==='agents'?'更新 Agent 指引':'准备文档修改'}</button></div>}
        {!editing&&<nav className="mw-reader-tabs" aria-label="仓库内容页面">{(['problems',...(selectedAsset?['content']:[]),'history'] as View['tab'][]).map(t=><button key={t} className={view.tab===t?'active':''} onClick={()=>update({tab:t})}>{{problems:'问题',content:'内容',history:'执行记录'}[t]}</button>)}</nav>}
      </header>
      <div className="mw-repository-content" ref={reader}>
        {view.prId&&<p className="mw-repository-evidence">文档影响检查将读取 PR 的实际差异，检查结果与原 PR 共用任务；文件预览仍显示当前仓库版本。</p>}
        {scopeNotice&&<p role="status" className="mw-repository-evidence">{scopeNotice}</p>}
        <RepositoryInventoryNotice inventory={data.inventory} error={inventoryError} outdated={inventoryOutdated} targetRevision={repo?.headSha} loading={inventoryRefreshing} disabled={working||busy} retry={()=>void perform(()=>refresh(true))}/>
        {error&&<p role="alert" className="mw-repository-error">{error}</p>}
        {loading&&<p role="status">正在读取文件清单，不调用模型…</p>}
        {data.inventory&&view.tab!=='content'&&!editing&&<div className="mw-maintenance-meta"><span>{data.inventory.source==='folder'?'普通文件夹':`版本 ${data.inventory.revision.slice(0,10)}`}{!view.selection&&<> · {data.inventory.assets.length} 个维护文件</>} · {inventoryUnavailable?'缓存清单 · 最新状态未确认':data.inventory.complete?'文件清单完整':'文件清单有读取限制'}</span><details><summary>范围与来源</summary><p>{repo?.localPath||repo?.fullName}</p><p>{new Date(data.inventory.scannedAt).toLocaleString('zh-CN')} · 仅识别文件，尚不代表内容已检查</p>{data.inventory.warnings.map(w=><p key={w}>{w}</p>)}</details></div>}
        {view.domain==='overview'&&!view.selection&&view.tab==='problems'&&!editing&&<section className="mw-repository-section"><h3>仓库识别</h3><p>{repo?.profile?.revision===data.inventory?.revision?repo?.profile?.languages.join('、')||'技术栈尚未识别':'技术栈摘要尚未更新'} · {data.inventory?.assets.filter(a=>a.domain==='docs').length??0} 份文档 · {data.inventory?.assets.filter(a=>a.domain==='agents').length??0} 份开发指引 · {data.inventory?.assets.filter(a=>a.domain==='ci').length??0} 个工作流</p><details><summary>配置与检查命令来源</summary>{data.inventory?.assets.filter(a=>a.domain==='config').map(a=><p key={a.path}><code>{a.path}</code></p>)}{repo?.profile?.revision===data.inventory?.revision&&repo?.profile?.commands.map((c,i)=><p key={i}><code>{c.command}</code> · {c.source}（声明命令，未执行）</p>)}</details></section>}
        {!editing&&view.tab==='problems'&&<section className={`mw-check-summary ${check.tone}`} aria-label="当前范围检查状态"><div><strong>{check.label}</strong><p>{check.detail}</p>
          {latest&&(current?<><small>{new Date(latest.createdAt).toLocaleString('zh-CN')} · 检查版本 {latest.revision.slice(0,10)} · 已检查 {latest.checkedPaths.length} 个文件</small><small>本记录范围：{latest.scope.length===0?'整个仓库':latest.scope.length===1?latest.scope[0]:`${latest.scope.length} 项路径`}</small></>:<details className="mw-previous-check"><summary>上次相关记录 · {latest.revision.slice(0,10)}</summary><p>{new Date(latest.createdAt).toLocaleString('zh-CN')} · {latest.state==='failed'?'未完成':latest.state==='completed'?'已完成':latest.state==='cancelled'?'已取消':latest.state==='pending'?'待完成':'部分完成'} · 已检查 {latest.checkedPaths.length} 个文件</p><p>记录范围：{latest.scope.length?latest.scope.join('、'):'整个仓库'}</p>{latest.summary&&<p>{latest.summary}</p>}</details>)}
        </div>{latest&&<div className="mw-repository-actions"><button className="mw-button" onClick={()=>{setResultJob(latest.jobId);update({tab:'history',jobId:latest.jobId});}}>{current?'查看本次记录':'查看历史记录'}</button>{(latest.state!=='pending'||!current)&&(latest.state!=='completed'||!current)&&<button className="mw-button" disabled={working||busy||loading||inventoryUnavailable||!state.capabilities.harness} onClick={()=>void scan(true)}>{!current?'检查当前版本':view.selection?'重新检查此文件':'重新检查当前范围'}</button>}</div>}</section>}

        {!editing&&view.tab==='problems'&&<details className="mw-check-options"><summary>检查选项</summary><label className="mw-repository-field">指定检查路径（每行一个，留空使用当前选择）<textarea aria-label="指定检查路径" rows={2} value={auditPaths} onChange={e=>setAuditPaths(e.target.value)}/></label><label className="mw-repository-field">检查补充要求<textarea aria-label="检查补充要求" rows={2} value={auditInstructions} maxLength={4000} onChange={e=>setAuditInstructions(e.target.value)}/></label><p>默认复用范围和依据均未变化的完整结果；不完整、失败或取消的检查不会当作已通过。</p><button className="mw-button" disabled={working||loading||inventoryUnavailable||!state.capabilities.harness} onClick={()=>void scan(true)}>忽略缓存，重新检查</button></details>}
        {editing?<RepositoryPlanEditor key={repoId+mode+JSON.stringify(planPaths)} repoId={repoId} mode={mode} prId={view.prId||undefined} paths={planPaths} findings={selected} act={act} close={()=>setEditing(false)} started={id=>{setEditing(false);setResultJob(id);update({tab:'history'});void refresh();}}/>:<>{view.tab==='problems'&&<><div className="mw-repository-section-heading"><h3>检查发现</h3><div className="mw-repository-actions"><button className="mw-button" disabled={!selected.length||working||selected.some(f=>f.stale)} onClick={()=>setEditing(true)}>处理已选问题 · {selected.length}</button><button className="mw-button" disabled={!selected.length||working||!state.capabilities.harness} onClick={()=>void perform(async()=>{const gen=generation.current;const r=await act('/repository/recheck',{repoId,ids:selected.map(f=>f.id)},'复查已派发') as {created?:string[];reused?:string[]};if(gen!==generation.current)return;setResultJob(r.created?.[0]??r.reused?.[0]??'');update({tab:'history'});})}>复查已选问题</button></div><label>状态 <select aria-label="仓库问题状态" value={status} onChange={e=>setStatus(e.target.value)}>{Object.entries({active:'待处理',deferred:'已暂缓',ignored:'已忽略',resolved:'已解决',all:'全部'}).map(([v,n])=><option value={v} key={v}>{n}</option>)}</select></label></div>
          {!findings.length&&<Empty title={relevant.length?'当前筛选下没有问题':check.tone==='good'?'未发现问题':'暂无检查发现'} text={relevant.length?'可以切换状态查看已暂缓、已忽略或已解决的记录。':check.tone==='good'?'本次完整检查没有发现需要处理的问题。':latest?'检查状态见上方；本次尚无可确认的完整结论。':'点击上方检查按钮开始，结果会自动保存。'}/>}
          {findings.map(f=><article className="mw-repository-section" key={f.id}><div className="mw-maintenance-checkbox"><input aria-label={'选择问题：'+f.title} type="checkbox" checked={selectedFindings.includes(f.id)} disabled={f.decision==='resolved'||f.domain!==mode} onChange={e=>setSelectedFindings(old=>e.target.checked?[...old,f.id]:old.filter(id=>id!==f.id))}/><h3>{f.title}</h3></div><div className="mw-repository-actions"><Tag>{kindNames[f.kind]}</Tag><Tag>{decisionNames[f.decision]}</Tag>{f.stale&&<Tag tone="warn">依据已变化，需复查</Tag>}</div><p>{f.impact}</p><p><code>{f.paths.join('、')}</code></p><RepositoryMarkdown text={f.recommendation}/><details><summary>依据与处理记录</summary>{f.evidence.map((e,i)=><p key={i}><code>{e.source}</code> · {e.detail}</p>)}{f.history.map((h,i)=><p key={i}>{h.at} · {h.action} · {h.reason}</p>)}</details><div className="mw-repository-actions"><button className="mw-button" onClick={()=>open(f.jobId)}>查看来源</button><button className="mw-button" disabled={working} onClick={()=>void decide(f,'open')}>恢复处理</button><button className="mw-button" disabled={working||!reason.trim()} onClick={()=>void decide(f,'deferred')}>暂缓</button><button className="mw-button" disabled={working||!reason.trim()} onClick={()=>void decide(f,'ignored')}>忽略</button></div></article>)}
          {!!findings.length&&<label className="mw-repository-field">暂缓或忽略的原因<input aria-label="问题处理原因" value={reason} onChange={e=>setReason(e.target.value)} maxLength={2000}/></label>}
        </>}
        {view.tab==='content'&&selectedAsset&&<><div className="mw-file-meta"><span>{content?.source==='remote'?'GitHub':content?.source==='folder'?'普通文件夹':'仓库快照'} · {(content?.revision??data.inventory?.revision)?.slice(0,10)}</span><details><summary>文件信息</summary><p>{document?document.role:'职责尚未检查；路径分类仅用于浏览。'}</p>{document&&<><p>读者：{document.audience||'未说明'} · 定位：{{current:'当前依据',historical:'历史材料',reference:'参考资料',unknown:'尚不确定'}[document.authority]}</p><p>关联：{document.relatedPaths.join('、')||'未记录'}</p></>}<p>{content?.source==='remote'?'GitHub 固定版本内容':content?.source==='folder'?'仅文件清单':'本地固定版本内容'}</p></details><button className="mw-text-button" onClick={()=>update({tab:'problems'})}>查看检查结果</button></div>{contentError&&<div role="alert" className="mw-repository-error"><p>{contentError}</p><button className="mw-button" disabled={working||loading} onClick={()=>void perform(async()=>{await refresh(true);setContentReload(value=>value+1);})}>刷新文件并重试</button></div>}{!content&&!contentError?<p role="status">正在读取固定版本内容…</p>:content&&<>{content.truncated&&<p role="status" className="mw-repository-error">当前仅显示部分内容，不能据此判断文件完整性。</p>}{/\.(md|mdx)$/i.test(content.path)?<RepositoryMarkdown text={content.content}/>:<pre className="mw-maintenance-source">{content.content}</pre>}</>}</>}

        {view.tab==='history'&&<>{!jobs.length&&<Empty title={view.selection?"尚无此文件执行记录":"尚无仓库维护任务"} text="检查和修改的记录会保存在这里。"/>}{displayedJob&&<RepositoryJobResult job={displayedJob} recheck={displayedScan&&['failed','cancelled','partial'].includes(displayedScan.state)?()=>void scan(true):undefined} open={open} command={(path,id)=>void perform(async()=>{await act(path,{id},'任务状态已更新');})} disabled={working}/>}</>} </>}
      </div>
    </section>
  </div>;
}
