import {
  GitBranch,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings, Snapshot } from "../core/types.ts";
import { Tag } from "./Primitives.tsx";
import { WorkspacesPanel } from "./WorkspacesPanel.tsx";
import { request } from "./api.ts";
import { GlobalSettingsFields } from "./GlobalSettingsFields.tsx";
import type { HostWorkspaces } from "./host-workspaces.ts";
import { ModelSettings } from "./ModelSettings.tsx";
import { settingsIdentity } from "./settings-draft.ts";
export function GitHubConnection({
  refreshKey = false,
  configure = false,
}: {
  refreshKey?: boolean;
  configure?: boolean;
}) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [connection, setConnection] = useState<{
    authenticated: boolean;
    source: string;
    login?: string;
    error?: string;
    errorKind?: string;
  }>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    setConnection(undefined);
    setError("");
    void request("/github/connection")
      .then(setConnection)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh, refreshKey]);
  return (
    <div
      className={`mw-callout mw-auth-status ${error || connection?.error ? "red" : ""}`}
    >
      <ShieldCheck size={17} />
      <div>
        <strong>
          {error ||
            connection?.error ||
            (connection
              ? connection.authenticated
                ? `已连接 GitHub · ${connection.login}`
                : "公开仓库可直接读取（未登录）"
              : "正在检查 GitHub 连接…")}
        </strong>
        <p>
          {connection?.errorKind === "network" ||
          connection?.errorKind === "timeout"
            ? "网络检查失败，不代表令牌失效或没有仓库权限。请检查网络后重试，无需因此更换令牌。"
            : connection?.authenticated
              ? connection.source === "gh"
                ? "已自动复用本机 GitHub CLI 登录，无需重复填写令牌。"
                : "正在使用已配置的 GitHub 令牌。"
              : "他人的公开仓库也可读取，无需拥有仓库。私有仓库需要本机 GitHub CLI 登录或具有目标仓库读取权限的令牌。"}
        </p>
        <button
          type="button"
          className="mw-text-button"
          disabled={!connection && !error}
          onClick={refresh}
        >
          重新检查连接
        </button>
        {configure && (
          <details>
            <summary>使用其他 GitHub 令牌</summary>
            <label>
              GitHub Token
              <input
                type="password"
                autoComplete="new-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="输入具有目标仓库读取权限的令牌"
              />
            </label>
            <p>
              细粒度令牌请选择目标仓库，授予 Contents、Issues、Pull requests
              的读取权限。发布时才需要相应写入权限。
            </p>
            <button
              type="button"
              className="mw-button"
              disabled={saving || !token.trim()}
              onClick={async () => {
                setSaving(true);
                try {
                  await request("/credentials", { githubToken: token.trim() });
                  setToken("");
                  refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "保存失败");
                } finally {
                  setSaving(false);
                }
              }}
            >
              保存并检查连接
            </button>
          </details>
        )}
      </div>
    </div>
  );
}
export function SettingsView({
  scope,
  state,
  repoId,
  busy,
  save,
  bind,
  credentials,
  prepare,
  panel = "all",
  changed,
  hostWorkspaces,
  retryVersion = 0,
}: {
  scope: "global" | "repository";
  state: Pick<Snapshot, "settings" | "capabilities"> & { repos?: Snapshot["repos"] };
  panel?: "all" | "models" | "automation" | "execution" | "connections" | "workspaces";
  hostWorkspaces?: HostWorkspaces;
  retryVersion?: number;
  changed?: (dirty: boolean) => void;
  repoId: string;
  busy: boolean;
  prepare: () => void;
  save: (s: Settings) => void;
  bind: (path: string) => void;
  credentials: (c: {
    apiKey?: string;
    githubToken?: string;
    baseUrl?: string;
  }) => void | Promise<boolean>;
}) {
  const [settings, setSettings] = useState(state.settings);
  const [apiKey, setApiKey] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [baseUrl, setBaseUrl] = useState(state.capabilities.baseUrl);
  const repo = state.repos?.find((r) => r.id === repoId);
  const [path, setPath] = useState(repo?.localPath ?? "");
  useEffect(() => setPath(repo?.localPath ?? ""), [repo?.id, repo?.localPath]);
  const native = state.capabilities.harness;
  const host = state.capabilities.host;
  useEffect(() => {
    changed?.(settingsIdentity(settings) !== settingsIdentity(state.settings));
  }, [settings, state.settings, changed]);
  const attempted = useRef("");
  const saveRef = useRef(save); saveRef.current = save;
  const lastRetry = useRef(retryVersion);
  useEffect(() => {
    if (retryVersion === lastRetry.current) return;
    lastRetry.current = retryVersion;
    if (scope === "global" && !busy) saveRef.current(settings);
  }, [retryVersion, settings, scope, busy]);
  useEffect(() => {
    if (scope !== "global" || busy) return;
    const identity = settingsIdentity(settings);
    if (identity === settingsIdentity(state.settings) || identity === attempted.current) return;
    const timer = setTimeout(() => { attempted.current = identity; saveRef.current(settings); }, 600);
    return () => clearTimeout(timer);
  }, [settings, state.settings, scope, busy]);
  return (
    <div className="mw-settings-grid">
      {(scope === "repository" || panel === "all" || panel === "connections") && <section className="mw-settings-card">
        {scope === "repository" ? (
          <>
            <div className="mw-section-title">
              <GitBranch size={19} />
              仓库连接
            </div>

            {state.capabilities.harness &&
              repo?.mode === "github" &&
              !repo.localPath && (
                <button
                  className="mw-button primary"
                  disabled={busy}
                  onClick={prepare}
                >
                  <GitBranch size={15} />
                  自动准备仓库
                </button>
              )}
            <div className="mw-token-row"><label>
              本地工作区
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/absolute/path/to/repository"
              />
            </label>
            <button
              className="mw-button"
              disabled={busy || !path || !repo}
              onClick={() => bind(path)}
            >
              绑定
            </button></div>
            {repo?.profile && (
              <div className="mw-repo-profile">
                <h4>Agent 的仓库上下文</h4>
                <p>
                  {repo.profile.languages.join(" / ") || "尚未识别语言"} · 提交{" "}
                  {repo.profile.revision.slice(0, 8)}
                </p>
                <p className="mw-muted">
                  {repo.profile.sources.length} 份约定与配置摘要 ·{" "}
                  {repo.profile.testPaths.length} 个测试入口 ·{" "}
                  {repo.profile.workflows.length} 个 CI 工作流
                </p>
                <details>
                  <summary>查看读取来源与覆盖范围</summary>
                  {repo.profile.sources.map((s) => (
                    <p key={s.path}>
                      <code>{s.path}</code>
                    </p>
                  ))}
                  {repo.profile.warnings.map((w, i) => (
                    <p className="mw-muted" key={i}>
                      {w}
                    </p>
                  ))}
                </details>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mw-section-title">
              <Settings2 size={19} />
              GitHub 连接
            </div>
            <GitHubConnection refreshKey={busy} />
            <div className="mw-credential-fields">
              {!native && (
                <>
                  <label>
                    独立预览 API Key
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="留空则保持已保存密钥"
                    />
                  </label>
                  <label>
                    兼容 API 地址
                    <input
                      type="url"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                    />
                  </label>
                </>
              )}
              <div className="mw-token-row"><label>
                GitHub Token
                <input
                  type="password"
                  autoComplete="new-password"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="可选：自动复用本机 GitHub CLI 登录"
                />
              </label>
              <button
                className="mw-button"
                disabled={busy}
                onClick={async () => {
                  const accepted = await credentials({
                    ...(native
                      ? {}
                      : { ...(apiKey ? { apiKey } : {}), baseUrl }),
                    ...(githubToken ? { githubToken } : {}),
                  });
                  if (accepted !== false) {
                    setApiKey("");
                    setGithubToken("");
                  }
                }}
              >
                保存
              </button>
              </div>
            </div>
          </>
        )}
      </section>}
      {scope === "global" && (panel === "models" || (panel === "all" && native)) && <form
        className="mw-settings-card" onSubmit={e => { e.preventDefault(); save(settings); }}>
        {native ? <ModelSettings settings={settings} update={setSettings} /> : <p className="mw-muted">
          Harness 模型选择仅在原生插件中可用。独立预览的模型在「执行」中配置。
        </p>}

      </form>}
      {scope === "global" && (panel === "all" || panel === "automation" || panel === "execution") && (
        <form
          className="mw-settings-card"
          onSubmit={(e) => {
            e.preventDefault();
            save(settings);
          }}
        >
          <GlobalSettingsFields settings={settings} update={setSettings} panel={panel} native={native} hostPreset={host?.agentPreset}/>

        </form>
      )}
      {scope === "global" && (panel === "all" || panel === "workspaces") && <WorkspacesPanel host={hostWorkspaces} />}
    </div>
  );
}
