import { planBlocker } from "../core/issue-flow.ts";
import type { Issue, Job, JobKind } from "../core/types.ts";
import { kindNames } from "../core/types.ts";
import { validationState } from "../core/workflow-state.ts";

export interface WorkflowAction {
  kind: JobKind;
  label: string;
  enabled: boolean;
  blockedReasons: string[];
  sourceJobId?: string;
}
export interface WorkflowActions {
  controls?: {
    kind: "cancel" | "retry" | "resume" | "prepare";
    runId: string;
    label: string;
    enabled: boolean;
    blockedReasons: string[];
  }[];
  primary?: WorkflowAction;
  stages: WorkflowAction[];
  expectedVersion?: number;
}

export function stageBlocker(
  issue: Issue,
  kind: JobKind,
  source?: Job,
): string | undefined {
  if (issue.state === "closed") return "已关闭记录不可派发任务";
  if (
    issue.processing?.lifecycle === "completed" ||
    issue.processing?.lifecycle === "cancelled"
  )
    return "处理已结束，请先记录恢复决定";
  if (issue.processing?.lifecycle === "deferred")
    return "事项已暂缓，请先记录恢复决定";
  if (issue.processing?.phase === "answered")
    return "答复已记录，请先恢复处理后再启动任务";
  if (
    issue.processing?.waits.some(
      (w) => w.state === "open" && w.type === "user_input",
    )
  )
    return "等待用户补充输入，请先回答当前请求";
  if (
    issue.processing?.waits.some(
      (w) => w.state === "open" && w.type === "environment_ready",
    ) &&
    !["triage", "preflight"].includes(kind)
  )
    return "等待仓库环境准备";
  if (issue.informationRequests?.some((r) => r.state === "asked"))
    return "补充信息尚未收到新回复，请先核对或结束已有追问";
  if (kind === "triage" && issue.type === "pr")
    return "PR 请使用变更预检，不执行 Issue 分诊";
  if (
    (["preflight", "ci"].includes(kind) || (kind === "review" && !source)) &&
    issue.type !== "pr"
  )
    return "PR 审查只能选择 Pull Request";
  if (
    ["fix", "docs"].includes(kind) &&
    issue.plan?.decision === "accepted" &&
    issue.processing?.planSourceFingerprint &&
    issue.processing.planSourceFingerprint !==
      issue.processing.sourceFingerprint
  )
    return "输入已变化，请重新确认目标、范围与验收条件";
  return planBlocker(issue, kind);
}

/** The server attaches this projection; UI renders it without inventing transitions. */
export function availableActions(
  issue: Issue,
  job?: Job,
  history: Job[] = [],
): WorkflowActions {
  const category = issue.plan?.category ?? issue.analysis?.category;
  const artifact = job?.artifact;
  let primary: JobKind | undefined;
  if (!job || !job.result)
    primary = issue.origin
      ? undefined
      : issue.type === "pr"
        ? "preflight"
        : "triage";
  else if (job.artifactState === "stale")
    primary = issue.origin
      ? "investigate"
      : issue.type === "pr"
        ? "preflight"
        : "triage";
  else if (artifact?.stage === "triage") {
    primary =
      artifact.route === "implement"
        ? category === "docs"
          ? "docs"
          : "fix"
        : artifact.route === "investigate" || artifact.route === "answer"
          ? "investigate"
          : undefined;
    if (issue.plan?.decision === "accepted" && category !== "question")
      primary = category === "docs" ? "docs" : "fix";
  } else if (artifact?.stage === "preflight")
    primary = artifact.readiness === "blocked" ? undefined : "review";
  else if (job.kind === "investigate")
    primary =
      category === "question"
        ? undefined
        : category === "docs" || issue.origin
          ? "docs"
          : "fix";
  else if (["fix", "docs"].includes(job.kind))
    primary = job.patch ? "validate" : undefined;
  else if (artifact?.stage === "validate") {
    const state = validationState(artifact)?.state;
    const sourceDocs =
      job.handoff?.find((h) => h.id === job.sourceJobId)?.kind === "docs";
    primary =
      state === "passed"
        ? "review"
        : state === "failed"
          ? sourceDocs || category === "docs" || issue.origin
            ? "docs"
            : "fix"
          : "validate";
  } else if (artifact?.stage === "review") {
    primary =
      Object.values(job.findingDecisions ?? {}).includes("accepted") ||
      job.findingFollowups?.some((f) => f.status === "still_present")
        ? category === "docs"
          ? "docs"
          : "fix"
        : artifact.verdict === "incomplete" ||
            Object.values(job.findingDecisions ?? {}).includes("needs_evidence")
          ? "investigate"
          : undefined;
  } else if (job.kind === "ci") primary = "investigate";
  else
    primary =
      issue.type === "pr"
        ? "review"
        : !issue.analysis
          ? "triage"
          : category === "question"
            ? "investigate"
            : category === "feature"
              ? undefined
              : "investigate";
  if (
    issue.type === "issue" &&
    issue.plan?.decision === "accepted" &&
    category !== "question" &&
    (issue.processing?.phase === "accepted" || !job)
  )
    primary = category === "docs" ? "docs" : "fix";
  if (issue.informationRequests?.some((r) => r.state === "reply_received"))
    primary = "triage";
  if (
    job &&
    ["failed", "cancelled", "rejected"].includes(job.status) &&
    job.artifactState !== "stale"
  )
    primary = undefined;
  if (
    issue.processing &&
    ["completed", "cancelled", "deferred"].includes(issue.processing.lifecycle)
  )
    primary = undefined;
  const validSource =
    job?.result &&
    job.artifactState !== "stale" &&
    ["completed", "awaiting_review", "approved"].includes(job.status)
      ? job
      : undefined;
  const kinds: JobKind[] =
    issue.type === "pr"
      ? ["preflight", "review", "ci", "investigate", "fix", "docs", "validate"]
      : [
          "triage",
          "investigate",
          "fix",
          "docs",
          ...(validSource?.patch ? (["validate", "review"] as JobKind[]) : []),
        ];
  const labels: Partial<Record<JobKind, string>> = {
    triage: "分析此 Issue",
    preflight: "快速预检",
    review: issue.type === "pr" ? "审查此 PR" : "审查最终补丁",
    investigate: category === "question" ? "准备有依据的答复" : "调查并修复",
    fix: category === "feature" ? "确认并实现" : "开始修复",
    docs: "检查并更新",
    validate: "验证改动",
  };
  const stages = kinds.map((kind) => {
    const blockers = [
      stageBlocker(issue, kind, validSource),
      history.some((j) => ["running", "queued"].includes(j.status))
        ? "当前事项已有排队或运行中的任务"
        : undefined,
    ].filter((s): s is string => !!s);
    return {
      kind,
      label: labels[kind] ?? kindNames[kind],
      enabled: !blockers.length,
      blockedReasons: blockers,
      sourceJobId: validSource?.id,
    };
  });
  const controls: NonNullable<WorkflowActions["controls"]> = [];
  const active = history.find((j) => ["running", "queued"].includes(j.status));
  if (active)
    controls.push({
      kind: "cancel",
      runId: active.id,
      label: "停止任务",
      enabled: true,
      blockedReasons: [],
    });
  else if (job && ["failed", "cancelled", "rejected"].includes(job.status))
    controls.push({
      kind: "retry",
      runId: job.id,
      label: "重试任务",
      enabled:
        job.artifactState !== "stale" &&
        issue.state === "open" &&
        issue.processing?.lifecycle !== "deferred",
      blockedReasons:
        job.artifactState === "stale"
          ? ["旧版本任务不能重试，请对当前版本重新派发"]
          : issue.processing?.lifecycle === "deferred"
            ? ["事项已暂缓"]
            : [],
    });
  else if (
    job &&
    ["waiting_input", "waiting_environment"].includes(job.status) &&
    job.artifactState !== "stale"
  ) {
    const waits =
      issue.processing?.waits.filter(
        (w) =>
          w.requestedByRunId === job.id &&
          w.type ===
            (job.status === "waiting_input"
              ? "user_input"
              : "environment_ready"),
      ) ?? [];
    if (
      waits.length &&
      waits.every((w) => ["open", "satisfied"].includes(w.state))
    ) {
      const ready = waits.every((w) => w.state === "satisfied");
      controls.push({
        kind:
          job.status === "waiting_environment" && !ready ? "prepare" : "resume",
        runId: job.id,
        label:
          job.status === "waiting_environment"
            ? ready
              ? "环境已准备，继续任务"
              : "准备仓库环境"
            : ready
              ? "根据补充信息继续"
              : "等待填写补充信息",
        enabled: ready || job.status === "waiting_environment",
        blockedReasons: ready
          ? []
          : waits.filter((w) => w.state === "open").map((w) => w.reason),
      });
    }
  }
  return {
    controls,
    primary: stages.find((action) => action.kind === primary),
    stages,
    expectedVersion: issue.processing?.version,
  };
}
