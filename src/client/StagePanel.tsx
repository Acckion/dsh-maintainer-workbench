import type { ReactNode } from "react";
import type { Issue, Job } from "../core/types.ts";
import type { ProcessingTimeline, TimelineNode } from "../domain/timeline.ts";
import { jobNodeState } from "../workflow/presentation.ts";
import type { AgentTab } from "./RepositoryDetail.tsx";

export type StageSelection = {
  nodeId?: string;
  attemptId?: string;
  view: "stage" | "plan";
  detail: "result" | "execution";
};
interface Props {
  selected: TimelineNode;
  timeline: ProcessingTimeline;
  issue: Issue;
  attempt?: Job;
  currentJob?: Job;
  history: Job[];
  readOnly: boolean;
  viewingHistory: boolean;
  selection: StageSelection;
  choose: (value: StageSelection) => void;
  render: (
    tab: AgentTab,
    job?: Job,
    readOnly?: boolean,
    decision?: boolean,
    execution?: boolean,
  ) => ReactNode;
  track: (job?: Job, readOnly?: boolean, monitoring?: boolean) => ReactNode;
  evidence?: (job?: Job) => ReactNode;
  context?: () => ReactNode;
  actions?: ReactNode;
  instructions?: ReactNode;
}
export function StagePanel({
  selected,
  timeline,
  issue,
  attempt,
  currentJob,
  history,
  readOnly,
  viewingHistory,
  selection,
  choose,
  render,
  track,
  evidence,
  context,
  actions,
  instructions,
}: Props) {
  const activeWait = !readOnly
    ? issue.processing?.waits.find(
        (w) =>
          w.state === "open" &&
          ["host_permission", "user_input", "environment_ready"].includes(
            w.type,
          ) &&
          (!w.requestedByRunId || w.requestedByRunId === attempt?.id),
      )
    : undefined;
  return (
    <section className="mw-stage-panel" aria-label="选中阶段">
      <header>
        <h3>{selected.label}</h3>
        <span
          className={`mw-tag ${selected.status === "blocked" ? "amber" : ""}`}
        >
          {activeWait
            ? (
                {
                  host_permission: "等待授权",
                  user_input: "等待补充信息",
                  environment_ready: "等待执行环境",
                } as Record<string, string>
              )[activeWait.type]
            : attempt && selected.stage === attempt.kind
              ? jobNodeState(attempt).result
              : selected.result}
        </span>
        {actions && <div className="mw-workflow-actions">{actions}</div>}
      </header>
      {viewingHistory && selected.status !== "future" && (
        <p className="mw-stage-history">
          正在查看历史阶段或尝试 · 只读 · 当前任务继续保留
        </p>
      )}
      {selected.attemptIds.length > 1 && (
        <label>
          阶段尝试
          <select
            aria-label="查看阶段尝试"
            value={attempt?.id ?? ""}
            onChange={(e) =>
              choose({
                ...selection,
                nodeId: selected.id,
                view: "stage",
                attemptId: e.target.value,
              })
            }
          >
            {selected.attemptIds.map((id, index) => {
              const j = history.find((j) => j.id === id);
              return (
                <option key={id} value={id}>
                  第 {index + 1} 次 ·{" "}
                  {j ? jobNodeState(j).result : "记录未加载"} · {j?.createdAt}
                </option>
              );
            })}
          </select>
        </label>
      )}
      {attempt?.artifactState === "stale" && (
        <p className="mw-stage-history">
          此结果对应旧版本，不能用于当前审批或交付。
        </p>
      )}
      {selection.detail === "execution" &&
        attempt &&
        !readOnly &&
        (["waiting_input", "waiting_environment"].includes(attempt.status) ||
          !!activeWait) &&
        render("work", attempt, false)}
      {selection.detail === "execution" &&
        attempt &&
        (attempt.result || attempt.artifact) &&
        ![
          "running",
          "queued",
          "waiting_input",
          "waiting_environment",
          "failed",
          "cancelled",
        ].includes(attempt.status) && (
          <p className="mw-muted" role="status">
            结果已生成，可通过下方“查看结果”返回结论。
          </p>
        )}
      {selected.status === "future" && !attempt ? (
        <>
          <p>此阶段尚未执行；点击节点不会启动任务。</p>
          {instructions}
          <ul>
            {selected.conditions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          {selected.stage === "track" &&
            track(currentJob, true, !timeline.historical)}
          {selected.stage === "decision" &&
            issue.type === "issue" &&
            !timeline.historical &&
            render("plan", currentJob, false)}
        </>
      ) : selected.result === "输入已更新" ? (
        <p>
          输入版本已变化，请通过下一步重新核对。此前的结论和执行记录可在前面的阶段查看。
        </p>
      ) : selection.detail === "execution" && attempt ? (
        render("work", attempt, readOnly, false, true)
      ) : selected.stage === "decision" && readOnly ? (
        <section>
          <p>已保存的维护者决定</p>
          {timeline.events
            .filter((e) => e.payload.type === "decision.recorded")
            .map((e) => (
              <p key={e.id}>
                {e.receivedAt} ·{" "}
                {e.payload.type === "decision.recorded" ? e.payload.reason : ""}
              </p>
            ))}
          {!timeline.events.some(
            (e) => e.payload.type === "decision.recorded",
          ) && <p>未保存单独的人工决定记录；此节点不能用于当前审批。</p>}
        </section>
      ) : selected.stage === "decision" ? (
        issue.type === "issue" && timeline.profile.category !== "question" ? (
          render("plan", currentJob, readOnly)
        ) : (
          render("review", currentJob, readOnly, true)
        )
      ) : selected.stage === "track" ? (
        attempt ? (
          track(
            attempt,
            readOnly,
            !timeline.historical && selected.id === timeline.currentNodeId,
          )
        ) : (
          <p>未保存可关联的交付运行，请核对本阶段的活动记录。</p>
        )
      ) : (
        render(
          selection.detail === "execution" ||
            !attempt?.result ||
            [
              "queued",
              "running",
              "waiting_input",
              "waiting_environment",
              "failed",
              "cancelled",
            ].includes(attempt?.status ?? "")
            ? "work"
            : "review",
          attempt,
          readOnly,
        )
      )}
      {attempt && (
        <div className="mw-stage-view-controls">
          <button
            type="button"
            className="mw-text-button"
            aria-label={
              selection.detail === "execution" ? "查看阶段结果" : "查看执行详情"
            }
            onClick={() =>
              choose({
                ...selection,
                nodeId: selected.id,
                detail:
                  selection.detail === "execution" ? "result" : "execution",
              })
            }
          >
            {selection.detail === "execution"
              ? attempt.result || attempt.artifact
                ? "查看结果"
                : "返回处理进度"
              : "执行详情"}
          </button>
        </div>
      )}
      {!timeline.historical &&
        context &&
        !(
          selected.stage === "decision" &&
          issue.type === "issue" &&
          timeline.profile.category !== "question"
        ) && (
          <details className="mw-stage-context">
            <summary>处理建议与计划</summary>
            {context()}
          </details>
        )}
      {selected.stage === "decision" &&
        selected.id === timeline.currentNodeId &&
        attempt &&
        evidence?.(attempt)}
      {selected.waits.some((w) => w.state !== "open") && (
        <details>
          <summary>
            等待记录 · {selected.waits.filter((w) => w.state !== "open").length}
          </summary>
          {selected.waits
            .filter((w) => w.state !== "open")
            .map((w) => (
              <p key={w.id}>{w.reason}</p>
            ))}
        </details>
      )}
    </section>
  );
}
