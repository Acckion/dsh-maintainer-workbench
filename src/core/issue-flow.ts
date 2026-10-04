import { z } from 'zod';
import type { InformationRequest, Issue, IssuePlan, Job, JobKind } from './types.ts';

export const issuePlanSchema = z.object({
  category: z.enum(['bug', 'feature', 'docs', 'question', 'maintenance']),
  goal: z.string().trim().max(2000), reproduction: z.string().trim().max(4000),
  expected: z.string().trim().max(2000), actual: z.string().trim().max(2000), scope: z.string().trim().max(2000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(20), decision: z.enum(['proposed', 'accepted', 'deferred']),
});
export const categoryNames = { bug: '缺陷', feature: '功能请求', docs: '文档', question: '使用提问', maintenance: '维护任务' };
export function defaultPlan(issue: Issue): IssuePlan {
  return issue.plan ?? { category: issue.analysis?.category ?? 'bug', goal: '', reproduction: '', expected: '', actual: '', scope: '', acceptanceCriteria: [], decision: 'proposed' };
}
export function planBlocker(issue: Issue, kind: JobKind): string | undefined {
  const plan = issue.plan;
  if (!['fix', 'docs'].includes(kind)) return;
  if (!plan) return issue.analysis?.category === 'feature' ? '功能请求实施前，请先保存需求目标、范围和验收条件，并记录维护者取舍。' : undefined;
  if (plan.category === 'question') return '使用提问请先准备答复；若需代码变更，请先明确转换后的事项类型。';
  if (plan.decision !== 'accepted') return '请先接受此事项的目标和范围，再实施变更。';
  if (!plan.goal || !plan.acceptanceCriteria.length) return '实施前请补齐目标和至少一项验收条件。';
  if (plan.category === 'bug' && (!plan.reproduction || !plan.expected || !plan.actual)) return '缺陷实施前请记录复现条件、预期和实际行为；不能复现时先调查。';
  if (plan.category === 'docs' && kind === 'fix') return '文档事项请使用文档维护短路径。';
}
export function nextIssueStage(issue: Issue, job?: Job): JobKind | undefined {
  if (issue.workflow?.stage === 'answered' || issue.workflow?.stage === 'deferred') return;
  if (issue.informationRequests?.some(r => r.state === 'reply_received')) return 'triage';
  if (issue.informationRequests?.some(r => r.state === 'asked')) return;
  const category = issue.plan?.category ?? issue.analysis?.category;
  if (category === 'question') return job?.result ? undefined : 'triage';
  if (!job?.artifact || job.artifact.stage === 'triage' || job.artifact.stage === 'investigate') {
    if (issue.plan?.decision === 'accepted') return category === 'docs' ? 'docs' : 'fix';
  }
}
export function sameQuestions(request: InformationRequest, questions: string[], waitingFor: string): boolean {
  const normalize = (values: string[]) => [...new Set(values.map(s => s.trim().replace(/\s+/g, ' ').toLowerCase()))].sort().join('\n');
  return ['asked', 'reply_received'].includes(request.state) && request.waitingFor.toLowerCase() === waitingFor.toLowerCase() && normalize(request.questions) === normalize(questions);
}
export function receiveReplies(request: InformationRequest, replies: InformationRequest['replies'], partial: boolean, now = new Date().toISOString()): InformationRequest {
  if (!['asked', 'reply_received'].includes(request.state)) return request;
  const fresh = replies.filter(reply => reply.author.toLowerCase() === request.waitingFor.toLowerCase() && Date.parse(reply.createdAt) > Date.parse(request.askedAt));
  const combined = [...new Map([...request.replies, ...fresh].map(reply => [reply.id, reply])).values()].slice(-100);
  return { ...request, replies: combined, state: combined.length ? 'reply_received' : request.state, checkedAt: now, warning: partial ? '只读取最近 100 条更新评论，较早内容可能未覆盖。' : undefined };
}
export function issuePromptContext(issue: Issue): unknown {
  const active = (issue.informationRequests ?? []).filter(r => ['asked','reply_received'].includes(r.state));
  const closed = (issue.informationRequests ?? []).filter(r => !['asked','reply_received'].includes(r.state));
  const selected = [...closed.slice(-4), ...active.slice(-8)];
  return { ...issue, informationRequests: selected.map(request => ({ ...request, questions: request.questions.slice(0, 8), replies: request.replies.slice(-3).map(reply => ({ ...reply, body: reply.body.slice(0, 1000) })) })), informationCoverage: '最多最近 4 条结束和 8 条活跃追问，每条最多 8 个问题、3 条回复摘要；未覆盖的记录不可推断为不存在。' };
}
export function issueTaskGuidance(issue: Issue): string {
  const category = issue.plan?.category ?? issue.analysis?.category;
  return `Issue plan and informationRequests are explicit maintainer context. Respect accepted scope and acceptance criteria. Do not repeat questions already asked; new replies are evidence to reassess, not proof that all missing information is supplied. ${category === 'bug' ? 'For a bug, establish reproduction conditions, expected versus actual behavior and before/after regression evidence. If unreproducible, state the blocker.' : category === 'feature' ? 'For a feature, follow the maintainer decision, scope exclusions and acceptance criteria; do not invent requirements or require a pre-existing failing test.' : category === 'docs' ? 'Use the short documentation path: inspect the specified pages/examples, modify only the accepted scope, and run relevant documentation checks.' : category === 'question' ? 'Prepare a source-backed answer draft; do not implement code, close the Issue or publish automatically.' : 'Use evidence to establish the appropriate issue-specific path.'}`;
}
