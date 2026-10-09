import { useCallback, useEffect, useRef, useState } from "react";
import type { GlobalSettingsSnapshot, Settings } from "../core/types.ts";
import type { HostWorkspaces } from "./host-workspaces.ts";
import { SettingsView } from "./SettingsView.tsx";
import { request } from "./api.ts";

const panels = [
  ["models", "模型"], ["automation", "自动化"], ["execution", "执行"],
  ["connections", "连接"], ["workspaces", "工作区"],
] as const;
type Panel = typeof panels[number][0];

/** Same form/controller in the native settings section and workbench shortcut. */
export function GlobalSettings({ native = false, hostWorkspaces }: { native?: boolean; hostWorkspaces?: HostWorkspaces }) {
  const [snapshot, setSnapshot] = useState<GlobalSettingsSnapshot>();
  const [panel, setPanel] = useState<Panel>("automation");
  const [busy, setBusy] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [confirmReload, setConfirmReload] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void request("/settings/global").then(value => {
      if (mounted.current) setSnapshot(value);
    }).catch(e => { if (mounted.current) setError(e.message); })
      .finally(() => { if (mounted.current) setBusy(false); });
    return () => { mounted.current = false; };
  }, []);
  const onChanged = useCallback((value: boolean) => setDirty(value), []);
  const reload = async () => {
    setBusy(true);
    try {
      const value = await request("/settings/global");
      if (!mounted.current) return;
      setSnapshot(value); setReloadVersion(n=>n+1); setDirty(false); setError(""); setNotice("");
      setConflict(false); setConfirmReload(false);
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const save = async (settings: Settings) => {
    if (!snapshot || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await request("/settings/global", { settings, revision: snapshot.revision });
      if (!mounted.current) return;
      setSnapshot(value); setDirty(false); setConflict(false); setNotice("");
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message);
      setConflict((e as { code?: string }).code === "SETTINGS_CONFLICT");
    } finally { if (mounted.current) setBusy(false); }
  };
  const credentials = async (value: { apiKey?: string; githubToken?: string; baseUrl?: string }) => {
    if (busy) return false;
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/credentials", value);
      if (mounted.current) setNotice("连接配置已保存");
      return true;
    } catch (e) { if (mounted.current) setError((e as Error).message); return false; }
    finally { if (mounted.current) setBusy(false); }
  };
  return (
    <section className={`mw mw-global-settings ${native ? "mw-native-settings" : ""}`}
      data-mw-host={native ? "" : undefined} aria-label="维护工作台全局设置">
      <div className="mw-settings-heading"><h2>维护工作台</h2>
</div>
      <nav className="mw-settings-tabs" aria-label="全局设置分类">
        {panels.map(([id, label]) => <button key={id} type="button"
          aria-current={panel === id ? "page" : undefined} onClick={() => setPanel(id)}>{label}</button>)}
      </nav>
      {error && <div role="alert" className="mw-settings-feedback error">{error}</div>}
      {error && snapshot && !conflict && <button type="button" className="mw-button" disabled={busy} onClick={() => setRetryVersion(n=>n+1)}>重试保存</button>}
      {notice && <div role="status" className="mw-settings-feedback">{notice}</div>}
      {((!snapshot && error) || conflict) && <button type="button" className="mw-button" disabled={busy}
        onClick={() => dirty ? setConfirmReload(true) : void reload()}>重新加载设置</button>}
      {confirmReload && <div role="alert" className="mw-settings-feedback">
        重新加载会丢弃本页未保存的设置草稿。
        <button type="button" className="mw-button" disabled={busy} onClick={() => void reload()}>丢弃草稿并重新加载</button>
        <button type="button" className="mw-button" disabled={busy} onClick={() => setConfirmReload(false)}>保留草稿</button>
      </div>}
      {!snapshot && !error && <p role="status">正在读取设置…</p>}
      {snapshot && <fieldset disabled={busy} className="mw-settings-fields"><SettingsView key={reloadVersion} scope="global" state={snapshot}
        panel={panel} retryVersion={retryVersion} hostWorkspaces={hostWorkspaces} repoId="" busy={busy} changed={onChanged}
        save={s => void save(s)} credentials={credentials}
        prepare={() => {}} bind={() => {}} /></fieldset>}
    </section>
  );
}
