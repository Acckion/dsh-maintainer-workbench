import React, { useState } from 'react';
import type { ExecutionRecord, Job } from '../core/types.ts';
import { linkedExecution } from '../core/execution-links.ts';

export function ExecutionEvidence({ job, record }: { job: Job; record: ExecutionRecord }) {
  const [log, setLog] = useState<{ raw: string; truncated: boolean }>();
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  return <article className="mw-execution-evidence" aria-label="真实工具执行记录">
    <p>原生工具 <code>{record.tool}</code> · {record.recordedAt}</p>
    <code>{record.command ?? '宿主未记录 shell 命令'}</code>
    <p>执行基线 <code>{record.checkoutSha}</code> · 退出码 {record.exitCode === null ? '未知（宿主未提供结构化退出码）' : record.exitCode}{record.isError ? ' · 工具报告错误' : ''}{record.signal ? ` · 信号 ${record.signal}` : ''}</p>
    <p>工作目录：{record.cwd ?? '未知'}</p><p>补丁指纹：{record.patchHash ?? '此记录未绑定执行时补丁，需核对原生会话'}</p>
    <details><summary>工具输出摘要{record.truncated ? '（已裁剪）' : ''}</summary><pre>{record.output || '没有文本输出'}</pre></details>
    <button className="mw-text-button" disabled={loading} onClick={async () => { setLoading(true); setError(''); try { const response = await fetch(`/maintainer/api/execution-output?id=${encodeURIComponent(job.id)}&recordId=${encodeURIComponent(record.id)}`); const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '无法读取日志'); setLog(result); } catch (error) { setError(error instanceof Error ? error.message : '无法读取日志'); } finally { setLoading(false); } }}>读取保存的原始工具日志</button>
    {error && <p className="mw-callout amber">{error}</p>}{log && <details open><summary>原始工具事件{log.truncated ? '（超过保存上限，已裁剪）' : ''}</summary><pre>{log.raw}</pre></details>}
  </article>;
}
export function TestExecutionLink({ job, test }: { job: Job; test: { command: string; executionId?: string; status?: string } }) {
  const record = linkedExecution(job, test);
  return record ? <>{test.status === 'passed' && (record.isError || record.exitCode !== null && record.exitCode !== 0) && <p className="mw-callout red">报告声称通过，但关联工具执行失败；请核对原始日志并重新验证。</p>}<ExecutionEvidence job={job} record={record} /></> : <p className="mw-muted">未关联唯一、同执行基线的工具记录；此项仅为报告，不能据此确认执行或退出码。</p>;
}
