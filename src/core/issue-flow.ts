import { z } from "zod";
import type { InformationRequest, Issue, IssuePlan, JobKind } from "./types.ts";

export const issuePlanSchema = z.object({
  category: z.enum(["bug", "feature", "docs", "question", "maintenance"]),
  goal: z.string().trim().max(2000),
  reproduction: z.string().trim().max(4000),
  expected: z.string().trim().max(2000),
  actual: z.string().trim().max(2000),
  scope: z.string().trim().max(2000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(20),
  decision: z.enum(["proposed", "accepted", "deferred"]),
});
export const categoryNames = {
  bug: "缺陷",
  feature: "功能请求",
  docs: "文档",
  question: "使用提问",
  maintenance: "维护任务",
};
export function defaultPlan(issue: Issue): IssuePlan {
  return (
    issue.plan ?? {
      category: issue.analysis?.category ?? "bug",
      goal: "",
      reproduction: "",
      expected: "",
      actual: "",
      scope: "",
      acceptanceCriteria: [],
      decision: "proposed",
    }
  );
}
export function readOnlyScope(scope:string):boolean {
  return /不(?:修改文件|改文件|实施修复|实施变更)|仅.{0,12}(?:只读|整理.*信息)|read[- ]only|do not (?:modify|edit)/i.test(scope);
}
export function unknownFact(value:string):boolean {
 return !value.trim() || /尚未提供|尚未记录|无法复现|未能复现|待(?:报告者|补充|确认)|未知|不清楚|暂不清楚|not (?:provided|known|reproducible)|unknown/i.test(value);
}
export function planBlocker(issue: Issue, kind: JobKind): string | undefined {
  const plan = issue.plan;
  if (!["fix", "docs"].includes(kind)) return;
  if (!plan)
    return issue.analysis?.category === "question"
      ? "使用提问请先准备答复；若需代码变更，请先明确转换后的事项类型。"
      : issue.analysis?.category === "feature"
        ? "功能请求实施前，请先保存需求目标、范围和验收条件，并记录维护者取舍。"
        : undefined;
  if (readOnlyScope(plan.scope)) return "此计划仅授权只读调查，不能进入修复或文档修改；请先调查，实施需确认新范围。";
  if (plan.category === "question")
    return "使用提问请先准备答复；若需代码变更，请先明确转换后的事项类型。";
  if (plan.decision !== "accepted")
    return "请先接受此事项的目标和范围，再实施变更。";
  if (!plan.goal || !plan.acceptanceCriteria.length)
    return "实施前请补齐目标和至少一项验收条件。";
  if (
    plan.category === "bug" &&
    (unknownFact(plan.reproduction) || unknownFact(plan.expected) || unknownFact(plan.actual))
  )
    return "缺陷实施前请记录复现条件、预期和实际行为；不能复现时先调查。";
  if (plan.category === "docs" && kind === "fix")
    return "文档事项请使用文档维护短路径。";
}
export function sameQuestions(
  request: InformationRequest,
  questions: string[],
  waitingFor: string,
): boolean {
  const normalize = (values: string[]) =>
    [...new Set(values.map((s) => s.trim().replace(/\s+/g, " ").toLowerCase()))]
      .sort()
      .join("\n");
  return (
    ["asked", "reply_received"].includes(request.state) &&
    request.waitingFor.toLowerCase() === waitingFor.toLowerCase() &&
    normalize(request.questions) === normalize(questions)
  );
}
export function receiveReplies(
  request: InformationRequest,
  replies: InformationRequest["replies"],
  partial: boolean,
  now = new Date().toISOString(),
): InformationRequest {
  if (!["asked", "reply_received"].includes(request.state)) return request;
  const fresh = replies.filter(
    (reply) =>
      reply.author.toLowerCase() === request.waitingFor.toLowerCase() &&
      Date.parse(reply.createdAt) > Date.parse(request.askedAt),
  );
  const combined = [
    ...new Map(
      [...request.replies, ...fresh].map((reply) => [reply.id, reply]),
    ).values(),
  ].slice(-100);
  return {
    ...request,
    replies: combined,
    state: combined.length ? "reply_received" : request.state,
    checkedAt: now,
    warning: partial
      ? "只读取最近 100 条更新评论，较早内容可能未覆盖。"
      : undefined,
  };
}
export function issuePromptContext(issue: Issue): unknown {
  const active = (issue.informationRequests ?? []).filter((r) =>
    ["asked", "reply_received"].includes(r.state),
  );
  const closed = (issue.informationRequests ?? []).filter(
    (r) => !["asked", "reply_received"].includes(r.state),
  );
  const selected = [...closed.slice(-4), ...active.slice(-8)];
  const { processing, actionsAvailable, ...source } = issue;
  return {
    ...source,
    processing: processing
      ? {
          phase: processing.phase,
          lifecycle: processing.lifecycle,
          waits: processing.waits.filter((w) => w.state === "open").slice(-12),
        }
      : undefined,
    providedInputs: processing?.waits.filter(w=>w.targetFingerprint===processing.sourceFingerprint && !['cancelled','superseded'].includes(w.state) && w.answers).slice(-3).map(w=>({waitId:w.id,sourceRunId:w.requestedByRunId,questions:w.questions?.slice(0,8),answers:Object.fromEntries(Object.entries(w.answers ?? {}).slice(0,8).map(([id,a])=>[id,{...a,value:a.value.slice(0,500)}])),coverage:"最多最近3个请求、每项8个字段、每个值500字符；完整资料保存在输入记录中",note:'用户提供的资料状态，未知项尚未解决；这些答复不是测试或运行验证证据'})),
    informationRequests: selected.map((request) => ({
      ...request,
      questions: request.questions.slice(0, 8),
      replies: request.replies
        .slice(-3)
        .map((reply) => ({ ...reply, body: reply.body.slice(0, 1000) })),
    })),
    informationCoverage:
      "最多最近 4 条结束和 8 条活跃追问，每条最多 8 个问题、3 条回复摘要；未覆盖的记录不可推断为不存在。",
  };
}
export function issueTaskGuidance(issue: Issue): string {
  const category = issue.plan?.category ?? issue.analysis?.category;
  return `Issue plan and informationRequests are explicit maintainer context. Respect accepted scope and acceptance criteria. Do not repeat questions already asked; new replies are evidence to reassess, not proof that all missing information is supplied. ${category === "bug" ? "For a bug, establish reproduction conditions, expected versus actual behavior and before/after regression evidence. If unreproducible, state the blocker." : category === "feature" ? "For a feature, follow the maintainer decision, scope exclusions and acceptance criteria; do not invent requirements or require a pre-existing failing test." : category === "docs" ? "Use the short documentation path: inspect the specified pages/examples, modify only the accepted scope, and run relevant documentation checks." : category === "question" ? "Prepare a source-backed answer draft; do not implement code, close the Issue or publish automatically." : "Use evidence to establish the appropriate issue-specific path."}`;
}
