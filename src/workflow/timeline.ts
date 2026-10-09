import type { Issue, Job } from "../core/types.ts";
import type { ProcessingCase, ProcessingEvent } from "../domain/processing.ts";
import type {
  ProcessingTimeline,
  TimelineNode,
  TimelineStage,
} from "../domain/timeline.ts";
import type { WorkflowActions } from "../workflow/actions.ts";
import {
  actionLabel,
  jobNodeState,
  stageLabel,
  taskProfile,
  templateStages,
} from "../workflow/presentation.ts";

/** Pure read projection. Never dispatch, replay, publish or prepare a workspace. */
export function projectTimeline(
  issue: Issue,
  state: ProcessingCase,
  jobs: Job[],
  events: ProcessingEvent[],
  actions?: WorkflowActions,
  historical = false,
): ProcessingTimeline {
  const history = jobs.filter(
    (j) =>
      j.issueId === issue.id &&
      (j.caseId === state.id || (!j.caseId && state.cycle === 1)),
  );
  const ordered = [...history].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const latest = [...ordered].reverse();
  const currentJob =
    history.find((j) => j.id === state.currentRunId) ??
    (state.currentRunId ? undefined : latest[0]);
  // Recommend an existing legal re-review action for evidence-only investigations.
  const sourceReview = history.find(
    (j) => j.id === currentJob?.sourceJobId && j.kind === "review",
  );
  if (
    issue.type === "pr" &&
    currentJob?.kind === "investigate" &&
    sourceReview &&
    !Object.values(sourceReview.findingDecisions ?? {}).includes("accepted")
  ) {
    const reReview = actions?.stages.find((a) => a.kind === "review");
    if (reReview) actions = { ...actions!, primary: reReview };
  }
  const profile = taskProfile(issue, latest);
  const nodes: TimelineNode[] = [];
  const add = (stage: TimelineStage): TimelineNode => {
    const existing = nodes.find((n) => n.stage === stage);
    if (existing) return existing;
    const attempts = ordered.filter((j) => j.kind === stage);
    const last = attempts.at(-1);
    const node: TimelineNode = {
      id: `${state.id}:${stage}`,
      stage,
      label: stageLabel(stage, issue, profile.category),
      ...(last
        ? jobNodeState(last)
        : { status: "future" as const, result: "可能下一步" }),
      attemptIds: attempts.map((j) => j.id),
      waits: [],
      conditions: [],
      occurredAt: attempts[0]?.createdAt,
    };
    nodes.push(node);
    return node;
  };
  // First appearances are ordered by actual run/decision times, not by a template.
  const appearances: { stage: TimelineStage; at: string }[] = ordered.map(
    (j) => ({ stage: j.kind, at: j.createdAt }),
  );
  for (const e of events)
    if (e.payload.type === "decision.recorded")
      appearances.push({ stage: "decision", at: e.receivedAt });
  for (const e of events)
    if (e.payload.type === "publication.confirmed")
      appearances.push({ stage: "track", at: e.receivedAt });
  appearances
    .sort((a, b) => a.at.localeCompare(b.at))
    .forEach((a) => {
      const node = add(a.stage);
      node.occurredAt ??= a.at;
    });
  const delivered = events.filter(
    (e) => e.payload.type === "publication.confirmed",
  );
  if (delivered.length) {
    const track = add("track");
    track.attemptIds = [
      ...new Set(
        delivered.flatMap((e) => {
          const payload = e.payload;
          return payload.type === "publication.confirmed" &&
            history.some((j) => j.id === payload.runId)
            ? [payload.runId]
            : [];
        }),
      ),
    ];
    track.status = "saved";
    track.result = "交付已记录";
  }
  for (const event of events) {
    if (event.payload.type !== "decision.recorded") continue;
    const phase = event.payload.phase;
    Object.assign(add("decision"), {
      status: ["accepted", "answered"].includes(phase) ? "saved" : "waiting",
      result:
        (
          {
            accepted: "范围已确认",
            decision: "等待维护者确认",
            needs_info: "等待补充信息",
            deferred: "已暂缓",
            answered: "答复已记录",
          } as Record<string, string>
        )[phase] ?? "决定已记录",
    });
  }
  const terminal = ["completed", "cancelled"].includes(state.lifecycle);
  const planDecision =
    ["decision", "accepted", "needs_info", "deferred"].includes(state.phase) &&
    issue.type === "issue" &&
    profile.category !== "question";
  const reviewDecision =
    currentJob?.artifactState !== "stale" &&
    ((issue.type === "pr" &&
      currentJob?.kind === "review" &&
      currentJob.artifact?.stage === "review" &&
      currentJob.artifact.verdict === "no_findings") ||
      (issue.type === "issue" &&
        profile.category === "question" &&
        currentJob?.kind === "investigate" &&
        !!currentJob.result)) &&
    !!currentJob &&
    ["completed", "awaiting_review"].includes(currentJob.status);
  const currentStage: TimelineStage =
    terminal ||
    state.phase === "track" ||
    state.phase === "closed" ||
    state.phase === "answered"
      ? "track"
      : planDecision || reviewDecision || currentJob?.artifactState === "stale"
        ? "decision"
        : (currentJob?.kind ?? (issue.type === "pr" ? "preflight" : "triage"));
  const current = add(currentStage);
  if (currentJob?.artifactState === "stale" && !terminal)
    Object.assign(current, {
      label: "重新评估",
      status: "waiting",
      result: "输入已更新",
    });
  if (!currentJob && current.status === "future") current.result = "待开始";
  if (planDecision && currentJob?.artifactState !== "stale")
    Object.assign(current, {
      status: issue.plan?.decision === "accepted" ? "saved" : "waiting",
      result:
        issue.plan?.decision === "accepted" ? "范围已确认" : "等待范围确认",
    });
  if (currentJob && current.stage === currentJob.kind)
    Object.assign(current, jobNodeState(currentJob));
  if (reviewDecision)
    Object.assign(current, {
      status: "waiting",
      result: "等待维护者检查审查结论",
    });
  if (currentStage === "track" && !terminal)
    Object.assign(current, { status: "waiting", result: "等待远端进度" });
  if (terminal)
    Object.assign(current, {
      status: "completed",
      result: issue.merged
        ? "远端已合并"
        : state.phase === "answered"
          ? "答复已记录"
          : state.lifecycle === "cancelled"
            ? "处理已取消"
            : "处理已结束",
    });
  const waits = state.waits.filter((w) => w.state === "open");
  for (const wait of waits) {
    const source = history.find((j) => j.id === wait.requestedByRunId);
    const node =
      wait.type === "approval" ? current : source ? add(source.kind) : current;
    node.waits.push(wait);
    if (
      !terminal &&
      !(
        wait.type === "approval" &&
        (node.status === "blocked" || currentJob?.artifactState === "stale")
      )
    ) {
      node.status = "waiting";
      node.result = {
        user_input: "等待补充输入",
        environment_ready: "等待环境准备",
        host_permission: "等待宿主审批",
        author_revision: "等待作者修订",
        ci_completion: "等待 CI",
        reporter_reply: "等待作者回复",
        approval: "等待维护者确认",
      }[wait.type];
    }
  }
  if (state.lifecycle === "deferred")
    Object.assign(current, { status: "waiting", result: "已暂缓" });
  const draft = issue.draft ?? currentJob?.prContext?.draft ?? false;
  const route = templateStages(issue, profile.category);
  if (!terminal && state.lifecycle !== "deferred" && !historical) {
    const nextKind = actions?.primary?.kind;
    if (nextKind && !nodes.some((n) => n.stage === nextKind)) {
      const n = add(nextKind);
      n.result = actions!.primary!.enabled ? "待开始" : "等待条件满足";
      n.conditions = actions!.primary!.blockedReasons;
    }
    if (
      currentJob?.artifactState === "stale" &&
      nextKind &&
      nodes.some((n) => n.stage === nextKind && n.attemptIds.length)
    )
      nodes.push({
        id: `${state.id}:${nextKind}:next`,
        stage: nextKind,
        label: `重新${stageLabel(nextKind, issue, profile.category)}`,
        status: "future",
        result: "待重新执行",
        attemptIds: [],
        waits: [],
        conditions: [
          "依据当前输入重新执行，旧版本证据不能用于当前交付",
          ...(actions?.primary?.blockedReasons ?? []),
        ],
      });
    let anchor = nextKind
      ? route.indexOf(nextKind)
      : route.indexOf(currentStage);
    if (anchor < 0)
      anchor =
        route.indexOf(issue.type === "pr" ? "review" : "investigate") - 1;
    for (const stage of route.slice(anchor + 1)) add(stage);
    if (
      currentStage === "investigate" &&
      issue.type === "pr" &&
      nodes.some((n) => n.stage === "review" && n.attemptIds.length)
    ) {
      const reReview = actions?.stages.find((a) => a.kind === "review");
      const forecast: TimelineNode = {
        id: `${state.id}:review:next`,
        stage: "review",
        label: "复审",
        status: "future",
        result: "可能下一步",
        attemptIds: [],
        waits: [],
        conditions: [
          "调查结果保存且 PR 版本仍有效后，重新审查",
          ...(reReview?.blockedReasons ?? []),
        ],
      };
      const position = nodes.findIndex((n) => n.status === "future");
      nodes.splice(position < 0 ? nodes.length : position, 0, forecast);
    }
  }
  for (const n of nodes.filter((n) => n.status === "future")) {
    n.conditions = n.conditions.length
      ? n.conditions
      : n.stage === "decision"
        ? ["先完成前序调查或审查，核对目标、范围与证据"]
        : n.stage === "track"
          ? ["维护者确认产物后，预览并确认交付；发布后跟踪远端活动"]
          : ["前序阶段完成且输入版本仍有效后，按服务端条件继续"];
    if (draft && (n.stage === "decision" || n.stage === "track"))
      n.conditions.push(
        "当前 PR 是 Draft，需核对作者的暂缓条件；审查完成不代表可以合并",
      );
  }
  const control = actions?.controls?.[0];
  const next = historical
    ? "历史周期仅供查看"
    : terminal
      ? "处理已结束，历史记录可继续查看"
      : state.lifecycle === "deferred"
        ? "事项已暂缓，需要记录恢复决定"
        : control?.kind === "cancel"
          ? "等待当前阶段结束，可查看执行记录或停止任务"
          : control
            ? `${control.label}${control.blockedReasons.length ? `：${control.blockedReasons.join("；")}` : ""}`
            : actions?.primary
              ? `${actionLabel(actions.primary.kind, issue, currentJob)}${actions.primary.enabled ? "" : `：${actions.primary.blockedReasons.join("；")}`}`
              : current.status === "future" && profile.category === "unknown"
                ? "完成分类后确定后续路径"
                : "检查阶段结论、覆盖范围与限制，再记录维护者决定";
  return {
    issueId: issue.id,
    caseId: state.id,
    version: state.version,
    cycle: state.cycle,
    historical,
    currentNodeId: current.id,
    currentRunId: currentJob?.id,
    profile,
    nodes,
    events: events.slice(-100),
    eventTotal: events.length,
    actions: historical ? undefined : actions,
    reason: currentJob
      ? state.reason.replace(
          new RegExp(`^${currentJob.kind}\\s`),
          `${stageLabel(currentJob.kind, issue, profile.category)} `,
        )
      : state.reason,
    draft,
    next,
  };
}
