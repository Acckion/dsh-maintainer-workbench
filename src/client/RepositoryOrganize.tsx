import React, {useState} from 'react';
import {organizeActions, type OrganizeMode} from '../core/organize.ts';
import type {Snapshot} from '../core/types.ts';
export function RepositoryOrganize({state,repoId,busy,run,open}:{state:Snapshot;repoId:string;busy:boolean;run:(data:unknown)=>Promise<void>;open:(id:string)=>void}) {
  const repo=state.repos.find(r=>r.id===repoId);
  const [instructions,setInstructions]=useState('');
  const prs=state.issues.filter(i=>i.repoId===repoId && i.type==='pr' && i.state==='open');
  const [pr,setPr]=useState('');
  const jobs=state.jobs.filter(j=>j.repoId===repoId && (j.issueSnapshot.origin==='repository' || j.instructions?.startsWith(organizeActions.docs.instructions))).slice(0,20);
  return <div className="mw-organize-workspace"><aside className="mw-organize-sidebar">    <h3>为 PR 补齐文档</h3><label>选择当前仓库的开放 PR<select value={prs.some(i=>i.id===pr)?pr:''} onChange={e=>setPr(e.target.value)}><option value="">选择 PR</option>{prs.map(i=><option key={i.id} value={i.id}>#{i.number} {i.title}</option>)}</select></label><button className="mw-button" disabled={busy || !state.capabilities.harness || !prs.some(i=>i.id===pr)} onClick={()=>void run({repoId,mode:'docs',issueId:pr,instructions})}>检查并准备文档补丁</button>
    <h3>最近整理任务</h3>{jobs.length ? jobs.map(j=><button className="mw-task-row" key={j.id} onClick={()=>open(j.id)}><div><strong>{j.issueSnapshot.title}</strong><p>{j.result?.summary ?? j.error ?? '等待执行结果'}</p><small>{j.artifactState==='stale'?'旧版本 · ':''}{j.status} · {new Date(j.createdAt).toLocaleString('zh-CN')}</small></div></button>):<p>尚未运行整理任务。选择上方任一操作开始。</p>}
</aside><section className="mw-settings-card mw-organize">

    <label>本次范围或重点（可选）<textarea rows={3} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="例如只整理 docs/，保留历史设计文档" /></label>
    <div className="mw-organize-grid">{Object.entries(organizeActions).map(([mode,a])=><article key={mode}><h3>{a.title}</h3><p>{a.description}</p><button className="mw-button primary" disabled={busy || !repoId || !state.capabilities.harness || mode !== 'audit' && repo?.mode === 'local' && (!repo.headSha || repo.dirty)} onClick={()=>void run({repoId,mode:mode as OrganizeMode,instructions})}>{mode==='audit'?'开始检查':'准备修改'}</button></article>)}</div>
    {!state.capabilities.harness && <p>请在 Harness 中打开插件，以使用仓库读取与隔离工作区。</p>}
    <p className="mw-muted">CI 配置生成、本地验证和远端运行分别核对。当前按需执行，不会自动发评论、推送或修改仓库设置。</p>
  </section></div>;
}
