import { useEffect, useState } from "react";
import type { Issue } from "../core/types.ts";
import type { ProcessingCase, ProcessingEvent } from "../domain/processing.ts";
import { request } from "./api.ts";

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
          <ol>
            {history.events.map((event) => (
              <li key={event.id}>
                <small>
                  {new Date(event.receivedAt).toLocaleString("zh-CN")} ·{" "}
                  {event.source}
                </small>
                <p>
                  {event.payload.type}
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
