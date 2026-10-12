import { useEffect, useRef, useState } from "react";
import type { Issue, Job } from "../core/types.ts";
import type { ProcessingTimeline, TimelineNode } from "../domain/timeline.ts";
import { request } from "./api.ts";
import { stepDisposition } from "../workflow/manual.ts";

export type ManualStepMode =
  "supplement" | "takeover" | "skip" | "complete" | "reopen";

export function manualStepAccess(
  issue: Issue,
  timeline: ProcessingTimeline,
  selected: TimelineNode,
  readOnlyAttempt = false,
) {
  const writable =
    !readOnlyAttempt &&
    !timeline.historical &&
    issue.state === "open" &&
    !["completed", "cancelled"].includes(issue.processing?.lifecycle ?? "");
  const disposition = stepDisposition(issue.processing, selected.stage);
  const canReopen =
    !!writable &&
    !!disposition &&
    ["skip", "complete"].includes(disposition.mode);
  const editable =
    writable &&
    (selected.id === timeline.currentNodeId ||
      (selected.status === "future" &&
        selected.stage === timeline.actions?.primary?.kind));
  return { available: editable || canReopen, canReopen };
}

export function ManualStepForm({
  issue,
  timeline,
  selected,
  job,
  readOnlyAttempt,
  onUpdated,
}: {
  issue: Issue;
  timeline: ProcessingTimeline;
  selected: TimelineNode;
  job?: Job;
  readOnlyAttempt?: boolean;
  onUpdated: (mode: ManualStepMode, warnings?: string[]) => void;
}) {
  const key = `maintainer.manual:${timeline.caseId}:${selected.stage}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const pending = useRef<{ mode: string; text: string; id: string }>();
  useEffect(() => {
    try {
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch {}
  }, [key, text]);
  const { available, canReopen } = manualStepAccess(
    issue,
    timeline,
    selected,
    readOnlyAttempt,
  );
  if (!available) return null;
  const submit = async (mode: ManualStepMode) => {
    setBusy(true);
    setError("");
    setMessage("");
    const submittedText = ["supplement", "complete"].includes(mode) ? text : "";
    if (
      !pending.current ||
      pending.current.mode !== mode ||
      pending.current.text !== submittedText
    )
      pending.current = { mode, text: submittedText, id: crypto.randomUUID() };
    try {
      const response = await request("/processing/step", {
        issueId: issue.id,
        caseId: timeline.caseId,
        stage: selected.stage,
        mode,
        text: submittedText,
        requestId: pending.current.id,
        expectedVersion: timeline.version,
        sourceFingerprint: issue.processing?.sourceFingerprint,
      });
      pending.current = undefined;
      // Only the explicit save/submit actions publish text. Control actions retain the draft.
      if (["supplement", "complete"].includes(mode)) setText("");
      setMessage(
        mode === "supplement"
          ? "补充已保存，当前步骤尚未结束。"
          : mode === "takeover"
            ? "已停止 Agent。填写结果后，提交即可继续。"
            : "",
      );
      onUpdated(mode, response.cleanupWarnings);
      window.dispatchEvent(new Event("maintainer:manual-updated"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const takeover =
    stepDisposition(issue.processing, selected.stage)?.mode === "takeover";
  const canTakeover =
    !takeover &&
    selected.id === timeline.currentNodeId &&
    !!job &&
    ["running", "queued", "waiting_input", "waiting_environment"].includes(
      job.status,
    );
  return (
    <section className="mw-manual-step" aria-label="手动处理步骤">
      {canReopen ? (
        <>
          <p>此步骤已由你处置。重新打开后，可再次交给 Agent 或提交新结果。</p>
          <button
            type="button"
            className="mw-button"
            disabled={busy}
            onClick={() => void submit("reopen")}
          >
            重新打开此步骤
          </button>
        </>
      ) : (
        <>
          <p className="mw-muted">
            {takeover
              ? "此步骤由你处理。提交结果后进入下一步。"
              : "你可以补充信息、提交自己的结果，或直接跳过此步骤。你的决定会保存，后续 Agent 必须遵守。"}
          </p>
          <form
            className="mw-manual-editor"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && text.trim()) void submit("complete");
            }}
          >
            <label>
              你的结果或要求
              <textarea
                aria-label="你的结果或要求"
                placeholder="填写你已完成的工作、判断或需要 Agent 遵守的要求。依据和链接可选。"
                rows={5}
                maxLength={16000}
                disabled={busy}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <div className="mw-manual-controls">
              <button
                type="submit"
                className="mw-button primary"
                disabled={busy || !text.trim()}
              >
                提交结果并继续
              </button>
              <button
                type="button"
                className="mw-button"
                disabled={busy || !text.trim()}
                onClick={() => void submit("supplement")}
              >
                保存补充
              </button>
            </div>
            <p className="mw-manual-help">
              提交结果会结束此步骤并停止相关 Agent
              任务；保存补充仅提供信息，保留当前步骤。
            </p>
          </form>
          <div className="mw-manual-secondary">
            <div>
              <strong>跳过此步骤</strong>
              <p>不填写结果，直接进入下一步。Agent 不会重新执行此步骤。</p>
            </div>
            <button
              type="button"
              className="mw-button"
              disabled={busy}
              onClick={() => void submit("skip")}
            >
              跳过此步骤
            </button>
          </div>
          {(canTakeover || takeover) && (
            <div className="mw-manual-secondary">
              <div>
                <strong>
                  {takeover ? "交回 Agent" : "暂停 AI 执行，自己处理"}
                </strong>
                <p>
                  {takeover
                    ? "重新开放此步骤，允许 Agent 继续；不会自动启动任务。"
                    : "停止相关任务，保留现有记录，等待你提交结果。"}
                </p>
              </div>
              <button
                type="button"
                className="mw-button"
                disabled={busy}
                onClick={() => void submit(takeover ? "reopen" : "takeover")}
              >
                {takeover ? "交回 Agent" : "停止 Agent，由我处理"}
              </button>
            </div>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
