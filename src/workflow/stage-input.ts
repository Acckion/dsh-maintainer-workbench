import { scopeResolved, stepResolved } from "./manual.ts";
import { planBlocker } from "../core/issue-flow.ts";
import { kindNames, type Issue, type Job, type JobKind } from "../core/types.ts";

export interface StageInput {
  required: boolean;
  reasons: string[];
  warnings: string[];
  missingDependencies: JobKind[];
}

/** Dependencies provide context, never permission to start another stage. */
export function stageDependencies(issue: Issue, kind: JobKind): JobKind[][] {
  const analysis: JobKind = issue.type === "pr" ? "preflight" : "triage";
  switch (kind) {
    case "investigate": return [[analysis]];
    case "fix": case "docs": return [["investigate"]];
    case "validate": return [["fix", "docs"]];
    case "review": return [issue.type === "pr" ? ["preflight", "validate"] : ["validate"]];
    case "ci": return [["preflight", "review"]];
    default: return [];
  }
}

export function usableStageResult(issue: Issue, job: Job): boolean {
  return job.issueId === issue.id && job.repoId === issue.repoId &&
    (!issue.processing || (job.caseId ? job.caseId === issue.processing.id : issue.processing.cycle === 1)) &&
    job.artifactState !== "stale" && !!job.result &&
    ["completed", "awaiting_review", "approved"].includes(job.status);
}

export function stageInput(
  issue: Issue,
  kind: JobKind,
  history: Job[] = [],
): StageInput {
  const missing = stageDependencies(issue, kind).filter(group =>
    !group.some(stage => stepResolved(issue.processing, stage)) &&
    !history.some(job => group.includes(job.kind) && usableStageResult(issue, job)),
  );
  const warnings = missing.map(group =>
    `依赖节点「${group.map(k => kindNames[k]).join(" / ")}」尚无当前版本的可用执行结果。可以独立执行，但必须补充本节点的目标、范围和必要背景。`,
  );
  const reasons = [...warnings];
  const planGap = planBlocker(issue, kind);
  if (planGap) reasons.push(planGap);
  if (!scopeResolved(issue) && ["fix", "docs"].includes(kind) && issue.plan?.decision === "accepted" &&
    issue.processing?.planSourceFingerprint &&
    issue.processing.planSourceFingerprint !== issue.processing.sourceFingerprint)
    reasons.push("输入已变化，请重新确认目标、范围与验收条件，并补充本次执行依据。");
  for (const wait of issue.processing?.waits ?? [])
    if (wait.state === "open" && wait.type === "user_input") reasons.push(wait.reason);
  if (issue.informationRequests?.some(request => request.state === "asked"))
    reasons.push("已有追问尚未收到新回复，请补充当前节点所需的信息；独立执行不会自动结束原有追问。");
  const dependencies = stageDependencies(issue, kind).flat();
  for (const dependency of new Set(dependencies)) {
    const result = history.filter(job => job.kind === dependency && usableStageResult(issue, job))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.result;
    if (result?.missingInfo.length)
      reasons.push(`${kindNames[dependency]}记录的信息缺口：${result.missingInfo.join("；")}`);
  }
  return {
    required: reasons.length > 0,
    reasons,
    warnings,
    missingDependencies: missing.flat(),
  };
}

/** Choose useful evidence, without coupling dispatch to the preceding stage. */
export function stageSource(issue: Issue, kind: JobKind, history: Job[]): Job | undefined {
  const available = history.filter(job => usableStageResult(issue, job))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (["triage", "preflight"].includes(kind)) return;
  if (["validate", "review"].includes(kind))
    return available.find(job => !!job.patch && ["fix", "docs", "validate"].includes(job.kind));
  return available.find(job => ["triage", "preflight", "investigate", "review"].includes(job.kind));
}
