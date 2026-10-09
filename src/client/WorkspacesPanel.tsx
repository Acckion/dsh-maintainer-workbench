import { useCallback, useEffect, useState } from "react";
import type { WorkspaceInspection } from "../application/workspaces.ts";
import type { WorkspaceRecord } from "../domain/workspaces.ts";
import { request } from "./api.ts";

export function WorkspacesPanel() {
  const [items, setItems] = useState<WorkspaceRecord[]>([]),
    [preview, setPreview] = useState<WorkspaceInspection>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stopped, setStopped] = useState(false);
  const refresh = useCallback(() => request("/workspaces").then(setItems), []);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [refresh]);
  const execute = async (path: string) => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await request(path, {
        id: preview.record.id,
        stamp: preview.stamp,
        confirmedStopped: stopped,
      });
      setPreview(undefined);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mw-settings-card">
      <h3>任务工作区</h3>
      <p>
        检查中断目录的所有权，或清理已结束的工作区。清理保留分支、补丁快照和执行证据。
      </p>
      <button
        className="mw-button"
        disabled={busy}
        onClick={() => void refresh().catch((e) => setError(e.message))}
      >
        刷新工作区
      </button>
      {items
        .filter((w) => w.status !== "removed")
        .map((w) => (
          <div className="mw-stage-event" key={w.id}>
            <strong>
              {w.repositoryId} · {w.purpose} · {w.status}
            </strong>
            <p>{w.path}</p>
            <button
              className="mw-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                setPreview(undefined);
                setStopped(false);
                try {
                  setPreview(
                    await request(
                      `/workspaces/inspect?id=${encodeURIComponent(w.id)}`,
                    ),
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              检查与预览
            </button>
          </div>
        ))}
      {!items.some((w) => w.status !== "removed") && (
        <p>暂无保留的任务工作区。</p>
      )}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <div className="mw-callout amber" aria-label="工作区处置预览">
          <div>
            <strong>{preview.record.path}</strong>
            <p>
              HEAD：{preview.headSha ?? "无法读取"} · 补丁 {preview.bytes ?? 0}{" "}
              字节
            </p>
            <p>清理前会保存已核对的补丁；冻结快照和执行记录继续保留。</p>
            {preview.removalCompleted && <p>目录已清理，Git 登记已移除；确认后保存清理完成状态。</p>}
            {preview.cleanupReasons.map((r) => (
              <p key={r}>{r}</p>
            ))}
            <button
              className="mw-button"
              disabled={busy || !!preview.cleanupReasons.length}
              onClick={() => void execute("/workspaces/cleanup")}
            >
              确认清理此工作区
            </button>
            {preview.record.status === "interrupted" && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={stopped}
                    onChange={(e) => setStopped(e.target.checked)}
                  />
                  已确认原 Harness 会话和进程停止
                </label>
                {preview.recoveryReasons.map((r) => (
                  <p key={r}>{r}</p>
                ))}
                <button
                  className="mw-button"
                  disabled={
                    busy || !stopped || !!preview.recoveryReasons.length
                  }
                  onClick={() => void execute("/workspaces/recover")}
                >
                  {preview.removalCompleted ? '确认恢复清理完成状态' : '确认恢复工作区所有权'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
