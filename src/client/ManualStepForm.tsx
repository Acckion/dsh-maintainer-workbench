import { useEffect, useRef, useState } from "react";
import type { Issue } from "../core/types.ts";
import type { ProcessingTimeline, TimelineNode } from "../domain/timeline.ts";
import { request } from "./api.ts";
import { stepDisposition } from "../workflow/manual.ts";

export function ManualStepForm({
  issue,
  timeline,
  selected,
  readOnlyAttempt,
  onUpdated,
}: {
  issue: Issue;
  timeline: ProcessingTimeline;
  selected: TimelineNode;
  readOnlyAttempt?: boolean;
  onUpdated: (warnings?: string[]) => void;
}) {
  const key = `maintainer.manual:${timeline.caseId}:${selected.stage}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<{ mode: string; text: string; id: string }>();
  useEffect(() => {
    try {
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch {}
  }, [key, text]);
  const editable =
    !timeline.historical &&
    issue.state === "open" &&
    !["completed", "cancelled"].includes(issue.processing?.lifecycle ?? "") &&
    (selected.id === timeline.currentNodeId ||
      (selected.status === "future" &&
        selected.stage === timeline.actions?.primary?.kind));
  const disposition = stepDisposition(issue.processing, selected.stage);
  const canReopen =
    !timeline.historical &&
    issue.state === "open" &&
    !["completed", "cancelled"].includes(issue.processing?.lifecycle ?? "") &&
    disposition &&
    ["skip", "complete"].includes(disposition.mode);
  if (readOnlyAttempt || (!editable && !canReopen)) return null;
  const submit = async (
    mode: "supplement" | "takeover" | "skip" | "complete" | "reopen",
  ) => {
    setBusy(true);
    setError("");
    if (
      !pending.current ||
      pending.current.mode !== mode ||
      pending.current.text !== text
    )
      pending.current = { mode, text, id: crypto.randomUUID() };
    try {
      const response = await request("/processing/step", {
        issueId: issue.id,
        caseId: timeline.caseId,
        stage: selected.stage,
        mode,
        text,
        requestId: pending.current.id,
        expectedVersion: timeline.version,
        sourceFingerprint: issue.processing?.sourceFingerprint,
      });
      pending.current = undefined;
      setText("");
      setOpen(false);
      onUpdated(response.cleanupWarnings);
      window.dispatchEvent(new Event("maintainer:manual-updated"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const takeover =
    stepDisposition(issue.processing, selected.stage)?.mode === "takeover";
  return (
    <section className="mw-manual-step" aria-label="手动处理步骤">
      {canReopen ? (
        <button
          className="mw-text-button"
          disabled={busy}
          onClick={() => void submit("reopen")}
        >
          重新打开此步骤
        </button>
      ) : (
        <>
          <div className="mw-manual-controls">
            <button
              className="mw-text-button"
              disabled={busy}
              onClick={() => setOpen(!open)}
            >
              {open ? "收起输入" : "补充结果 / 手动完成"}
            </button>
            {!takeover ? (
              <button
                className="mw-text-button"
                disabled={busy}
                onClick={() => void submit("takeover")}
              >
                我来完成
              </button>
            ) : (
              <button
                className="mw-text-button"
                disabled={busy}
                onClick={() => void submit("reopen")}
              >
                交回 Agent
              </button>
            )}
            <button
              className="mw-text-button"
              disabled={busy}
              onClick={() => void submit("skip")}
            >
              跳过此步骤
            </button>
          </div>
          {(open || takeover) && (
            <div className="mw-manual-editor">
              <label>
                你的结果或要求
                <textarea
                  aria-label="你的结果或要求"
                  placeholder="填写你的判断、已完成的工作或需要 Agent 遵守的要求。依据和链接可选。"
                  rows={4}
                  maxLength={16000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <div className="mw-manual-controls">
                <button
                  className="mw-button"
                  disabled={busy || !text.trim()}
                  onClick={() => void submit("supplement")}
                >
                  保存补充
                </button>
                <button
                  className="mw-button primary"
                  disabled={busy || !text.trim()}
                  onClick={() => void submit("complete")}
                >
                  提交结果并继续
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
