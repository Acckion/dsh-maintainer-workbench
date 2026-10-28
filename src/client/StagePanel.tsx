import { stepDisposition } from "../workflow/manual.ts";
import { EnvironmentStatus } from './EnvironmentStatus.tsx';
import { useId, type ReactNode } from "react";
import { StageTabs } from "./StageTabs.tsx";
import type { Issue, Job } from "../core/types.ts";
import type { ProcessingTimeline, TimelineNode } from "../domain/timeline.ts";
import { jobNodeState } from "../workflow/presentation.ts";
import type { AgentTab } from "./RepositoryDetail.tsx";

export type StageSelection = {
  nodeId?: string;
  attemptId?: string;
  view: "stage" | "plan";
  detail: "result" | "manual" | "execution" | "plan";
};
interface Props {
  selected: TimelineNode;
  timeline: ProcessingTimeline;
  issue: Issue;
  attempt?: Job;
  currentJob?: Job;
  history: Job[];
  readOnly: boolean;
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
  manual?: ReactNode;
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
  selection,
  choose,
  render,
  track,
  evidence,
  context,
  actions,
  manual,
  instructions,
}: Props) {
  const manualRecord =
    selected.manual ??
    (timeline.historical
      ? undefined
      : stepDisposition(issue.processing, selected.stage));
  const manuallyResolved =
    !selection.attemptId &&
    manualRecord &&
    ["skip", "complete"].includes(manualRecord.mode);
  const executionAttempt =
    attempt ?? history.find((j) => j.id === selected.attemptIds.at(-1));
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
  const tabs: { id: StageSelection["detail"]; label: string }[] = [
    { id: "result", label: "进度与结果" },
    ...(manual ? [{ id: "manual" as const, label: "手动处理" }] : []),
    ...(executionAttempt
      ? [{ id: "execution" as const, label: "执行记录" }]
      : []),
    ...(context ? [{ id: "plan" as const, label: "处理计划" }] : []),
  ];
  const detail = tabs.some((tab) => tab.id === selection.detail)
    ? selection.detail
    : "result";
  const decisionNode=timeline.nodes.find(node=>node.stage==='decision');
  const publishedReview=selected.stage==='decision'&&currentJob?.kind==='review'&&currentJob.status==='approved'&&currentJob.publications?.comment?.status==='published';
  const panelId = useId();
  return (
    <section className="mw-stage-panel" aria-label="选中阶段" tabIndex={-1}>
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
            : manualRecord &&
                !selection.attemptId &&
                (manuallyResolved || manualRecord.mode === "takeover")
              ? manualRecord.mode === "skip"
                ? "已跳过"
                : manualRecord.mode === "complete"
                  ? "手动完成"
                  : "等待手动结果"
              : attempt && selected.stage === attempt.kind
                ? jobNodeState(attempt).result
                : selected.result}
        </span>
        {(selected.attemptIds.length > 1 ||
          (!!manualRecord && selected.attemptIds.length > 0)) && (
          <label className="mw-stage-attempt">
            阶段尝试
            <select
              aria-label="查看阶段尝试"
              value={
                manualRecord && !selection.attemptId ? "" : (attempt?.id ?? "")
              }
              onChange={(e) =>
                choose({
                  ...selection,
                  nodeId: selected.id,
                  view: "stage",
                  attemptId: e.target.value || undefined,
                })
              }
            >
              {manualRecord && <option value="">用户处置记录</option>}
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
        {actions && !["manual", "plan"].includes(detail) && (
          <div className="mw-workflow-actions">{actions}</div>
        )}
      </header>
      <StageTabs
        items={tabs}
        selected={detail}
        panelId={panelId}
        onSelect={(detail) =>
          choose({ ...selection, nodeId: selected.id, detail })
        }
      />
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${panelId}-${detail}`}
        className="mw-stage-content"
      >
        {detail==='result'&&<EnvironmentStatus job={attempt}/>}
        {detail==='result'&&selected.stage==='validate'&&attempt?.id===timeline.currentRunId&&decisionNode?.attemptIds.length&&decisionNode.status!=='future'&&<section className="mw-review-handoff"><p>验证已通过。下一步核对修复补丁和验证证据，确认后交付。</p><button className="mw-button primary" onClick={()=>choose({view:'stage',detail:'result',nodeId:decisionNode.id})}>下一步：确认修复与交付</button></section>}
        {detail==='result'&&['review','track'].includes(selected.stage)&&attempt?.id===timeline.currentRunId&&decisionNode&&decisionNode.status!=='future'&&<section className="mw-review-handoff"><p>审查结论与证据已保存。下一步由维护者确认，再发布结论并选择处理方式。</p><button className="mw-button primary" onClick={()=>choose({view:'stage',detail:'result',nodeId:decisionNode.id})}>下一步：确认与处理</button></section>}
        {detail === "manual" ? (
          manual
        ) : detail === "plan" ? (
          context?.()
        ) : (
          <>
            {detail === "result" && selected.scopeConfirmation && !readOnly && (
              <p className="mw-muted">
                定位结果已保存。在“处理计划”中确认目标与范围后，可继续实施。
              </p>
            )}
            {detail === "execution" &&
              attempt &&
              !readOnly &&
              (["waiting_input", "waiting_environment"].includes(
                attempt.status,
              ) ||
                !!activeWait) &&
              render("work", attempt, false)}
            {detail === "execution" &&
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
                  结果已生成，可在“进度与结果”页签查看结论。
                </p>
              )}
            {detail === "execution" && executionAttempt ? (
              render(
                "work",
                executionAttempt,
                readOnly || !attempt,
                false,
                true,
              )
            ) : manuallyResolved ? (
              <section className="mw-manual-result">
                <p>
                  {manualRecord.mode === "skip"
                    ? "此步骤由用户跳过。"
                    : "用户提交的阶段结果"}
                </p>
                {manualRecord.text && (
                  <p style={{ whiteSpace: "pre-wrap" }}>{manualRecord.text}</p>
                )}
              </section>
            ) : manualRecord?.mode === "takeover" && !selection.attemptId ? (
              <p>Agent 已停止，此步骤由你完成。填写结果后可继续。</p>
            ) : selected.status === "future" && !attempt ? (
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
              </>
            ) : publishedReview&&!readOnly ? (
              render("review",currentJob,false,true)
            ) : selected.result === "输入已更新" ? (
              <p>
                输入版本已变化，请通过下一步重新核对。此前的结论和执行记录可在前面的阶段查看。
              </p>
            ) : selected.stage === "decision" && readOnly ? (
              <section>
                <p>已保存的维护者决定</p>
                {timeline.events
                  .filter((e) => e.payload.type === "decision.recorded")
                  .map((e) => (
                    <p key={e.id}>
                      {e.receivedAt} ·{" "}
                      {e.payload.type === "decision.recorded"
                        ? e.payload.reason
                        : ""}
                    </p>
                  ))}
                {!timeline.events.some(
                  (e) => e.payload.type === "decision.recorded",
                ) && <p>未保存单独的人工决定记录；此节点不能用于当前审批。</p>}
              </section>
            ) : selected.stage === "decision" ? (
              issue.type === "issue" &&
              timeline.profile.category !== "question" && !["fix", "docs"].includes(attempt?.kind ?? "") ? (
                render("plan", currentJob, readOnly)
              ) : (
                render("review", attempt??currentJob, readOnly, true)
              )
            ) : selected.stage === "track" ? (
              attempt ? (
                track(
                  attempt,
                  readOnly,
                  !timeline.historical,
                )
              ) : (
                <p>未保存可关联的交付运行，请核对本阶段的活动记录。</p>
              )
            ) : (
              render(
                detail === "execution" ||
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
            {!!selected.supplements?.length && (
              <section className="mw-stage-supplements">
                <h4>用户补充</h4>
                {selected.supplements.map((r) => (
                  <p key={r.id} style={{ whiteSpace: "pre-wrap" }}>
                    {r.text}
                  </p>
                ))}
              </section>
            )}
            {detail === "result" &&
              selected.stage === "decision" &&
              selected.id === timeline.currentNodeId &&
              attempt &&
              evidence?.(attempt)}
            {detail === "execution" &&
              selected.waits.some((w) => w.state !== "open") && (
                <details>
                  <summary>
                    等待记录 ·{" "}
                    {selected.waits.filter((w) => w.state !== "open").length}
                  </summary>
                  {selected.waits
                    .filter((w) => w.state !== "open")
                    .map((w) => (
                      <p key={w.id}>{w.reason}</p>
                    ))}
                </details>
              )}
          </>
        )}
      </div>
    </section>
  );
}
