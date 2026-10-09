import type { Issue, Job, JobKind } from './types.ts';
import { planBlocker } from './issue-flow.ts';
import { validationState } from './workflow-state.ts';
/** Only explicit user goals continue. No retries, scope acceptance or publication are automatic. */
export function nextGoalStep(job: Job, issue: Issue): {next?: JobKind; pause?: string} {
  if (!job.goal || ['queued','running'].includes(job.status)) return {};
  if (['failed','cancelled','rejected'].includes(job.status)) return {pause:'任务停止；请检查结果后决定是否重试'};
  if (issue.state !== 'open' || job.artifactState === 'stale') return {pause:'事项已关闭或输入版本已变化'};
  if (job.kind === 'investigate') {
    if (issue.plan?.decision !== 'accepted') return {pause:'调查已完成，请确认目标、范围和验收条件后开始修复'};
    const kind = issue.plan.category === 'docs' ? 'docs' : 'fix';
    const blocker = planBlocker(issue, kind);
    return blocker ? {pause:blocker} : {next:kind};
  }
  if (['fix','docs'].includes(job.kind)) return job.patch && job.result ? {next:'validate'} : {pause:'尚无可验证的改动，请检查实施结果'};
  if (job.kind === 'validate') {
    const validation = validationState(job.artifact);
    return validation?.state === 'passed' ? {next:'review'} : {pause:validation?.reason ?? '验证证据不足，等待确认'};
  }
  if (job.kind === 'review') return {pause:'审查已完成，等待维护者检查并交付'};
  return {};
}
