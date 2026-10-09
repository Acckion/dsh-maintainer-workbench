import React from 'react';
import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, Loader2, X, XCircle } from 'lucide-react';
import type { Job } from '../core/types.ts';
import type { OperationRecord } from './operation-state.ts';
import { kindNames } from '../core/types.ts';
import { taskStatus } from './review-evidence.ts';

export type { OperationRecord } from './operation-state.ts';
export function operationTaskIds(record?: OperationRecord) { return record ? [...new Set([...record.ids, ...record.reused])] : []; }

export function OperationTracker({ record, jobs, open, close }: { record?: OperationRecord; jobs: Job[]; open: (id: string) => void; close: () => void }) {
  if (!record) return null;
  const requested = operationTaskIds(record);
  return <section className="mw-operation-tracker mw-operation-compact" aria-label="本次操作追踪">
    <button className="mw-operation-close" aria-label="关闭本次操作追踪" onClick={close}><X size={16}/></button>
    <details open={record.errors.length > 0}><summary>本次操作 · 新建 {record.ids.length} · 复用 {record.reused.length} · 失败 {record.errors.length}</summary>
    <div className="mw-operation-items">{requested.map(id => {
      const job = jobs.find(item => item.id === id);
      if (!job) return <div className="mw-operation-missing" key={id}><AlertTriangle size={15} /><span><code>{id.slice(0, 8)}</code> 已不在当前任务列表中；可能被删除或切换了数据源。</span></div>;
      const status = taskStatus(job);
      const icon = job.status === 'running' ? <Loader2 className="mw-spin" size={16} /> : ['failed', 'cancelled', 'rejected'].includes(job.status) ? <XCircle size={16} /> : ['queued', 'awaiting_review'].includes(job.status) ? <Clock3 size={16} /> : <CheckCircle2 size={16} />;
      return <button key={id} className={`mw-operation-${status.tone}`} onClick={() => open(id)}><span>{icon}</span><div><strong>{kindNames[job.kind]} · #{job.issueSnapshot.number}</strong><small><code>{job.id.slice(0, 8)}</code> · {job.waitingReason || status.label}</small></div><ExternalLink size={15} /></button>;
    })}</div>
    {record.errors.length > 0 && <div className="mw-operation-errors">{record.errors.map(error => <p key={`${error.id}:${error.error}`}><AlertTriangle size={15} /><code>{error.id}</code><span>{error.error}</span></p>)}</div>}
    </details>
  </section>;
}
