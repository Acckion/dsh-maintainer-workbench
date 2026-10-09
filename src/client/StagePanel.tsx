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
  ) => ReactNode;
  track: (job?: Job, readOnly?: boolean, monitoring?: boolean) => ReactNode;
  evidence?: (job?: Job) => ReactNode;
  progress?: string;
  actions?: ReactNode;
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
  progress,
  actions,
}: Props) {
  return (
    <section className="mw-stage-panel" aria-label="选中阶段">
      <header>
        <h3>{selected.label}</h3>
        <span
          className={`mw-tag ${selected.status === "blocked" ? "amber" : ""}`}
        >
          {attempt && selected.stage === attempt.kind
            ? jobNodeState(attempt).result
            : selected.result}
        </span>
        {actions && <div className="mw-workflow-actions">{actions}</div>}
      </header>
      {viewingHistory && (
        <p className="mw-stage-history">
          {selected.status === "future"
            ? "下一步预览 · 尚未执行"
            : "正在查看历史阶段或尝试 · 只读 · 当前任务继续保留"}
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
      <p className="mw-stage-focus">{timeline.profile.focus.join(" · ")}</p>
      {attempt && (
        <>
          <details className="mw-stage-source">
            <summary>来源与版本</summary>
            <p className="mw-muted">
              来源提交 {attempt.baseSha.slice(0, 12)} · {attempt.createdAt}
              {attempt.artifactState === "stale"
                ? " · 已过期，不能用于当前交付"
                : ""}
            </p>
          </details>
          <div className="mw-stage-view-controls">
            <button
              type="button"
              className="mw-text-button"
              aria-label="查看阶段结果"
              aria-pressed={selection.detail === "result"}
              onClick={() =>
                choose({ ...selection, nodeId: selected.id, detail: "result" })
              }
            >
              结论与证据
            </button>
            <button
              type="button"
              className="mw-text-button"
              aria-label="查看执行详情"
              aria-pressed={selection.detail === "execution"}
              onClick={() =>
                choose({
                  ...selection,
                  nodeId: selected.id,
                  detail: "execution",
                })
              }
            >
              执行记录
            </button>
          </div>
        </>
      )}
      {progress && !viewingHistory && (
        <p className="mw-stage-live" role="status">
          {progress}
        </p>
      )}
      {selected.status === "future" && !attempt ? (
        <>
          <p>此阶段尚未执行；点击节点不会启动任务。</p>
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
        render("work", attempt, readOnly)
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
      {selected.stage === "decision" &&
        selected.id === timeline.currentNodeId &&
        attempt &&
        evidence?.(attempt)}
      {!viewingHistory && (
        <aside className="mw-stage-next" aria-label="当前处理与下一步">
          <div>
            <p>
              <span>下一步</span> {timeline.next}
            </p>
          </div>
          {timeline.draft && (
            <small>Draft PR · 最终交付前需核对作者的暂缓条件</small>
          )}
        </aside>
      )}
      {selected.waits.length > 0 && (
        <details>
          <summary>本阶段等待 · {selected.waits.length}</summary>
          {selected.waits.map((w) => (
            <p key={w.id}>{w.reason}</p>
          ))}
        </details>
      )}
    </section>
  );
}
