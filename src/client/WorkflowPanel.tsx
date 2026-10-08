import {organizeActions} from '../core/organize.ts';
import React, { useState } from 'react';
import type { Issue, Job, JobKind } from '../core/types.ts';
import { kindNames } from '../core/types.ts';
import { validationState } from '../core/workflow-state.ts';
import { reviewVerdicts } from './review-evidence.ts';
const stages: Record<string,string> = { needs_info:'等待补充信息', decision:'等待维护者决策', accepted:'已接受', deferred:'已暂缓', investigate:'调查原因', implement:'可以实施', answer:'准备答复', track:'跟踪已有工作', draft:'远端草稿阶段', review:'等待审查', blocked:'存在阻塞', fix:'实施完成', docs:'文档变更完成', validate:'验证完成', validated:'验证报告通过', ci:'CI 诊断完成' };
export function WorkflowPanel({ issue, job, history, busy, act, hideSummary = false }: { issue: Issue; job?: Job; history: Job[]; busy: boolean; hideSummary?: boolean; act: (path: string, data: unknown, message: string) => Promise<unknown> }) {
  const [instructions, setInstructions] = useState('');
  const a = job?.artifact;
  const validation = validationState(a);
  const complete = job?.artifactState !== 'stale' && job && !!job.result && !['running','queued','failed','cancelled','rejected'].includes(job.status);
  const primary: JobKind | undefined = job && ['failed','cancelled','rejected'].includes(job.status) ? undefined : job?.artifactState === 'stale' ? (issue.origin === 'repository' ? 'investigate' : issue.type === 'pr' ? 'preflight' : 'triage') : !a ? (issue.origin === 'repository' ? undefined : issue.type === 'pr' ? 'preflight' : 'triage') : a.stage === 'triage' ? (a.route === 'implement' ? (a.category === 'docs' ? 'docs' : 'fix') : a.route === 'investigate' ? 'investigate' : undefined) : a.stage === 'preflight' ? (a.readiness === 'blocked' ? undefined : 'review') : a.stage === 'investigate' ? (issue.origin === 'repository' ? (a.proposedChanges.length ? 'docs' : undefined) : 'fix') : ['fix','docs'].includes(a.stage) ? (job?.patch ? 'validate' : undefined) : a.stage === 'validate' ? (validation?.state === 'passed' ? 'review' : validation?.state === 'failed' ? 'fix' : 'validate') : a.stage === 'review' && Object.values(job?.findingDecisions ?? {}).includes('accepted') ? 'fix' : a.stage === 'ci' ? 'investigate' : undefined;
  const next = async (kind: JobKind) => act('/jobs', { issueIds:[issue.id], kind, sourceJobId: complete ? job.id : undefined, instructions: issue.origin === 'repository' ? `Repository maintenance follow-up. Current stage is ${kind}; preserve the accepted scope and use handoff evidence. Do not repeat earlier audit-only constraints when explicitly implementing. ${kind === 'docs' && issue.organizeMode ? organizeActions[issue.organizeMode === 'audit' ? 'docs' : issue.organizeMode].instructions : ''} ${instructions}` : instructions }, '已派发下一阶段，自动交接现有证据');
  return <section className="mw-workflow">
    <div className="mw-section-title">处理流程 <span className="mw-tag">{issue.state === 'closed' ? (issue.merged ? 'GitHub 已合并' : 'GitHub 已关闭') : stages[issue.workflow?.stage ?? ''] ?? (issue.origin === 'repository' ? '仓库整理任务' : issue.type === 'pr' ? '待预检' : '待分诊')}</span>
</div>
    {job?.deliveryReviewId && <p className="mw-callout">此产物保存了审查关联；当前有效性与限制请核对审阅摘要，发布时仍会再次检查。</p>}
    {job?.artifactState === 'stale' && <div className="mw-callout amber">此产物对应旧版本，仅供参考；请对当前版本重新执行。</div>}{!hideSummary && <p className="mw-muted">{a?.summary ?? issue.workflow?.reason ?? '先判断处理方向，再按需要调查、实施和验证。'}</p>}
    {issue.linkedPullRequests?.map(url => <p key={url}>
<a href={url} target="_blank" rel="noreferrer">跟踪已创建的 PR ↗</a>
</p>)}
    {validation && validation.state !== 'passed' && <div className="mw-callout amber">
<strong>{validation.reason}</strong>
</div>}
    {a && <>{!hideSummary && <p>{a.coverage}</p>}{a.stage === 'triage' && <div className="mw-callout">
<div>
<strong>{stages[a.route]} · {a.module || '模块待确定'}</strong>
<p>{a.routeReason}</p>
<p>影响：{a.impact}</p>
</div>
</div>}
    {(a.stage === 'investigate' || a.stage === 'ci') && <>
<h4>事实与假设</h4>{'facts' in a && a.facts.map((s,i) => <p key={`f${i}`}>事实：{s}</p>)}{'hypotheses' in a && a.hypotheses.map((s,i) => <p key={`h${i}`}>待验证：{s}</p>)}</>}
    {a.stage === 'preflight' && a.risks.length > 0 && <>
<h4>本次审查重点</h4>
<ul>{a.risks.map((s,i) => <li key={i}>{s}</li>)}</ul>
<p className="mw-muted">以下是需要核对的影响点，不代表已发现缺陷。</p>
</>}{a.stage === 'investigate' && <>
<h4>复现与根因</h4>
<p>{a.reproduction}</p>
<p>{a.rootCause}</p>
</>}
    {'acceptanceCriteria' in a && <>
<h4>验收条件</h4>
<ul>{a.acceptanceCriteria.map((s,i) => <li key={i}>{s}</li>)}</ul>
</>}
    {'blockers' in a && a.blockers.length > 0 && <div className="mw-callout amber">
<div>
<strong>阻塞</strong>{a.blockers.map((s,i) => <p key={i}>{s}</p>)}</div>
</div>}
    {a.stage === 'review' && <>
<h4>审查发现 · {a.findings.length}</h4>
<p>{reviewVerdicts[a.verdict]}</p>{a.findings.length === 0 && a.verdict !== 'incomplete' && <p>本次覆盖范围内没有已确认的发现；请同时检查覆盖限制。</p>}{a.findings.map(f => <article className="mw-finding" key={f.id}>
<strong>{f.severity} · {f.title}</strong>
<code>{f.path}{f.line ? `:${f.line}` : ''}</code>
<p>触发条件：{f.trigger}</p>
<p>{f.evidence}</p>
<p>建议：{f.recommendation}</p>
<label>维护者处置<select disabled={busy || job?.artifactState === 'stale'} value={job?.findingDecisions?.[f.id] ?? ''} onChange={e => void act('/finding', { id: job!.id, findingId:f.id, decision:e.target.value }, '已保存发现处置')}>
<option value="" disabled>尚未决定</option>
<option value="accepted">接受，交给实施</option>
<option value="needs_evidence">需要更多证据</option>
<option value="dismissed">不适用</option>
<option value="resolved">已解决（维护者判断）</option>
</select>
</label>
</article>)}</>}
    </>}
    {job?.prContext && <details>
<summary>PR 版本、CI 与审查事实</summary>
<p>Head：{job.prContext.headSha}</p>
<p>Base：{job.prContext.baseSha}</p>
<p>{job.prContext.draft ? '草稿' : '非草稿'} · GitHub 可合并状态：{job.prContext.mergeable === null ? '未知' : job.prContext.mergeable ? '可合并' : '存在冲突或不可合并'}</p>{job.prContext.warnings.map(w => <p key={w}>{w}</p>)}<pre>{JSON.stringify({ checks:job.prContext.checks, reviews:job.prContext.reviews, reviewComments:job.prContext.reviewComments, commitStatus:job.prContext.commitStatus },null,2)}</pre>
</details>}
    {issue.state === 'open' && <>
<label>下一阶段目标、验收条件或修订意见<textarea rows={3} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="可选。已有调查、验收条件和处置记录将自动传递。" />
</label>
<div className="mw-workflow-actions">{primary && <button className="mw-button primary" disabled={busy || history.some(j => ['running','queued'].includes(j.status))} onClick={() => void next(primary)}>下一步：{kindNames[primary]}</button>}</div>
<details>
<summary>其他阶段与快捷操作</summary>
<div className="mw-workflow-actions">
      {(issue.type === 'pr' ? ['preflight','review','ci','fix','validate'] : ['triage','investigate','fix','docs', ...(job?.patch ? ['validate','review'] : [])]).map(k => <button className="mw-button" key={k} disabled={busy || history.some(j => ['running','queued'].includes(j.status))} onClick={() => void next(k as JobKind)}>{kindNames[k as JobKind]}</button>)}
      </div>
</details>{issue.type === 'issue' && <div className="mw-workflow-actions">{[['accepted','接受事项'],['needs_info','等待信息'],['deferred','暂缓']].map(([stage,label]) => <button className="mw-text-button" key={stage} disabled={busy} onClick={() => void act('/decision', {issueId:issue.id,stage,reason:instructions}, '已更新本地处理阶段')}>{label}</button>)}</div>}</>}
    <details>
<summary>阶段历史与交接 · {history.length}</summary>{[...history].reverse().map(j => <div className="mw-stage-event" key={j.id}>
<strong>{kindNames[j.kind]}</strong>
<span>{new Date(j.createdAt).toLocaleString('zh-CN')}</span>
<p>{j.error ?? j.result?.summary ?? '尚无产物'}</p>{j.sourceJobId && <small>继承来源：{j.sourceJobId.slice(0,8)}</small>}{j.reviewNote && <p>维护者反馈：{j.reviewNote}</p>}</div>)}</details>
  </section>;
}
