import { useEffect, useState } from "react";
import { kindNames } from "../core/types.ts";
import type { Issue } from "../core/types.ts";
import type { ProcessingCase, ProcessingEvent } from "../domain/processing.ts";
import { request } from "./api.ts";

const eventNames: Record<ProcessingEvent["payload"]["type"], string> = {
  "planning.recorded": "处理计划与进度已保存",
  "source.observed": "事项材料已同步",
  "decision.recorded": "维护者决定已记录",
  "information.observed": "补充信息已更新",
  "run.observed": "执行进度已更新",
  "input.requested": "需要补充输入",
  "input.submitted": "补充输入已提交",
  "remote.activity": "远端进度已更新",
  "publication.confirmed": "交付已确认",
  "environment.observed": "仓库环境已更新",
  "wait.cancelled": "等待已结束",
  "workflow.upgraded": "工作流已升级",
};
const runStates = {
  running: "自动处理中",
  blocked: "需要解除阻塞",
  review: "待最终审核",
  paused: "已暂停",
  cancelled: "已取消",
  waiting_author: "等待作者新提交",
};

export function ProcessingHistory({
  issue,
  busy,
  act,
}: {
  issue: Issue;
  busy: boolean;
  act: (path: string, data: unknown, message: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [cycle, setCycle] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState("");
  const [history, setHistory] = useState<{
    cases: ProcessingCase[];
    selected: ProcessingCase;
    events: ProcessingEvent[];
  }>();
  useEffect(() => {
    if (!open) return;
    let current = true;
    setHistory(undefined);
    setError("");
    void request(
      `/processing?issueId=${encodeURIComponent(issue.id)}${cycle ? `&caseId=${encodeURIComponent(cycle)}` : ""}`,
    )
      .then((value) => {
        if (current) setHistory(value);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [open, issue.id, issue.processing?.version, cycle]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>处理状态与事件历史</summary>
      <p>{issue.processing?.reason}</p>
      {(issue.processing?.waits.filter((w) => w.state === "open") ?? []).map(
        (wait) => (
          <div className="mw-callout" key={wait.id}>
            <div>
              <strong>{wait.reason}</strong>
              {wait.type === "host_permission" ? (
                <p>请在对应 Harness 会话中处理权限审批。</p>
              ) : wait.type === "user_input" ? (
                <p>填写上方输入表单后继续。</p>
              ) : (
                <p>
                  {wait.type === "ci_completion"
                    ? "刷新远端进度以核对 CI。"
                    : wait.type === "author_revision"
                      ? "作者提交新版本后，刷新并重新审查。"
                      : wait.type === "environment_ready"
                        ? "准备仓库环境后，显式继续原任务。"
                        : "核对回复或产物后记录决定。"}
                </p>
              )}
              {!["approval", "host_permission"].includes(wait.type) && (
                <button
                  className="mw-button"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    void act(
                      "/processing/wait/cancel",
                      {
                        issueId: issue.id,
                        waitId: wait.id,
                        reason,
                        expectedVersion: issue.processing?.version,
                      },
                      "等待已结束，原因已保存",
                    )
                  }
                >
                  结束此等待
                </button>
              )}
            </div>
          </div>
        ),
      )}
      <label>
        结束等待的原因
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {history && (
        <>
          <label>
            查看处理周期
            <select
              aria-label="查看处理周期"
              value={cycle}
              onChange={(e) => setCycle(e.target.value)}
            >
              <option value="">当前周期</option>
              {history.cases.map((c) => (
                <option key={c.id} value={c.id}>
                  周期 {c.cycle} · {c.phase}
                </option>
              ))}
            </select>
          </label>
          <p>
            周期 {history.selected.cycle} · {history.selected.lifecycle} ·{" "}
            {history.selected.reason}
          </p>
          {history.selected.planning && (
            <section aria-label="此周期的处理计划">
              <h4>此周期的处理计划</h4>
              <p>
                {history.selected.planning.run?.plan.goal ??
                  history.selected.planning.draft?.goal}
              </p>
              <p>
                范围：
                {history.selected.planning.run?.plan.scope ??
                  history.selected.planning.draft?.scope}
              </p>
              {history.selected.planning.run && (
                <p>
                  {runStates[history.selected.planning.run.status]} ·{" "}
                  {history.selected.planning.run.reason}
                  {history.selected.planning.run.checkpoint
                    ? ` · 当前步骤：${kindNames[history.selected.planning.run.checkpoint.kind]}`
                    : ""}
                </p>
              )}
            </section>
          )}
          <ol>
            {history.events.map((event) => (
              <li key={event.id}>
                <small>
                  {new Date(event.receivedAt).toLocaleString("zh-CN")} ·{" "}
                  {
                    {
                      github: "GitHub",
                      user: "维护者",
                      agent: "执行器",
                      system: "系统",
                    }[event.source]
                  }
                </small>
                <p>
                  {eventNames[event.payload.type]}
                  {event.payload.type === "planning.recorded"
                    ? ` · ${event.payload.planning.run?.reason ?? event.payload.planning.draft?.goal ?? "计划已更新"}`
                    : ""}
                  {"reason" in event.payload
                    ? ` · ${event.payload.reason}`
                    : ""}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
    </details>
  );
}
