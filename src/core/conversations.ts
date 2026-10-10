import { organizeActions } from './organize.ts';
import { kindNames, type Job, type Repo } from './types.ts';

export const conversationCategories = {
  bug: '缺陷问题', feature: '功能需求', docs: '文档维护', question: '使用提问',
  maintenance: '一般维护', audit: '文档与仓库结构', agents: '开发指引', ci: 'CI 与构建',
} as const;
export type ConversationCategory = keyof typeof conversationCategories;

/** Task stages and PR numbers are records within a category, never group identities. */
export function taskConversationCategory(job: Job): ConversationCategory {
  const mode = job.issueSnapshot.organizeMode;
  if (mode) return mode;
  for (const [key, action] of Object.entries(organizeActions))
    if (job.instructions?.startsWith(action.instructions)) return key as ConversationCategory;
  if (job.kind === 'docs' || job.kind === 'ci') return job.kind;
  if (job.conversationCategory) return job.conversationCategory;
  const source = job.handoff?.find(item => item.id === job.sourceJobId);
  if (['validate', 'review'].includes(job.kind) && source?.kind === 'docs') return 'docs';
  const category = job.issueSnapshot.plan?.category ?? job.issueSnapshot.analysis?.category
    ?? (job.artifact && 'planDraft' in job.artifact ? job.artifact.planDraft?.category : undefined)
    ?? job.result?.category;
  return category && category in conversationCategories ? category : 'maintenance';
}

export function repositoryConversationTitle(repo: Pick<Repo, 'fullName' | 'githubName'>): string {
  return (repo.githubName ?? repo.fullName).slice(0, 160);
}

export function taskRecordTitle(job: Job): string {
  const issue = job.issueSnapshot;
  return `${issue.origin === 'repository' ? issue.title : `${issue.type === 'pr' ? 'PR' : 'Issue'} #${issue.number} · ${issue.title}`} · ${kindNames[job.kind]}${job.attempt > 1 ? ` · 第 ${job.attempt} 次` : ''}`;
}

export function conversationJobs(jobs: Job[], repoId: string, category: ConversationCategory): Job[] {
  return jobs.filter(job => job.repoId === repoId && taskConversationCategory(job) === category)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Organize conclusions and evidence separately; the original model/tool logs remain on each run. */
export function taskConversationRecord(job: Job): string {
  const artifact = job.artifact;
  const lines = [`### ${taskRecordTitle(job)}`, `${job.createdAt} · ${job.status} · 任务 ${job.id}`];
  if (job.issueSnapshot.url) lines.push(`来源：${job.issueSnapshot.url}`);
  if (job.sessionId) lines.push(`执行会话：${job.sessionId}`);
  lines.push(job.result?.summary ?? artifact?.summary ?? job.waitingReason ?? job.error ?? '尚未生成结论');
  if (artifact?.coverage) lines.push(`覆盖范围：${artifact.coverage}`);
  if (artifact?.stage === 'investigate') {
    if (artifact.facts.length) lines.push('事实：', ...artifact.facts.map(value => `- ${value}`));
    if (artifact.hypotheses.length) lines.push('待验证假设：', ...artifact.hypotheses.map(value => `- ${value}`));
    if (artifact.reproduction) lines.push(`复现情况：${artifact.reproduction}`);
    if (artifact.rootCause) lines.push(`原因：${artifact.rootCause}`);
    if (artifact.impact) lines.push(`影响：${artifact.impact}`);
    if (artifact.proposedChanges.length) lines.push('建议调整：', ...artifact.proposedChanges.map(value => `- ${value}`));
  }
  if (artifact?.stage === 'review') {
    lines.push(`审查结论：${artifact.verdict}`);
    if (artifact.findings.length) lines.push('发现的问题：', ...artifact.findings.map(finding =>
      `- ${finding.severity} · ${finding.title} · ${finding.path}${finding.line ? `:${finding.line}` : ''}\n  触发条件：${finding.trigger}\n  证据：${finding.evidence}\n  建议：${finding.recommendation}`));
  }
  const evidence = artifact?.evidence ?? job.result?.evidence ?? [];
  if (evidence.length) lines.push('证据：', ...evidence.map(item => `- ${item.source}：${item.detail}`));
  const nextSteps = artifact?.nextSteps ?? job.result?.nextSteps ?? [];
  if (artifact && 'blockers' in artifact && artifact.blockers.length)
    lines.push('阻塞原因：', ...artifact.blockers.map(value => `- ${value}`));
  if (artifact && 'limitations' in artifact && artifact.limitations.length)
    lines.push('限制：', ...artifact.limitations.map(value => `- ${value}`));
  if (artifact && 'changes' in artifact && artifact.changes.length)
    lines.push('改动：', ...artifact.changes.map(value => `- ${value}`));
  if (artifact && 'acceptanceCriteria' in artifact && artifact.acceptanceCriteria.length)
    lines.push('验收条件：', ...artifact.acceptanceCriteria.map(value => `- ${value}`));
  const tests = artifact && 'tests' in artifact ? artifact.tests : job.result?.tests ?? [];
  if (tests.length) lines.push('检查记录：', ...tests.map(item => `- ${item.command} · ${item.status}：${item.output}`));
  if (nextSteps.length) lines.push('后续步骤：', ...nextSteps.map(value => `- ${value}`));
  if (job.error) lines.push(`执行错误：${job.error}`);
  return lines.join('\n\n');
}
