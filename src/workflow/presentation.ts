import {
  kindNames,
  type Issue,
  type Job,
  type JobKind,
} from "../core/types.ts";
import type { ProcessingEvent } from "../domain/processing.ts";
import type {
  TaskProfile,
  TimelineStage,
  TimelineStatus,
} from "../domain/timeline.ts";
import { validationState } from "../core/workflow-state.ts";

const categories: Record<string, string> = {
  bug: "缺陷",
  feature: "功能建议",
  docs: "文档",
  question: "提问",
  maintenance: "维护",
  tests: "测试 / 夹具",
  mixed: "混合变更",
  unknown: "待分类",
};
const focus: Record<string, string[]> = {
  bug: ["复现条件与根因", "修复范围与回归证据"],
  feature: ["用户目标与范围", "兼容性与验收条件"],
  docs: ["与源码的一致性", "示例与链接"],
  question: ["引用依据", "答复准确性与未确认内容"],
  maintenance: ["行为变化与影响范围", "构建、依赖与风险"],
  tests: ["断言与隔离是否保持", "时序、重复运行及失败反证"],
  mixed: ["各模块的行为变化", "跨模块验证与兼容性"],
  unknown: ["确认变更意图", "核对范围与证据"],
};

/** Use saved evidence, never call a model solely to choose a display template. */
export function taskProfile(issue: Issue, jobs: Job[]): TaskProfile {
  const record = jobs.find((j) => j.artifactState !== "stale" && j.result);
  const classification =
    issue.plan?.category ??
    record?.result?.category ??
    issue.analysis?.category;
  const paths = [
    ...new Set(
      jobs
        .filter((j) => j.artifactState !== "stale")
        .flatMap((j) => [
          ...(j.executionRecords
            ?.map((r) => r.sourcePath)
            .filter((p): p is string => !!p) ?? []),
          ...(j.artifact?.stage === "review"
            ? (j.artifact.inspectedSources?.map((s) => s.path) ?? [])
            : []),
        ]),
    ),
  ];
  const tests =
    paths.length > 0 &&
    paths.every((p) =>
      /(?:^|\/)(?:test|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p),
    );
  const category =
    issue.type === "pr" &&
    tests &&
    (!classification || classification === "maintenance")
      ? "tests"
      : (classification ?? "unknown");
  const triage = jobs.find(
    (j) => j.artifactState !== "stale" && j.artifact?.stage === "triage",
  )?.artifact;
  const areas =
    triage?.stage === "triage" && triage.module
      ? [triage.module]
      : [
          ...new Set(
            paths.map((p) =>
              p
                .split("/")
                .slice(0, p.startsWith("src/") ? 2 : 1)
                .join("/"),
            ),
          ),
        ].slice(0, 4);
  return {
    category,
    label: categories[category] ?? categories.unknown!,
    areas,
    focus: focus[category] ?? focus.unknown!,
    provisional: issue.type === "pr" || !classification,
    basis: paths.length
      ? "依据已读取源码；完整变更范围仍需核对"
      : classification
        ? "依据已保存的分类与计划"
        : "尚无分类证据",
  };
}

export function stageLabel(
  stage: TimelineStage,
  issue: Issue,
  category: string,
): string {
  if (stage === "triage") return "分诊";
  if (stage === "preflight") return "预检";
  if (stage === "decision")
    return issue.type === "pr"
      ? "维护者确认"
      : category === "question"
        ? "答复审核"
        : "范围确认";
  if (stage === "track")
    return category === "question" ? "发布与跟踪" : "交付与跟踪";
  if (stage === "investigate")
    return issue.type === "pr"
      ? "补充调查"
      : ((
          {
            bug: "复现与定位",
            feature: "需求澄清",
            docs: "文档核对",
            question: "查证与答复",
            maintenance: "影响调查",
          } as Record<string, string>
        )[category] ?? "调查");
  if (stage === "review")
    return issue.type === "pr"
      ? ((
          {
            tests: "测试审查",
            docs: "文档审查",
            feature: "功能审查",
            bug: "缺陷审查",
          } as Record<string, string>
        )[category] ?? "变更审查")
      : category === "question"
        ? "答复审核"
        : "补丁审查";
  return (
    (
      {
        fix:
          issue.type === "pr"
            ? "修订"
            : category === "feature"
              ? "实现"
              : "修复",
        docs: "文档更新",
        validate: "验证",
        ci: "CI 诊断",
      } as Record<string, string>
    )[stage] ?? stage
  );
}

export function templateStages(
  issue: Issue,
  category: string,
): TimelineStage[] {
  if (issue.type === "pr") return ["preflight", "review", "decision", "track"];
  if (category === "question")
    return ["triage", "investigate", "decision", "track"];
  if (category === "unknown") return ["triage"];
  return [
    "triage",
    "investigate",
    "decision",
    category === "docs" ? "docs" : "fix",
    "validate",
    "review",
    "track",
  ];
}

export function jobNodeState(job: Job): {
  status: TimelineStatus;
  result: string;
} {
  if (job.artifactState === "stale")
    return { status: "stale", result: "输入版本已变化" };
  if (job.status === "running" || job.status === "queued")
    return {
      status: job.status,
      result: job.status === "running" ? "执行中" : "排队中",
    };
  if (job.status === "waiting_environment")
    return { status: "waiting", result: "等待环境准备" };
  if (job.status === "waiting_input")
    return { status: "waiting", result: "等待补充输入" };
  if (["failed", "rejected", "cancelled"].includes(job.status))
    return {
      status: "blocked",
      result: (
        {
          failed: "执行失败",
          rejected: "已退回",
          cancelled: "已停止",
        } as Record<string, string>
      )[job.status]!,
    };
  const validation = validationState(job.artifact);
  if (job.artifact?.stage === "preflight")
    return {
      status: job.artifact.readiness === "blocked" ? "blocked" : "saved",
      result:
        job.artifact.readiness === "blocked"
          ? "预检有阻塞"
          : job.artifact.readiness === "draft"
            ? "Draft，继续核对条件"
            : "可以继续深入审查",
    };
  if (validation)
    return {
      status: validation.state === "passed" ? "saved" : "blocked",
      result:
        validation.state === "passed"
          ? "验证报告通过"
          : validation.state === "failed"
            ? "验证失败"
            : "验证证据不足",
    };
  if (job.artifact?.stage === "review")
    return {
      status: job.artifact.verdict === "no_findings" ? "saved" : "blocked",
      result: {
        no_findings: "未发现阻断问题",
        changes_requested: "需要修订",
        incomplete: "审查证据不足",
      }[job.artifact.verdict],
    };
  return {
    status: "saved",
    result: job.status === "approved" ? "本地产物已接受" : "结果已保存",
  };
}

export function actionLabel(kind: JobKind, issue: Issue, job?: Job): string {
  if (kind === "investigate")
    return issue.type === "pr"
      ? "补足审查证据"
      : issue.analysis?.category === "question"
        ? "准备有依据的答复"
        : issue.plan?.decision === "accepted"
          ? "按计划调查并实施"
          : "开始调查";
  if (kind === "review")
    return issue.type === "pr"
      ? job?.kind === "review" || job?.kind === "investigate"
        ? "重新审查"
        : "开始审查"
      : "审查最终产物";
  return {
    preflight: "开始预检",
    triage: "开始分诊",
    fix: issue.type === "pr" ? "实施已确认修订" : "开始实施",
    docs: "更新文档",
    validate: "验证改动",
    ci: "诊断 CI",
  }[kind];
}

export function eventDescription(event: ProcessingEvent): string {
  const p = event.payload;
  switch (p.type) {
    case "planning.recorded":
      return "处理计划与进度已保存";
    case "run.observed":
      return `${kindNames[p.kind as JobKind] ?? "阶段任务"} · ${({ queued: "已排队", running: "执行中", failed: "失败", completed: "结果已保存", awaiting_review: "等待审核", approved: "本地已接受", rejected: "已退回", cancelled: "已停止", waiting_input: "等待输入", waiting_environment: "等待环境" } as Record<string, string>)[p.status] ?? p.status}：${p.reason}`;
    case "decision.recorded":
      return `维护者已记录决定：${p.reason}`;
    case "source.observed":
      return `事项已同步：${p.merged ? "已合并" : p.state === "closed" ? "已关闭" : "开放中"}${p.headSha ? ` · ${p.headSha.slice(0, 12)}` : ""}`;
    case "input.requested":
      return `已请求补充信息：${p.wait.reason}`;
    case "input.recorded":
      return "已保存部分资料，仍有未解决项";
    case "input.submitted":
      return "补充输入已保存，等待显式继续";
    case "environment.observed":
      return `${p.ready ? "环境已准备" : "等待环境准备"}：${p.reason}`;
    case "wait.cancelled":
      return `等待已结束：${p.reason}`;
    case "publication.confirmed":
      return `交付结果已记录：${p.action}`;
    case "remote.activity":
      return `${{ ci: "CI", reviews: "远端审查", threads: "审查讨论" }[p.kind]}状态已更新`;
    case "information.observed":
      return "追问及回复状态已更新";
    case "workflow.upgraded":
      return "处理流程版本已升级，历史保留";
  }
}
