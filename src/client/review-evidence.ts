import type { Analysis, Audit, Issue, Job } from '../core/types.ts';
import { validationState } from '../core/workflow-state.ts';
import { validationAcceptance, type ValidationAcceptance } from '../core/validation-acceptance.ts';

/** Never display an older issue classification as the selected task's result. */
export function selectedAnalysis(issue?: Issue, job?: Job): Analysis | undefined {
  return job ? job.result : issue?.analysis;
}

const terminal = new Set<Job['status']>(['completed', 'awaiting_review', 'approved']);
const statusLabels: Record<Job['status'], string> = { queued: '排队等待执行', running: '执行中', failed: '执行失败', cancelled: '已取消', rejected: '已退回', completed: '报告已生成', awaiting_review: '等待维护者审核', approved: '本地产物已接受' };
export function acceptanceEligibility(job: Job, jobs: Job[]): ValidationAcceptance { return validationAcceptance(job, jobs); }
export function reviewQueue(jobs: Job[]): Job[] { return jobs.filter(job => job.status === 'awaiting_review' && job.artifactState !== 'stale' && acceptanceEligibility(job, jobs).allowed); }
export function taskStatus(job: Job): { label: string; tone: string } {
  const validation = terminal.has(job.status) ? validationState(job.artifact) : undefined;
  const label = validation ? `${validation.state === 'failed' ? '验证报告有失败' : validation.state === 'incomplete' ? '验证报告不完整' : '验证报告通过'}${job.status === 'approved' ? ' · 本地已接受' : ''}` : statusLabels[job.status];
  const tone = job.artifactState === 'stale' ? 'amber' : job.status === 'failed' || validation?.state === 'failed' ? 'red' : validation?.state === 'incomplete' || job.status === 'awaiting_review' ? 'amber' : job.status === 'approved' ? 'green' : 'violet';
  return { label: `${job.artifactState === 'stale' ? '旧版本 · ' : ''}${label}`, tone };
}
export function samePatch(a: Job, b: Job): boolean {
  const samePr = !a.prContext && !b.prContext || !!a.prContext && !!b.prContext
    && ['headSha', 'baseSha', 'headRef', 'headRepo', 'baseRef'].every(key => Reflect.get(a.prContext!, key) === Reflect.get(b.prContext!, key));
  return a.repoId === b.repoId && a.issueId === b.issueId && a.issueSnapshot.number === b.issueSnapshot.number
    && a.revision === b.revision && a.baseSha === b.baseSha && !!a.patch && a.patch === b.patch
    && a.artifactState !== 'stale' && b.artifactState !== 'stale' && samePr;
}

export interface ReviewEvidence {
  implementation?: Job;
  review?: Job;
  validations: Job[];
  reviewSourceValidationIds: string[];
  warnings: string[];
}

/** A display-only projection of explicit job links, never publication authorization. */
export function reviewEvidence(selected: Job, jobs: Job[]): ReviewEvidence {
  const evidence: ReviewEvidence = { validations: [], reviewSourceValidationIds: [], warnings: [] };
  if (selected.artifactState === 'stale') {
    evidence.warnings.push('这是旧版本记录，不引用它作为当前补丁的验证或审查依据');
    return evidence;
  }
  if (!terminal.has(selected.status)) {
    evidence.warnings.push('此任务尚未形成可接受的当前产物，不合并历史通过记录');
    return evidence;
  }
  const byId = new Map(jobs.map(job => [job.id, job]));
  const isImplementation = (job: Job) => job.kind === 'fix' || job.kind === 'docs';
  const includeLinkedValidations = (implementation: Job) => {
    // Reruns can be dispatched from a validation or review, not only the implementation.
    // Follow explicit handoffs and verify every intermediate record; identical patch text
    // alone must never pull in another implementation's reports.
    const children = new Map<string, Job[]>();
    for (const job of jobs) if (job.sourceJobId && ['validate', 'review'].includes(job.kind)) {
      children.set(job.sourceJobId, [...(children.get(job.sourceJobId) ?? []), job]);
    }
    const matching: Job[] = [], seen = new Set([implementation.id]);
    const queue = [{ job: implementation, depth: 0 }];
    let omitted = false;
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index];
      for (const job of children.get(parent.job.id) ?? []) {
        if (seen.has(job.id) || parent.depth >= 29 || !samePatch(selected, job) || !terminal.has(job.status)) {
          omitted = true;
          continue;
        }
        seen.add(job.id);
        if (job.kind === 'validate') matching.push(job);
        queue.push({ job, depth: parent.depth + 1 });
      }
    }
    const additional = matching.filter(job => !evidence.validations.some(record => record.id === job.id));
    if (evidence.review && additional.length) {
      evidence.warnings.push(additional.some(job => validationState(job.artifact)?.state !== 'passed')
        ? '同一补丁另有失败或未完成验证，现有审查未引用这些记录，请重新核对'
        : '同一补丁另有验证记录未被此审查引用，以下分别列出');
    }
    evidence.validations = [...evidence.validations, ...additional].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (omitted) evidence.warnings.push('部分关联验证或交接记录尚未完成、已过期或不属于此补丁，未计入当前证据');
  };
  if (isImplementation(selected)) evidence.implementation = selected;
  if (selected.kind === 'validate') evidence.validations = [selected];
  if (selected.kind === 'review') evidence.review = selected;
  const anchor = selected.deliveryReviewId ? byId.get(selected.deliveryReviewId) : selected;
  if (!anchor) { evidence.warnings.push('关联审查记录不可用，请重新核对来源'); return evidence; }
  if (selected.deliveryReviewId && anchor.kind !== 'review') {
    evidence.warnings.push('关联目标不是审查记录，不能确认交接'); return evidence;
  }
  if (selected.deliveryReviewId && anchor.status !== 'approved') evidence.warnings.push('关联审查目前未获批准，请重新处理审查决定');

  if (anchor.kind === 'review' || anchor.kind === 'validate') {
    // Ordinary PR reviews need not have an implementation source chain.
    if (!anchor.sourceJobId) {
      if (selected.deliveryReviewId) evidence.warnings.push('关联审查缺少实施来源，不能确认交接');
      return evidence;
    }
    const chain: Job[] = [], seen = new Set<string>();
    let cursor: Job | undefined = anchor;
    while (cursor) {
      if (seen.has(cursor.id) || chain.length >= 30 || !samePatch(selected, cursor)
        || !['review', 'validate', 'fix', 'docs'].includes(cursor.kind) || !terminal.has(cursor.status)) {
        evidence.warnings.push('来源链的状态、事项、版本或补丁不匹配，未合并其他记录');
        return evidence;
      }
      seen.add(cursor.id); chain.push(cursor);
      if (isImplementation(cursor)) break;
      cursor = cursor.sourceJobId ? byId.get(cursor.sourceJobId) : undefined;
    }
    if (!cursor || !isImplementation(cursor) || (selected.deliveryReviewId && cursor.id !== selected.id)) {
      evidence.warnings.push('未找到此补丁的完整实施来源，未合并其他记录'); return evidence;
    }
    evidence.implementation = cursor;
    evidence.review = anchor.kind === 'review' ? anchor : undefined;
    evidence.validations = chain.filter(job => job.kind === 'validate');
    evidence.reviewSourceValidationIds = evidence.review ? evidence.validations.map(job => job.id) : [];
    includeLinkedValidations(cursor);
    return evidence;
  }

  if (isImplementation(selected)) {
    // Follow only explicit handoffs for this patch, never any latest pass on the issue.
    // Show every matching report rather than selecting only a passing retry.
    includeLinkedValidations(selected);
  }
  return evidence;
}

export function patchScope(patch?: string): string {
  if (!patch) return '没有保存的代码补丁';
  const lines = patch.split('\n');
  const files = lines.filter(line => line.startsWith('diff --git ')).length;
  let added = 0, removed = 0, hunk = false;
  for (const line of lines) {
    if (line.startsWith('diff --git ') || line === 'GIT binary patch') hunk = false;
    else if (line.startsWith('@@')) hunk = true;
    else if (hunk && line.startsWith('+')) added++;
    else if (hunk && line.startsWith('-')) removed++;
  }
  return `${files || '未知数量'} 个文件差异 · +${added} / -${removed} 文本行${lines.some(line => line === 'GIT binary patch' || line.startsWith('Binary files ')) ? ' · 含二进制变更，请检查完整补丁' : ''}`;
}

export function executionExplanation(job: Job, native: boolean, audit: Audit[]) {
  const formatRetry = native && job.status === 'failed' && !!job.formatRecovery && !!job.rawOutput && !job.result && !!(job.worktree || job.analysisPath);
  const next = job.artifactState === 'stale' ? '从当前事项重新派发；旧结果不能批准。'
    : job.status === 'failed' ? formatRetry ? '查看错误和原始输出后，可仅整理已保存输出；不会重新实施代码。' : '查看错误和执行记录；重试会创建新任务，保留本次历史。'
      : job.status === 'cancelled' ? '已保留执行记录；停止完成后可以重新执行，不会自动恢复。'
        : job.status === 'rejected' ? '保留退回意见；确认目标后重新执行。'
          : job.status === 'queued' ? '等待执行器调度，可以停止；没有承诺开始时间。'
            : job.status === 'running' ? '检查最近记录；若会话提出审批，请在原生会话处理。也可以停止任务。'
              : job.status === 'approved' ? '接受只记录本地决定；发布具体内容仍需单独预览确认。'
                : '结合结论、补丁、验证和风险再决定下一步；接受报告不等于测试通过。';
  const latest = [...audit].filter(row => row.jobId === job.id).sort((a, b) => b.id - a.id)[0];
  return { label: taskStatus(job).label, next, waitingReason: ['queued', 'running'].includes(job.status) ? job.waitingReason : undefined, latest, formatRetry };
}

export const reviewVerdicts = { no_findings: '本次覆盖范围内未提出发现', changes_requested: '报告建议修改', incomplete: '审查覆盖不足，需要补充证据' };
