import {
  Check,
  GitBranch,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Settings, Snapshot } from "../core/types.ts";
import { Tag } from "./Primitives.tsx";
import { WorkspacesPanel } from "./WorkspacesPanel.tsx";
import { request } from "./api.ts";
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
}: {
  scope: "global" | "repository";
  state: Pick<Snapshot, "settings" | "capabilities"> & { repos?: Snapshot["repos"] };
  panel?: "all" | "automation" | "execution" | "connections" | "workspaces";
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
  return (
    <div className="mw-settings-grid">
      {(scope === "repository" || panel === "all" || panel === "connections") && <section className="mw-settings-card">
        {scope === "repository" ? (
          <>
            <div className="mw-section-title">
              <GitBranch size={19} />
              仓库连接
            </div>
            <h3>{repo?.fullName ?? "尚未选择"}</h3>
            <p>{repo?.description}</p>
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
            <label>
              已有本地克隆（可选）
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/absolute/path/to/repository"
              />
            </label>
            <p className="mw-muted">
              调查、审查、修复与文档任务会自动克隆仓库并创建隔离工作区，无需手动填写路径。也可提前准备；大型仓库首次下载需要一些时间。
            </p>
            <button
              className="mw-button"
              disabled={busy || !path || !repo}
              onClick={() => bind(path)}
            >
              绑定工作区
            </button>
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
              模型与连接
            </div>
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
              <label>
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
                保存连接配置
              </button>
              <p className="mw-muted">
                GitHub 令牌仅保存在服务端权限为 0600 的文件中，不返回浏览器。
              </p>
            </div>
            {native && (
              <div className="mw-host-model">
                <div className="mw-section-title">
                  <Sparkles size={19} />
                  跟随 Harness 默认模型
                </div>
                <h3>{host?.model ?? "等待宿主模型配置"}</h3>
                <p>
                  {host?.provider ?? "未选择提供方"}
                  {host?.reasoningEffort
                    ? ` · 推理：${host.reasoningEffort}`
                    : " · 推理使用宿主默认设置"}
                </p>
                <Tag tone={host?.adapterRegistered ? "green" : "amber"}>
                  {host?.adapterRegistered
                    ? "适配器已加载 · 凭据在调用时验证"
                    : "模型适配器未加载"}
                </Tag>
                <p>
                  模型、API 地址和密钥统一在{" "}
                  <strong>Harness 左下角「设置 → 模型」</strong>
                  管理。每次新任务读取宿主默认选择，无需在插件中重复填写；已运行任务保留启动时的模型。
                </p>
                <p className="mw-muted">
                  单个聊天的临时模型选择不会改变宿主默认模型。所有真实任务均通过
                  Harness Session 执行。
                </p>
              </div>
            )}
            <div className="mw-connection-list">
              <GitHubConnection refreshKey={busy} />
              <div>
                执行环境<Tag>{native ? "Harness 原生 Agent" : "独立预览"}</Tag>
              </div>
            </div>
          </>
        )}
      </section>}
      {scope === "global" && (panel === "all" || panel === "automation" || panel === "execution") && (
        <form
          className="mw-settings-card"
          onSubmit={(e) => {
            e.preventDefault();
            save(settings);
          }}
        >
          <div className="mw-section-title">
            <Settings2 size={19} />
            {panel === "automation" ? "自动化与同步" : "全局默认执行策略"}
          </div>
          <div className="mw-form-grid">
            {!native && panel !== "automation" && (
              <>
                <label>
                  模型提供方
                  <input
                    value={settings.provider}
                    onChange={(e) =>
                      setSettings({ ...settings, provider: e.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  模型名称
                  <input
                    value={settings.model}
                    onChange={(e) =>
                      setSettings({ ...settings, model: e.target.value })
                    }
                    required
                  />
                </label>
              </>
            )}
            {panel !== "automation" && <><label>
              并发任务
              <input
                type="number"
                min="1"
                max="4"
                value={settings.concurrency}
                onChange={(e) =>
                  setSettings({ ...settings, concurrency: +e.target.value })
                }
              />
            </label>
            <label>
              每批任务上限
              <input
                type="number"
                min="1"
                max="50"
                value={settings.maxJobsPerBatch}
                onChange={(e) =>
                  setSettings({ ...settings, maxJobsPerBatch: +e.target.value })
                }
              />
            </label></>}
            {panel !== "execution" && <><label>
              同步记录上限（0 表示无上限）
              <input
                type="number"
                min="0"
                max="1000000"
                value={settings.syncLimit ?? 1000}
                onChange={(e) =>
                  setSettings({ ...settings, syncLimit: +e.target.value })
                }
              />
            </label>
            <label>
              定时同步（分钟，0 表示关闭）
              <input
                type="number"
                min="0"
                max="1440"
                value={settings.syncIntervalMinutes}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    syncIntervalMinutes: +e.target.value,
                  })
                }
              />
            </label>
            <label className="mw-check-label">
              <input
                type="checkbox"
                checked={settings.autoTriage}
                onChange={(e) =>
                  setSettings({ ...settings, autoTriage: e.target.checked })
                }
              />
              自动分诊新增或已更新的 Issue
            </label>
            <label className="mw-check-label">
              <input
                type="checkbox"
                checked={settings.autoPreflight ?? false}
                onChange={(e) =>
                  setSettings({ ...settings, autoPreflight: e.target.checked })
                }
              />
              自动快速预检新增或已更新的 PR
            </label>
            <p className="mw-muted">
              手动或定时同步后自动派发，后台按批补齐。结果保存在本机，未变化的版本直接复用；失败后需手动重试。分诊使用模型并产生费用，不会自动修改代码或发布。
            </p>
            </>}
          </div>
          {panel !== "automation" && <details className="mw-advanced">
            <summary>高级执行选项（通常无需修改）</summary>
            <div className="mw-form-grid">
              <label>
                超时时间（秒）
                <input
                  type="number"
                  min="1"
                  max="1800"
                  value={settings.timeoutMs / 1000}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      timeoutMs: +e.target.value * 1000,
                    })
                  }
                />
              </label>
              <label>
                分诊 / PR 预检输出 Token 上限
                <input
                  type="number"
                  min="500"
                  max="8000"
                  value={settings.triageMaxTokens ?? 1800}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      triageMaxTokens: +e.target.value,
                    })
                  }
                />
              </label>
              <label>
                每次请求输出 Token 上限
                <input
                  type="number"
                  min="500"
                  max="32000"
                  value={settings.maxTokens}
                  onChange={(e) =>
                    setSettings({ ...settings, maxTokens: +e.target.value })
                  }
                />
              </label>
              <label>
                Harness Agent preset
                <input
                  value={settings.agentPreset}
                  onChange={(e) =>
                    setSettings({ ...settings, agentPreset: e.target.value })
                  }
                />
              </label>
              <label>
                修复任务权限 preset
                <input
                  value={settings.permissionPreset}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      permissionPreset: e.target.value,
                    })
                  }
                />
              </label>
            </div>
            <p className="mw-muted">
              Agent preset 填 inherit 跟随宿主默认（当前：
              {host?.agentPreset ?? "仅原生环境可用"}），自动复用该 preset
              的工具与 Skills。调查、审查使用 read-only；修复、文档的权限填
              inherit 时也跟随宿主默认。
            </p>
          </details>}
          {panel !== "automation" && <details className="mw-settings-note">
            <summary>执行权限与发布范围</summary>
            <div className="mw-callout amber">
            <ShieldCheck size={18} />
            <p>
              单次输出上限不等于总费用上限。执行遵循 Harness
              的权限策略；工作台不自动发布评论、推送分支或合并 PR。
            </p>
          </div>
          </details>}
          <button className="mw-button primary" disabled={busy}>
            <Check size={15} />
            保存设置
          </button>
        </form>
      )}
      {scope === "global" && (panel === "all" || panel === "workspaces") && <WorkspacesPanel />}
    </div>
  );
}
