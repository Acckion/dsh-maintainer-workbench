import type { ReactNode } from 'react';
import { kindNames, type Job, type JobStatus } from '../core/types.ts';
import type { WorkspaceRecord } from '../domain/workspaces.ts';

const statuses: Record<JobStatus,string> = {queued:'待执行',running:'执行中',completed:'已完成',awaiting_review:'待审核',approved:'已接受',rejected:'已退回',failed:'失败',cancelled:'已停止',waiting_input:'等待补充信息',waiting_environment:'等待环境'};
const workspaceStatuses: Record<WorkspaceRecord['status'],string> = {preparing:'准备中',ready:'已就绪',in_use:'使用中',retained:'已保留',interrupted:'已中断',cleaning:'清理中',removed:'已清理'};

export function ExecutionResources({jobs,workspaces,openSession,openExecution,workspaceAction,currentCaseId}:{
  jobs:Job[]; workspaces?:WorkspaceRecord[]; currentCaseId?:string; openSession?:(id:string)=>void;
  openExecution?:(job:Job)=>void; workspaceAction?:(workspace:WorkspaceRecord)=>ReactNode;
}) {
  const history=[...jobs].sort((a,b)=>a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const stages = new Map<Job['kind'],Job[]>();
  for(const job of history) stages.set(job.kind,[...(stages.get(job.kind) ?? []),job]);
  const latestKind=history.at(-1)?.kind;
  return <ol className="mw-resource-stages">{[...stages].map(([kind,runs])=><li className="mw-resource-stage" key={kind}>
    <details className="mw-stage-resources" open={kind===latestKind}>
      <summary><strong>{kindNames[kind]}</strong><span>{runs.length} 次尝试 · {statuses[runs.at(-1)!.status]}</span></summary>
      <ol className="mw-resource-list">{runs.map((job,runIndex)=>{
    const workspace=workspaces?.find(w=>w.ownerRunId===job.id && w.repositoryId===job.repoId);
    const source=history.find(j=>j.id===job.sourceJobId);
    const attempt=runIndex+1;
    return <li className="mw-resource-row" key={job.id}>
      <div className="mw-resource-heading"><strong>{kindNames[job.kind]} · 第 {attempt} 次</strong><span>{statuses[job.status]}</span></div>
      <p className="mw-muted">{new Date(job.createdAt).toLocaleString('zh-CN',{hour12:false})}{currentCaseId && job.caseId && <span> · {job.caseId === currentCaseId ? "当前周期" : "历史周期"}</span>}</p>
      {job.sourceJobId && <p>来源：{source ? `${kindNames[source.kind]} · 第 ${history.slice(0,history.indexOf(source)+1).filter(j=>j.kind===source.kind).length} 次` : "关联执行不在当前记录中"}</p>}
      {workspace && <p>目录状态：{workspaceStatuses[workspace.status]}</p>}
      {(workspace?.path || job.worktree || job.analysisPath) && <details><summary>{job.worktree || workspace ? '隔离工作区路径' : '分析产物路径'}</summary><code>{workspace?.path ?? job.worktree ?? job.analysisPath}</code></details>}
      <div className="mw-resource-actions">
        {job.sessionId && openSession && <button className="mw-text-button" onClick={()=>openSession(job.sessionId!)}>打开{kindNames[job.kind]}会话</button>}
        {openExecution && <button className="mw-text-button" onClick={()=>openExecution(job)}>查看执行记录</button>}
        {workspace && workspaceAction?.(workspace)}
      </div>
      {job.sessionId && <details><summary>执行与会话标识</summary><p>执行：<code>{job.id}</code></p><p>会话：<code>{job.sessionId}</code></p>{!openSession && <p className="mw-muted">在 Harness 原生界面中可打开此会话。</p>}</details>}
    </li>;
  })}</ol>
    </details>
  </li>)}</ol>;
}
