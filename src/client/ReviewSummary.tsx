import React from 'react';
import type { Audit, Issue, Job } from '../core/types.ts';
import { kindNames } from '../core/types.ts';
import { validationState } from '../core/workflow-state.ts';
import { TestExecutionLink } from './ExecutionEvidence.tsx';
import { acceptanceEligibility, executionExplanation, patchScope, reviewEvidence, reviewVerdicts, revisionHistory, taskStatus, samePatch } from './review-evidence.ts';

export type DetailTab = 'overview' | 'evidence' | 'diff' | 'log';
type OpenJob = (id: string, tab: DetailTab) => void;
const statusNames = { passed: '报告通过', failed: '报告失败', not_run: '未执行' };

export function AcceptArtifactButton({ job, busy, blockedReason, accept }: { job: Job; busy: boolean; blockedReason?: string; accept: () => void }) {
  const blocked = job.artifactState === 'stale' || !!blockedReason;
  return <button type="button" className="mw-button primary" disabled={busy || blocked} aria-disabled={blocked} onClick={accept}>{['fix', 'docs'].includes(job.kind) ? '接受此实施产物' : '接受此报告'}</button>;
}

function TestReport({ job, own = false, role, open }: { job: Job; own?: boolean; role?: string; open: OpenJob }) {
  const tests = job.artifact && 'tests' in job.artifact ? job.artifact.tests : job.result?.tests ?? [];
  const validation = validationState(job.artifact);
  return <article className="mw-review-report" data-report-id={job.id}>
    <h4>{own ? '实施自报测试' : role ?? '关联验证报告'} <code>{job.id.slice(0, 8)}</code></h4>
    {validation && validation.state !== 'passed' && <p>{validation.reason}</p>}
    {own && <p className="mw-muted">实施自报不能替代独立验证。</p>}
    <p className="mw-review-test-counts">{tests.filter(t => t.status === 'passed').length} 项报告通过 · {tests.filter(t => t.status === 'failed').length} 项报告失败 · {tests.filter(t => t.status === 'not_run').length} 项未执行</p>
    <details><summary>环境、覆盖与 {tests.length} 条命令记录</summary><p className="mw-muted">记录时间：{job.createdAt}</p>
      {job.artifact?.stage === 'validate' && <><p>验证环境：{job.artifact.environment || '未说明'}</p><p>验证覆盖：{job.artifact.coverage || '未说明'}</p></>}
      {!tests.length ? <p>未提供命令记录，不能判断测试覆盖。</p> : tests.map((test, index) => <div className="mw-test" key={index}><strong>{statusNames[test.status]}</strong><code>{test.command}</code><pre>{test.output || '未提供输出'}</pre><TestExecutionLink job={job} test={test} /></div>)}
    </details>
    <button type="button" className="mw-text-button" onClick={() => open(job.id, 'evidence')}>核对此{own ? '实施' : '验证'}的证据 · {job.result?.evidence.length ?? 0} 条</button>
  </article>;
}

/** Display aggregation with existing guarded controls; authorization stays in the backend. */
export function ReviewSummary({ job, jobs, audit, native, open, openSession, issue, deliveryActions }: { job: Job; jobs: Job[]; audit: Audit[]; native: boolean; open: OpenJob; openSession?: (id: string) => void; issue?: Issue; deliveryActions?: React.ReactNode }) {
  const evidence = reviewEvidence(job, jobs), execution = executionExplanation(job, native, audit);
  const acceptance = acceptanceEligibility(job, jobs);
  const artifact = job.artifact, implementation = evidence.implementation, review = evidence.review;
  const risks = [...evidence.warnings];
  for (const source of [job, implementation?.id !== job.id ? implementation : undefined, review?.id !== job.id ? review : undefined]) {
    const item = source?.artifact;
    if (!item) continue;
    if ('limitations' in item) risks.push(...item.limitations);
    if ('risks' in item) risks.push(...item.risks);
    if ('blockers' in item) risks.push(...item.blockers);
  }
  const uniqueRisks = [...new Set(risks.filter(Boolean))];
  const reviewArtifact = review?.artifact?.stage === 'review' ? review.artifact : undefined;
  const unresolved = reviewArtifact?.findings.filter(f => !['dismissed', 'resolved'].includes(review?.findingDecisions?.[f.id] ?? '')) ?? [];
  const history = revisionHistory(job, jobs);
  const plan = job.issueSnapshot.plan;
  const criteria = plan?.acceptanceCriteria ?? (implementation?.artifact && 'acceptanceCriteria' in implementation.artifact ? implementation.artifact.acceptanceCriteria : []);
  const planChanged = !!issue && JSON.stringify(issue.plan ?? null) !== JSON.stringify(plan ?? null);
  const currentReview = reviewArtifact && review?.artifactState !== 'stale' && job.artifactState !== 'stale';
  const codeTask = ['fix', 'docs', 'validate', 'review'].includes(job.kind);
  return <section className="mw-review-summary" aria-label="审阅摘要">
    <h3>{['fix', 'docs', 'validate', 'review'].includes(job.kind) ? '最终审核' : '审阅摘要'}</h3>
    {codeTask && <nav className="mw-final-review-nav" aria-label="最终审核导航">{['目标完成情况', '验证证据', '未解决发现', '修订记录', '交付操作'].filter(name => name !== '交付操作' || deliveryActions).map(name => <button type="button" className="mw-text-button" key={name} onClick={event => event.currentTarget.closest('.mw-review-summary')?.querySelector(`[data-review-section="${name}"]`)?.scrollIntoView({ block: 'start' })}>{name}</button>)}</nav>}
    <p className="mw-review-state"><strong>{kindNames[job.kind]} · {execution.label}</strong>{job.artifactState === 'stale' && <span className="mw-tag amber">旧版本</span>}</p>
    {execution.waitingReason && <p>等待原因：{execution.waitingReason}</p>}
    <p>{artifact?.summary ?? job.result?.summary ?? '尚无通过格式校验的产物，请查看执行状态与记录。'}</p>
    {artifact && <p>当前产物覆盖范围：{artifact.coverage || '未说明，需进一步核对'}</p>}
    <p className="mw-muted">任务 <code>{job.id.slice(0, 8)}</code> · 基线 <code title={job.baseSha}>{job.baseSha.slice(0, 12)}</code> · 第 {job.attempt} 次尝试</p>
    {execution.latest && <p className="mw-review-latest">最近记录：{execution.latest.detail}</p>}
    <p className="mw-review-next">下一步：{execution.next}</p>
    {!acceptance.allowed && ['awaiting_review', 'completed'].includes(job.status) && <p className="mw-callout amber">待审核已暂停：{acceptance.reason} 历史接受记录不会被改写。</p>}
    <div className="mw-review-links"><button type="button" className="mw-text-button" onClick={() => open(job.id, 'log')}>查看执行记录</button>{job.sessionId && openSession && <button type="button" className="mw-text-button" onClick={() => openSession(job.sessionId!)}>打开对应 Harness 会话 / 审批</button>}</div>
    {artifact?.stage === 'triage' && <section><h4>分诊依据与缺口</h4><p>影响范围：{artifact.module || '模块待核实'} · {artifact.impact || '影响尚待核实'}</p><p>{artifact.routeReason}</p>{artifact.missingInfo.length > 0 && <ul>{artifact.missingInfo.map((text, index) => <li key={index}>{text}</li>)}</ul>}<p className="mw-muted">轻量分诊不执行代码测试；影响判断仍需后续证据核实。</p><button type="button" className="mw-text-button" onClick={() => open(job.id, 'evidence')}>查看分诊证据</button></section>}
    {codeTask && <section aria-label="目标完成情况" data-review-section="目标完成情况"><h4>目标完成情况</h4>
      <p>{plan?.goal || implementation?.instructions || job.instructions || job.issueSnapshot.title}</p>
      {!plan?.goal && <p className="mw-muted">以上引用本次任务说明或原事项标题，未保存单独的维护目标。</p>}
      {plan?.scope && <p>约定范围：{plan.scope}</p>}
      {implementation?.artifact && 'changes' in implementation.artifact && <><p>实施报告中的完成内容：</p><ul>{implementation.artifact.changes.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
      {planChanged && <p className="mw-callout amber">当前事项计划已变化，以下是本任务执行时的目标，不能作为新目标的完成证明。</p>}
      <p className="mw-muted">{currentReview ? `审查判断：${reviewVerdicts[reviewArtifact.verdict]}。` : '尚无可引用的独立审查判断。'}验收条件仍需逐项核对，测试通过不自动表示目标全部完成。</p>
      {criteria.length ? <ul>{criteria.map((text, index) => <li key={index}><span className="mw-tag">待核对</span> {text}</li>)}</ul> : <p className="mw-review-unknown">尚未记录验收条件。</p>}
    </section>}
    {codeTask && <section aria-label="验证证据" data-review-section="验证证据"><h4>验证证据</h4><p>{patchScope(job.patch)}</p>{job.patch && <button type="button" className="mw-text-button" onClick={() => open(job.id, 'diff')}>查看此任务的完整补丁</button>}

      {evidence.validations.length ? evidence.validations.map(report => <TestReport key={report.id} job={report} role={review ? evidence.reviewSourceValidationIds.includes(report.id) ? '本次审查引用的验证报告' : '其他同补丁验证报告' : undefined} open={open} />) : <p className="mw-review-unknown">尚无可引用的同一补丁独立验证报告。</p>}
      {implementation && <TestReport job={implementation} own open={open} />}
    </section>}
    {codeTask && <section aria-label="未解决发现" data-review-section="未解决发现"><h4>未解决发现</h4>
      {reviewArtifact ? <><p>{reviewVerdicts[reviewArtifact.verdict]}</p><p>{review?.status === 'approved' ? '本地已接受此审查' : '此审查尚未被本地接受'} · {unresolved.length} 项当前发现仍需处理</p>
        {unresolved.map(finding => <article className="mw-finding" key={finding.id}><strong>{finding.severity} · {finding.title}</strong><code>{finding.path}{finding.line ? `:${finding.line}` : ''}</code><p>触发条件：{finding.trigger}</p><p>依据：{finding.evidence}</p><p>建议：{finding.recommendation}</p><p className="mw-muted">处置：{({ accepted: '已接受，等待修订', needs_evidence: '需要更多证据' } as Record<string, string>)[review?.findingDecisions?.[finding.id] ?? ''] ?? '尚未决定'}</p></article>)}
        {!unresolved.length && <p>本次审查没有尚待处置的当前发现；仍需核对审查覆盖与历史发现。</p>}
        {review?.findingFollowups?.filter(item => item.status !== 'resolved').map(item => <article className="mw-finding" key={`${item.sourceJobId}:${item.findingId}`}><strong>历史发现 {item.findingId} · {item.status === 'still_present' ? '仍存在' : '无法确认已解决'}</strong><p>{item.evidence}</p><p className="mw-muted">来源 {item.sourceJobId.slice(0, 8)}</p></article>)}
        <p>审查覆盖：{reviewArtifact.coverage || '未说明'}</p><button type="button" className="mw-text-button" onClick={() => open(review!.id, 'overview')}>打开对应审查与逐项处置</button>
      </> : <p className="mw-review-unknown">未关联可引用的独立审查结论，不能判断发现是否已处理。</p>}
    </section>}
    {codeTask && <section aria-label="修订记录" data-review-section="修订记录"><h4>修订记录</h4><p className="mw-muted">仅展示明确来源链；历史失败和旧补丁保留供追溯，不作为当前验证证据。</p>
      <ol className="mw-revision-history">{history.records.map(record => <li key={record.id}><strong>{kindNames[record.kind]} · {taskStatus(record).label}</strong><p>{record.artifact?.summary ?? record.result?.summary ?? record.error ?? '尚无报告'}</p><p className="mw-muted">{record.createdAt} · 第 {record.attempt} 次尝试 · {record.id === job.id ? '当前选择' : samePatch(job, record) ? '同版本同补丁记录' : '历史来源，非当前补丁证据'}</p>{record.reviewNote && <p>维护者意见：{record.reviewNote}</p>}<button type="button" className="mw-text-button" onClick={() => open(record.id, 'overview')}>查看记录 {record.id.slice(0, 8)}</button></li>)}</ol>
      {history.warnings.map(text => <p className="mw-review-unknown" key={text}>{text}</p>)}
    </section>}
    <section><h4>风险与限制</h4>{uniqueRisks.length ? <ul>{uniqueRisks.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p>当前记录未列出额外限制；这不表示没有风险。</p>}</section>
    <div className="mw-review-links">{[implementation, ...evidence.validations, review].filter((source, index, rows): source is Job => !!source && rows.findIndex(other => other?.id === source.id) === index).map(source => <button type="button" className="mw-text-button" key={source.id} onClick={() => open(source.id, 'overview')}>{kindNames[source.kind]}记录 {source.id.slice(0, 8)}</button>)}</div>
    {deliveryActions && <section aria-label="交付操作" data-review-section="交付操作"><h4>交付操作</h4>
      {review && implementation && implementation.id !== job.id && <p><button type="button" className="mw-text-button" onClick={() => open(implementation.id, 'overview')}>查看对应实施产物与交付状态</button></p>}
      <p className="mw-muted">接受保存本地决定；对外发布仍需预览确认，并重新核验版本和补丁。</p>{deliveryActions}
    </section>}
    <p className="mw-muted">测试状态是保存的报告，需核对工具证据和原生会话。摘要不替代接受或发布时的实时版本核验。</p>
  </section>;
}
