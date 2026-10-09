import React, {useState} from 'react';
import {organizeActions, type OrganizeMode} from '../core/organize.ts';
import type {Snapshot} from '../core/types.ts';
export function RepositoryOrganize({state,repoId,busy,run,open}:{state:Snapshot;repoId:string;busy:boolean;run:(data:unknown)=>Promise<void>;open:(id:string)=>void}) {
  const repo=state.repos.find(r=>r.id===repoId);
  const [instructions,setInstructions]=useState('');
  const [mode,setMode]=useState<OrganizeMode>('audit');
  const [pr,setPr]=useState('');
  const prs=state.issues.filter(i=>i.repoId===repoId && i.type==='pr' && i.state==='open');
  const jobs=state.jobs.filter(j=>j.repoId===repoId && (j.issueSnapshot.origin==='repository' || j.instructions?.startsWith(organizeActions.docs.instructions))).slice(0,20);
  const current=organizeActions[mode];
  const disabled=busy || !repoId || !state.capabilities.harness || mode !== 'audit' && repo?.mode === 'local' && !repo.headSha;
  return <div className="mw-organize-workspace"><aside className="mw-organize-sidebar">
    <h3>仓库维护</h3><nav aria-label="仓库整理项目">{Object.entries(organizeActions).map(([value,a])=><button key={value} className={`mw-task-row ${mode===value?'focused':''}`} aria-current={mode===value?'page':undefined} onClick={()=>setMode(value as OrganizeMode)}><strong>{a.title}</strong></button>)}</nav>
    <h3>最近处理</h3>{jobs.length ? jobs.map(j=><button className="mw-task-row" key={j.id} onClick={()=>open(j.id)}><div><strong>{j.issueSnapshot.title}</strong><small>{j.artifactState==='stale'?'旧版本 · ':''}{new Date(j.createdAt).toLocaleString('zh-CN')}</small></div></button>):<p className="mw-muted">尚无整理任务</p>}
  </aside><section className="mw-organize-main">
    <header className="mw-organize-heading"><div><h2>{current.title}</h2><p>{current.description}</p></div><button className="mw-button primary" disabled={disabled} onClick={()=>void run({repoId,mode,instructions})}>{mode==='audit'?'开始检查':'检查并准备修改'}</button></header>
    <label>本次范围或重点（可选）<textarea rows={3} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="例如只整理 docs/，保留历史设计文档" /></label>
    {mode==='docs' && <details><summary>为一个 PR 补齐文档</summary><label>选择当前仓库的开放 PR<select value={prs.some(i=>i.id===pr)?pr:''} onChange={e=>setPr(e.target.value)}><option value="">选择 PR</option>{prs.map(i=><option key={i.id} value={i.id}>#{i.number} {i.title}</option>)}</select></label><button className="mw-button" disabled={busy || !state.capabilities.harness || !prs.some(i=>i.id===pr)} onClick={()=>void run({repoId,mode:'docs',issueId:pr,instructions})}>检查并准备文档补丁</button></details>}
    {!state.capabilities.harness && <p role="status">在 Harness 中打开插件后可读取仓库和准备修改。</p>}
    {mode !== 'audit' && <p className="mw-muted">改动将在独立工作副本中准备，结果可在 Tasks 查看。</p>}
  </section></div>;
}
