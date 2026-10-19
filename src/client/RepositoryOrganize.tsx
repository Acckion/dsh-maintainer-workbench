import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, FileSearch, GitBranch, Search, Workflow } from 'lucide-react';
import type { Snapshot } from '../core/types.ts';
import type { MaintenanceSnapshot, MaintenanceDomain, MaintenanceFinding } from '../domain/maintenance.ts';
import { request } from './api.ts';
import { RepositoryPlanEditor } from './RepositoryPlanEditor.tsx';
import { RepositoryJobResult } from './RepositoryJobResult.tsx';
import { RepositoryMarkdown } from './RepositoryDetail.tsx';
import { Empty, Tag } from './Primitives.tsx';
const domains={overview:'概览',docs:'文档',agents:'Agent 指引',ci:'CI'};
const decisionNames={open:'待处理',deferred:'已暂缓',ignored:'已忽略',resolved:'已解决'};
const kindNames={contradiction:'事实不一致',missing:'必要内容缺失',suggestion:'可选改进',uncertain:'证据不足'};
const empty:MaintenanceSnapshot={findings:[],scans:[]};
type View={domain:keyof typeof domains;selection:string;tab:'problems'|'content'|'history'};
export function RepositoryOrganize(props:{state:Snapshot;repoId:string;busy:boolean;run:(data:unknown)=>Promise<string|undefined>;open:(id:string)=>void;act:(path:string,data:unknown,message:string)=>Promise<unknown>}) {
  const {state,repoId,busy,open,act}=props;
  const [data,setData]=useState<MaintenanceSnapshot>(empty),[view,setView]=useState<View>({domain:'overview',selection:'',tab:'problems'});
  const [query,setQuery]=useState(''),[status,setStatus]=useState('active'),[detail,setDetail]=useState(false),[editing,setEditing]=useState(false),[selectedFindings,setSelectedFindings]=useState<string[]>([]),[resultJob,setResultJob]=useState('');
  const [error,setError]=useState(''),[loading,setLoading]=useState(false),[working,setWorking]=useState(false),[reason,setReason]=useState('');
  const [content,setContent]=useState<{path:string;content:string;revision:string;truncated:boolean}>(),[contentError,setContentError]=useState('');
  const generation=useRef(0),actionLock=useRef(false);
  const repo=state.repos.find(r=>r.id===repoId);
  const update=(patch:Partial<View>)=>setView(old=>{const next={...old,...patch};try{localStorage.setItem(`maintainer.maintenance.view:${repoId}`,JSON.stringify(next));}catch{}return next;});
  const refresh=async(inventory=false)=>{const gen=generation.current;if(inventory){await request('/repository/inventory',{repoId});}const next=await request('/repository/maintenance?repoId='+encodeURIComponent(repoId));if(generation.current===gen)setData(next);};
  useEffect(()=>{const gen=++generation.current;setData(empty);setError('');setContent(undefined);setEditing(false);setSelectedFindings([]);setResultJob('');setDetail(false);setQuery('');setStatus('active');
    try{const saved=JSON.parse(localStorage.getItem(`maintainer.maintenance.view:${repoId}`)??'null');setView(saved&&saved.domain in domains?{domain:saved.domain,selection:String(saved.selection??''),tab:['problems','content','history'].includes(saved.tab)?saved.tab:'problems'}:{domain:'overview',selection:'',tab:'problems'});}catch{setView({domain:'overview',selection:'',tab:'problems'});}
    setLoading(true);void (async()=>{try{const saved=await request('/repository/maintenance?repoId='+encodeURIComponent(repoId));if(gen!==generation.current)return;setData(saved);await request('/repository/inventory',{repoId});if(gen===generation.current)await refresh();}catch(e){if(gen===generation.current)setError((e as Error).message);}finally{if(gen===generation.current)setLoading(false);}})();
    return()=>{generation.current++;};
  },[repoId]);
  const jobStamp=state.jobs.filter(j=>j.repoId===repoId && j.issueSnapshot.origin==='repository').map(j=>j.id+j.status+j.updatedAt).join('|');
  useEffect(()=>{void refresh().catch(e=>setError((e as Error).message));},[jobStamp]);
  const assets=data.inventory?.assets.filter(a=>view.domain==='overview'||a.domain===view.domain)??[];
  const filtered=assets.filter(a=>`${a.path} ${a.role}`.toLowerCase().includes(query.toLowerCase()));
  const selectedAsset=assets.find(a=>a.path===view.selection);
  const relevant=data.findings.filter(f=>(view.domain==='overview'||f.domain===view.domain)&&(!view.selection||f.paths.includes(view.selection)));
  const findings=relevant.filter(f=>(status==='all'||status==='active'&&f.decision==='open'||f.decision===status)&&`${f.title} ${f.paths.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const jobs=state.jobs.filter(j=>j.repoId===repoId && j.issueSnapshot.origin==='repository').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const activeJobs=jobs.filter(j=>['running','queued'].includes(j.status));
  useEffect(()=>{setContent(undefined);setContentError('');if(!selectedAsset||view.tab!=='content')return;let live=true;void request(`/repository/asset?repoId=${encodeURIComponent(repoId)}&path=${encodeURIComponent(selectedAsset.path)}`).then(v=>{if(live)setContent(v);}).catch(e=>{if(live)setContentError(e.message);});return()=>{live=false;};},[repoId,selectedAsset?.path,selectedAsset?.oid,view.tab]);
  const perform=async(fn:()=>Promise<void>)=>{if(actionLock.current)return;actionLock.current=true;setWorking(true);setError('');const gen=generation.current;try{await fn();if(gen===generation.current)await refresh();}catch(e){if(gen===generation.current)setError((e as Error).message);}finally{actionLock.current=false;if(gen===generation.current)setWorking(false);}};
  const scan=()=>perform(async()=>{const result=await request('/repository/audit',{repoId,scope:view.selection?[view.selection]:view.domain==='overview'?[]:assets.map(a=>a.path),instructions:''});await refresh();if(result.created?.[0]||result.reused?.[0])update({tab:'history'});setDetail(true);});
  const decide=(f:MaintenanceFinding,decision:'open'|'deferred'|'ignored')=>perform(async()=>{await act('/repository/decision',{repoId,id:f.id,decision,reason,fingerprint:f.fingerprint},'处理决定已保存');setReason('');});
  const mode:MaintenanceDomain=view.domain==='overview'?'docs':view.domain;
  const selected=data.findings.filter(f=>selectedFindings.includes(f.id));
  const planPaths=view.selection?[view.selection]:selected.length?[...new Set(selected.flatMap(f=>f.paths))]:assets.filter(a=>a.domain===mode).map(a=>a.path);
  return <div className={`mw-organize-workspace mw-repository-browser ${detail?'detail-open':''}`}>
    <aside className="mw-organize-sidebar mw-list-panel" aria-label="仓库文件与问题">
      <div className="mw-toolbar"><label className="mw-repository-field">查看范围<select aria-label="仓库维护分类" value={view.domain} onChange={e=>{update({domain:e.target.value as View['domain'],selection:'',tab:'problems'});setSelectedFindings([]);setEditing(false);setDetail(true);}}>{Object.entries(domains).map(([key,name])=><option value={key} key={key}>{name}</option>)}</select></label></div>
      <div className="mw-toolbar"><label className="mw-search"><Search size={16}/><input aria-label="搜索仓库文件与问题" placeholder="搜索文件或问题" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
      <button className={`mw-task-row ${!view.selection?'focused':''}`} onClick={()=>{update({selection:'',tab:'problems'});setDetail(true);}}><span className="mw-task-icon"><FileSearch size={16}/></span><div><strong>{domains[view.domain]}</strong><p>{relevant.filter(f=>f.decision==='open').length} 个待处理问题</p></div></button>
      <nav aria-label="仓库文件" hidden={view.tab==='history'}>{filtered.map(a=>{const Icon=a.domain==='ci'?Workflow:a.domain==='agents'?GitBranch:BookOpen;return <button className={`mw-task-row ${view.selection===a.path?'focused':''}`} key={a.path} onClick={()=>{update({selection:a.path,tab:'content'});setEditing(false);setSelectedFindings([]);setDetail(true);}}><span className="mw-task-icon"><Icon size={15}/></span><div><strong>{a.path}</strong><p>{a.role}</p></div></button>;})}</nav>
      {view.tab==='history'&&<nav aria-label="维护执行列表">{jobs.map(j=><button key={j.id} className={`mw-task-row ${resultJob===j.id?'focused':''}`} onClick={()=>{setResultJob(j.id);setDetail(true);}}><span className="mw-task-icon"><FileSearch size={15}/></span><div><strong>{j.issueSnapshot.title}</strong><p>{j.kind} · {j.status}</p></div></button>)}</nav>}
      {!filtered.length&&view.tab!=='history'&&<p className="mw-repository-list-footer">{loading?'正在识别文件…':'当前范围没有匹配文件'}</p>}
      <div className="mw-repository-list-footer">{activeJobs.length} 个运行中 · {jobs.filter(j=>j.status==='awaiting_review').length} 个待审阅</div>
    </aside>
    <section className="mw-organize-main" aria-label="仓库详情">
      <header className="mw-reader-header"><h2><button className="mw-icon-button mw-repository-back" aria-label="返回仓库文件列表" onClick={()=>setDetail(false)}><ArrowLeft size={16}/></button>{view.selection||domains[view.domain]}</h2>
        <div className="mw-repository-actions"><button className="mw-button" disabled={working||loading||busy} onClick={()=>void perform(()=>refresh(true))}>刷新清单</button><button className="mw-button primary" disabled={!state.capabilities.harness||working||loading||busy||!data.inventory||(view.domain!=='overview'&&!assets.length)} onClick={()=>void scan()}>检查当前范围</button><button className="mw-button" disabled={!state.capabilities.harness||working||busy} onClick={()=>setEditing(true)}>{mode==='ci'?'配置或修复 CI':mode==='agents'?'更新 Agent 指引':'准备文档修改'}</button></div>
        <nav className="mw-reader-tabs" aria-label="仓库内容页面">{(['problems',...(selectedAsset?['content']:[]),'history'] as View['tab'][]).map(t=><button key={t} className={view.tab===t?'active':''} onClick={()=>update({tab:t})}>{{problems:'问题',content:'内容',history:'执行记录'}[t]}</button>)}</nav>
      </header>
      <div className="mw-repository-content">
        {error&&<p role="alert" className="mw-repository-error">{error}</p>}
        {loading&&<p role="status">正在读取文件清单，不调用模型…</p>}
        {data.inventory&&<div className="mw-maintenance-meta"><span>{data.inventory.source==='folder'?'普通文件夹':`版本 ${data.inventory.revision.slice(0,10)}`} · {data.inventory.assets.length} 个维护文件 · {data.inventory.complete?'文件清单完整':'文件清单有读取限制'}</span><details><summary>范围与来源</summary><p>{repo?.localPath||repo?.fullName}</p><p>{new Date(data.inventory.scannedAt).toLocaleString('zh-CN')} · 仅识别文件，尚不代表内容已检查</p>{data.inventory.warnings.map(w=><p key={w}>{w}</p>)}</details></div>}
        {editing?<RepositoryPlanEditor key={repoId+mode+JSON.stringify(planPaths)} repoId={repoId} mode={mode} paths={planPaths} findings={selected} act={act} close={()=>setEditing(false)} started={id=>{setEditing(false);setResultJob(id);update({tab:'history'});void refresh();}}/>:<>{view.tab==='problems'&&<><div className="mw-repository-section-heading"><h3>检查发现</h3><label>状态 <select aria-label="仓库问题状态" value={status} onChange={e=>setStatus(e.target.value)}>{Object.entries({active:'待处理',deferred:'已暂缓',ignored:'已忽略',resolved:'已解决',all:'全部'}).map(([v,n])=><option value={v} key={v}>{n}</option>)}</select></label></div>
          {!findings.length&&<Empty title={data.scans.length?'当前筛选下没有问题':'尚未检查此范围'} text="文件清单不代表检查结论。选择文件或范围后开始检查，结果会自动保存。"/>}
          {findings.map(f=><article className="mw-repository-section" key={f.id}><div className="mw-maintenance-checkbox"><input aria-label={'选择问题：'+f.title} type="checkbox" checked={selectedFindings.includes(f.id)} disabled={f.stale||f.decision==='resolved'||f.domain!==mode} onChange={e=>setSelectedFindings(old=>e.target.checked?[...old,f.id]:old.filter(id=>id!==f.id))}/><h3>{f.title}</h3></div><div className="mw-repository-actions"><Tag>{kindNames[f.kind]}</Tag><Tag>{decisionNames[f.decision]}</Tag>{f.stale&&<Tag tone="warn">依据已变化，需复查</Tag>}</div><p>{f.impact}</p><p><code>{f.paths.join('、')}</code></p><RepositoryMarkdown text={f.recommendation}/><details><summary>依据与处理记录</summary>{f.evidence.map((e,i)=><p key={i}><code>{e.source}</code> · {e.detail}</p>)}{f.history.map((h,i)=><p key={i}>{h.at} · {h.action} · {h.reason}</p>)}</details><div className="mw-repository-actions"><button className="mw-button" onClick={()=>open(f.jobId)}>查看来源</button><button className="mw-button" disabled={working} onClick={()=>void decide(f,'open')}>恢复处理</button><button className="mw-button" disabled={working||!reason.trim()} onClick={()=>void decide(f,'deferred')}>暂缓</button><button className="mw-button" disabled={working||!reason.trim()} onClick={()=>void decide(f,'ignored')}>忽略</button></div></article>)}
          {!!findings.length&&<label className="mw-repository-field">暂缓或忽略的原因<input aria-label="问题处理原因" value={reason} onChange={e=>setReason(e.target.value)} maxLength={2000}/></label>}
        </>}
        {view.tab==='content'&&selectedAsset&&<><p>{selectedAsset.role}（根据路径识别）</p>{contentError&&<p role="alert">{contentError}</p>}{!content&&!contentError?<p>正在读取固定版本内容…</p>:content&&<><small>{content.truncated?'内容不完整':'固定版本内容'}</small>{/\.md$/i.test(content.path)?<RepositoryMarkdown text={content.content}/>:<pre className="mw-maintenance-source">{content.content}</pre>}</>}</>}
        {view.tab==='history'&&<>{!jobs.length&&<Empty title="尚无仓库维护任务" text="检查和修改的记录会保存在这里。"/>}{(jobs.find(j=>j.id===resultJob)??jobs[0])&&<RepositoryJobResult job={(jobs.find(j=>j.id===resultJob)??jobs[0])!} open={open} command={(path,id)=>void perform(async()=>{await act(path,{id},'任务状态已更新');})} disabled={working}/>}</>} </>}
      </div>
    </section>
  </div>;
}
