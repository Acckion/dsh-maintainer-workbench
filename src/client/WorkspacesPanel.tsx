import { useCallback, useEffect, useState } from "react";
import type { WorkspaceInspection } from "../application/workspaces.ts";
import type { WorkspaceRecord } from "../domain/workspaces.ts";
import type { HostWorkspaces, HostWorkspace } from "./host-workspaces.ts";
import type { Snapshot } from "../core/types.ts";
import { ExecutionResources } from "./ExecutionResources.tsx";
import { executionResourceGroups } from "./execution-resources.ts";
import { request } from "./api.ts";

export function WorkspacesPanel({host,openSession}: {host?:HostWorkspaces;openSession?:(id:string)=>void}) {
  const [development, setDevelopment] = useState<readonly HostWorkspace[]>(host?.source.getSnapshot().items ?? []);
  const [adding, setAdding] = useState(false), [addError, setAddError] = useState(""), [added,setAdded] = useState("");
  useEffect(() => {
    if (!host) return;
    const refresh = () => setDevelopment(host.source.getSnapshot().items);
    refresh(); return host.source.subscribe(refresh);
  }, [host]);
  const add = async () => {
    if (!host || adding) return;
    setAdding(true); setAddError(""); setAdded("");
    try {
      const path = await host.pickDirectory();
      if (!path) return;
      const workspace = await host.create({path});
      setDevelopment(host.source.getSnapshot().items);
      setAdded(`已添加 ${workspace.title}。插件将自动识别此目录，无需连接 GitHub。`);
    } catch(e) {setAddError((e as Error).message);}
    finally {setAdding(false);}
  };
  const [items, setItems] = useState<WorkspaceRecord[]>([]),
    [preview, setPreview] = useState<WorkspaceInspection>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stopped, setStopped] = useState(false);
  const [context,setContext] = useState<Pick<Snapshot,"jobs"|"issues">>({jobs:[],issues:[]});
  const refresh = useCallback(async () => {
    const [workspaces,state] = await Promise.all([request("/workspaces"),request("/state")]);
    setError(""); setItems(workspaces); setContext({jobs:state.jobs ?? [],issues:state.issues ?? []});
  }, []);
  const grouped = executionResourceGroups(context.jobs,context.issues,items);
  const inspect = async (workspace:WorkspaceRecord) => {
    setBusy(true);setError("");setPreview(undefined);setStopped(false);
    try { setPreview(await request(`/workspaces/inspect?id=${encodeURIComponent(workspace.id)}`)); }
    catch(e) {setError((e as Error).message);}
    finally {setBusy(false);}
  };
  const inspectButton = (workspace:WorkspaceRecord) => workspace.status !== "removed" && <button className="mw-button" disabled={busy} onClick={()=>void inspect(workspace)}>检查与预览</button>;
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
    <div className="mw-workspace-settings">
      <section className="mw-settings-card mw-development-workspaces">
        <div className="mw-preference-row"><div className="mw-preference-copy"><span>开发工作区</span>
          <small>添加到 Harness 的本地目录会自动被插件发现</small></div>
          <button type="button" className="mw-button" disabled={!host || adding} onClick={()=>void add()}>{adding ? "正在添加…" : "添加工作区"}</button>
        </div>
        {!host && <p className="mw-muted">请在 Harness 原生插件中选择本地文件夹。</p>}
        {host && !development.filter(workspace=>!items.some(task=>task.path===workspace.path)).length && <p className="mw-muted">尚未添加开发工作区。</p>}
        {development.filter(workspace=>!items.some(task=>task.path===workspace.path)).map(workspace=><div className="mw-workspace-list-row" key={workspace.workspaceId}>
          <strong>{workspace.title}</strong><span>{workspace.path}</span></div>)}
        {added && <p role="status" className="mw-preference-footnote">{added}</p>}
        {addError && <p role="alert">{addError}</p>}
      </section>
      <section className="mw-settings-card">
      <h3>事项工作区与会话</h3>
      <p>
        按 Issue／PR → 阶段 → 尝试归组工作区与会话，包括轻量分析。检查和清理仍针对单个目录，保留分支、补丁快照和执行证据。
      </p>
      <button
        className="mw-button"
        disabled={busy}
        onClick={() => void refresh().catch((e) => setError(e.message))}
      >
        刷新工作区
      </button>
      {grouped.groups.map(group=><details className="mw-item-resources" key={group.issue.id}>
        <summary>{group.issue.repoId} · {group.issue.origin === "repository" ? "仓库维护" : `${group.issue.type === "pr" ? "PR" : "Issue"} #${group.issue.number}`} · {group.issue.title} · {group.jobs.length} 次执行</summary>
        <ExecutionResources jobs={group.jobs} currentCaseId={group.issue.processing?.id} workspaces={group.workspaces} openSession={openSession} workspaceAction={inspectButton} />
      </details>)}
      {!!grouped.unassigned.filter(w=>w.status!=="removed").length && <details className="mw-item-resources"><summary>未关联事项的工作区</summary>
        <p className="mw-muted">缺少对应执行记录，保留原有检查入口。</p>
        {grouped.unassigned.filter(w=>w.status!=="removed").map(w=><div className="mw-resource-row" key={w.id}><strong>{w.repositoryId} · {w.purpose} · {w.status}</strong><p>{w.path}</p>{inspectButton(w)}</div>)}
      </details>}
      {!items.some(w=>w.status!=="removed") && <p>暂无保留的任务工作区。</p>}
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
    </section></div>
  );
}
