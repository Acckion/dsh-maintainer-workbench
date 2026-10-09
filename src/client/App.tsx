import { nextIssueStage, planBlocker } from "../core/issue-flow.ts";
import { taskGroups, type TaskFilter } from "./task-presentation.ts";
import { RepositoryDetail } from "./RepositoryDetail.tsx";
import { RepositoryOrganize } from "./RepositoryOrganize.tsx";
import { Attention, RepositoryPolicy } from "./Attention.tsx";
import { ExecutionEvidence } from "./ExecutionEvidence.tsx";
import { WorkflowPanel } from "./WorkflowPanel.tsx";
import {
  PublicationConfirm,
  publicationPreviewCurrent,
  type PublicationPreview,
} from "./PublicationConfirm.tsx";
import {
  AcceptArtifactButton,
  ReviewSummary,
  type DetailTab,
} from "./ReviewSummary.tsx";
import {
  acceptanceEligibility,
  executionExplanation,
  reviewQueue,
  selectedAnalysis,
  taskStatus,
} from "./review-evidence.ts";
import { OperationTracker, type OperationRecord } from "./OperationTracker.tsx";
import {
  operationFailureRecord,
  operationRecordFromResponse,
  pageSearchKey,
  restoreInboxContext,
  reviewNoteForTask,
} from "./operation-state.ts";
import {
  captureOrigin,
  focusDetail,
  restoreOrigin,
  type NavigationOrigin,
} from "./navigation-origin.ts";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  ExternalLink,
  FileCheck2,
  FileCode2,
  Filter,
  GitBranch,
  GitPullRequest,
  Inbox,
  Layers3,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  TriangleAlert,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  Analysis,
  Issue,
  Job,
  JobKind,
  Settings,
  Snapshot,
} from "../core/types.ts";
import { kindNames } from "../core/types.ts";
const API = "/maintainer/api";
const categoryNames: Record<string, string> = {
  bug: "缺陷",
  feature: "功能",
  docs: "文档",
  question: "提问",
  maintenance: "维护",
};
type Page =
  | "organize"
  | "attention"
  | "inbox"
  | "tasks"
  | "reviews"
  | "activity"
  | "settings"
  | "repository-settings";
function date(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function elapsed(job: Job) {
  if (!job.startedAt) return "—";
  return `${Math.max(1, Math.round((new Date(job.finishedAt ?? Date.now()).getTime() - new Date(job.startedAt).getTime()) / 1000))}s`;
}
async function request(path: string, data?: unknown) {
  const response = await fetch(
    API + path,
    data === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "请求失败");
  return result;
}
function Modal({
  title,
  busy,
  close,
  children,
}: {
  title: string;
  busy: boolean;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className="mw-modal-backdrop"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      {children}
    </dialog>
  );
}
function CopyDraft({ text }: { text: string }) {
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    setFeedback("");
  }, [text]);
  return (
    <button
      className="mw-text-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setFeedback("已复制");
        } catch {
          setFeedback("复制失败，请手动选择文本");
        }
      }}
    >
      <CheckCheck size={14} />
      {feedback || "复制草稿"}
    </button>
  );
}
function Tag({
  children,
  tone = "",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`mw-tag ${tone}`}>{children}</span>;
}
function GitHubConnection({
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
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="mw-empty">
      <Layers3 size={30} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Result({
  result,
  classification = true,
  summary = true,
}: {
  result: Analysis;
  classification?: boolean;
  summary?: boolean;
}) {
  return (
    <div className="mw-result">
      <div className="mw-section-title">
        <Sparkles size={15} /> {summary ? "分析结论" : "建议与回复"}{" "}
      </div>
      {summary && <p className="mw-summary">{result.summary}</p>}
      {classification && (
        <div className="mw-tags">
          <Tag
            tone={
              result.priority === "P0" || result.priority === "P1"
                ? "red"
                : "violet"
            }
          >
            {result.priority}
          </Tag>
          <Tag>{categoryNames[result.category]}</Tag>
          {result.labels.map((l) => (
            <Tag key={l}>{l}</Tag>
          ))}
        </div>
      )}
      {result.duplicateOf && (
        <div className="mw-callout amber">
          <Layers3 size={17} />
          <div>
            <strong>可能与 #{result.duplicateOf} 重复</strong>
            <p>{result.duplicateReason}</p>
          </div>
        </div>
      )}
      {result.missingInfo.length > 0 && (
        <section>
          <h4>还需要的信息</h4>
          <ul>
            {result.missingInfo.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      )}
      {result.nextSteps.length > 0 && (
        <section>
          <h4>建议下一步</h4>
          <ol>
            {result.nextSteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </section>
      )}
      {result.tests.length > 0 && (
        <section>
          <h4>
            测试记录 <span className="mw-muted">· Agent 报告，需核对日志</span>
          </h4>
          {result.tests.map((t, i) => (
            <div className="mw-test" key={i}>
              <Tag
                tone={
                  t.status === "passed"
                    ? "green"
                    : t.status === "failed"
                      ? "red"
                      : ""
                }
              >
                {t.status === "passed"
                  ? "报告通过"
                  : t.status === "failed"
                    ? "报告失败"
                    : "未执行"}
              </Tag>
              <code>{t.command}</code>
              <p>{t.output}</p>
            </div>
          ))}
        </section>
      )}
      <details className="mw-response-draft">
        <summary>
          回复草稿
          {result.responseDraft.trim() && (
            <span className="mw-muted"> · 草稿，尚未发布</span>
          )}
        </summary>
        {result.responseDraft.trim() ? (
          <>
            <div className="mw-draft">{result.responseDraft}</div>
            <CopyDraft text={result.responseDraft} />
          </>
        ) : (
          <p className="mw-muted">
            暂无需要向作者发布的内容，可继续处理下一阶段。
          </p>
        )}
      </details>
    </div>
  );
}
export function App({
  openSession,
}: { openSession?: (id: string) => void } = {}) {
  const [state, setState] = useState<Snapshot>();
  const [page, setPage] = useState<Page>("inbox");
  const [repoId, setRepoId] = useState(() => {
    try {
      return localStorage.getItem("maintainer.repository") ?? "";
    } catch {
      return "";
    }
  });
  const [connectionResults, setConnectionResults] = useState<
    { fullName: string; repoId?: string; error?: string }[]
  >([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [focused, setFocused] = useState<string>();
  const [jobFocus, setJobFocus] = useState<string>();
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("attention");
  const [assistantInstructions, setAssistantInstructions] = useState<Record<string,string>>({});
  const [showQuickTasks, setShowQuickTasks] = useState(false);
  const [pageSearch, setPageSearch] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("all");
  const [type, setType] = useState("all");
  const [listLimit, setListLimit] = useState(50);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("overview");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();
  const [connect, setConnect] = useState(false);
  const [repoInput, setRepoInput] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [publishAction, setPublishAction] = useState<
    "comment" | "labels" | "pr" | "update_pr" | "review"
  >();
  const [publishPreview, setPublishPreview] = useState<PublicationPreview>();
  const [publishPreviewError, setPublishPreviewError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [operationRecords, setOperationRecords] = useState<
    Record<string, OperationRecord>
  >(() => {
    try {
      return JSON.parse(
        localStorage.getItem("maintainer.operation-tracker") ?? "{}",
      );
    } catch {
      return {};
    }
  });
  const mainRef = useRef<HTMLElement>(null);
  const originRef = useRef<NavigationOrigin>();
  const refreshInFlight = useRef<Promise<void>>();
  const navigationGeneration = useRef(0);
  // Keep async delivery guards independent from React's render-time closures.
  const currentContext = useRef({ repoId, page });
  currentContext.current = { repoId, page };
  const searchKey = pageSearchKey(repoId, page);
  const search = pageSearch[searchKey] ?? "";
  useEffect(() => {
    setListLimit(50);
  }, [page, repoId, search, filter, type]);

  const setSearchValue = (value: string) =>
    setPageSearch((values) => ({ ...values, [searchKey]: value }));
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const pending = request("/state")
      .then((snapshot) => {
        setState(snapshot);
        setLoadError("");
      })
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => {
        refreshInFlight.current = undefined;
      });
    refreshInFlight.current = pending;
    return pending;
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    if (state && !state.repos.some((r) => r.id === repoId))
      navigate(page, state.repos[0]?.id ?? "");
  }, [state, repoId]);
  useEffect(() => {
    setSelected([]);
    setFocused(undefined);
    setJobFocus(undefined);
    setFilter("all");
    setType("all");
    setPublishAction(undefined);
    setReviewNote("");
    try {
      localStorage.setItem("maintainer.repository", repoId);
    } catch {}
  }, [repoId]);
  useEffect(() => {
    if (page === "inbox" || !jobFocus) return;
    const frame = requestAnimationFrame(() => {
      const detail = document.getElementById("mw-detail") as HTMLElement | null;
      detail?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [jobFocus, page]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "maintainer.operation-tracker",
        JSON.stringify(operationRecords),
      );
    } catch {}
  }, [operationRecords]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = (
    nextPage: Page,
    nextRepoId = currentContext.current.repoId,
    preserveOrigin = false,
  ) => {
    const previous = currentContext.current;
    if (previous.page !== nextPage || previous.repoId !== nextRepoId)
      navigationGeneration.current += 1;
    if (
      !preserveOrigin &&
      (previous.repoId !== nextRepoId || previous.page !== nextPage)
    )
      originRef.current = undefined;
    currentContext.current = { repoId: nextRepoId, page: nextPage };
    if (nextRepoId !== previous.repoId) setRepoId(nextRepoId);
    if (nextPage !== previous.page) setPage(nextPage);
  };
  const moveFocusToDetail = () =>
    focusDetail({
      frame: requestAnimationFrame,
      focus: (id) => {
        const element = document.getElementById(id) as HTMLElement | null;
        element?.focus({ preventScroll: true });
        return document.activeElement === element;
      },
    });
  const rememberOrigin = (focus = page === "inbox" ? focused : jobFocus) => {
    if (!["inbox", "reviews", "tasks"].includes(page)) return;
    originRef.current = captureOrigin(originRef.current, {
      repoId,
      page: page as NavigationOrigin["page"],
      search,
      filter,
      type,
      selected,
      focused: focus,
      scrollTop: mainRef.current?.scrollTop ?? 0,
      listScrollTop: (document.getElementById(`mw-list-${page}`)?.querySelector(".mw-issues") ?? document.getElementById(`mw-list-${page}`))?.scrollTop ?? 0,
      areaScrollTop: document.getElementById(`mw-list-${page}`)?.parentElement?.scrollTop ?? 0,
      taskFilter,
      showQuickTasks,
      focusId: focus ? `mw-item-${focus}` : `mw-list-${page}`,
    });
  };
  const returnToOrigin = () => {
    navigationGeneration.current += 1;
    const origin = originRef.current;
    originRef.current = undefined;
    setJobFocus(undefined);
    if (!origin || origin.repoId !== currentContext.current.repoId) {
      setFocused(undefined);
      return;
    }
    // Compute this key from the destination, rather than the source closure.
    navigate(origin.page, origin.repoId, true);
    setPageSearch((values) => ({
      ...values,
      [pageSearchKey(origin.repoId, origin.page)]: origin.search,
    }));
    if (origin.taskFilter) setTaskFilter(origin.taskFilter as TaskFilter);
    if (origin.showQuickTasks !== undefined) setShowQuickTasks(origin.showQuickTasks);
    setFilter(origin.filter);
    setType(origin.type);
    setSelected(origin.selected);
    if (origin.page === "inbox") setFocused(origin.focused);
    else setJobFocus(origin.focused);
    restoreOrigin(origin, repoId, {
      frame: (callback) =>
        requestAnimationFrame(() => requestAnimationFrame(callback)),
      scrollTo: (top) => {
        mainRef.current?.scrollTo({top});
        const list = document.getElementById(`mw-list-${origin.page}`);
        (list?.querySelector(".mw-issues") ?? list)?.scrollTo({top:origin.listScrollTop ?? 0});
        list?.parentElement?.scrollTo({top:origin.areaScrollTop ?? 0});
      },
      focus: (id) => {
        const element = document.getElementById(id) as HTMLElement | null;
        element?.focus({ preventScroll: true });
        return document.activeElement === element;
      },
    });

  };
  async function action(
    label: string,
    path: string,
    data: unknown,
    success = "已完成",
  ) {
    if (busy) return;
    const actionRepoId = currentContext.current.repoId,
      actionNavigation = navigationGeneration.current;
    setBusy(label);
    try {
      const result = await request(path, data);
      await refresh();
      if (
        ["/jobs", "/classify", "/retry", "/rerun"].includes(path) &&
        (Array.isArray(result.created) ||
          Array.isArray(result.reused) ||
          Array.isArray(result.errors))
      ) {
        const record = operationRecordFromResponse(result);
        setOperationRecords((records) => ({
          ...records,
          [actionRepoId]: record,
        }));
      }
      if (
        result.delivery?.implementationJobId &&
        currentContext.current.repoId === actionRepoId &&
        navigationGeneration.current === actionNavigation
      ) {
        rememberOrigin();
        navigate("tasks", actionRepoId, true);
        setFocused(undefined);
        setJobFocus(result.delivery.implementationJobId);
        setDetailTab("overview");
        setPublishAction(undefined);
        setReviewNote("");
        setToast({
          text: "审查已接受，已打开同一补丁的实施产物，请确认后预览发布",
        });
      } else if (result.deliveryBlockedReason)
        setToast({
          text: `审查已接受，交接仍需处理：${result.deliveryBlockedReason}`,
          error: true,
        });
      else setToast({ text: success });
      return result;
    } catch (e) {
      if (["/jobs", "/classify", "/retry", "/rerun"].includes(path)) {
        const ids = ["/retry", "/rerun"].includes(path)
          ? [String((data as { id?: string }).id ?? "retry")]
          : ((data as { issueIds?: string[] }).issueIds ?? ["dispatch"]);
        setOperationRecords((records) => ({
          ...records,
          [actionRepoId]: operationFailureRecord(ids, e),
        }));
      }
      setToast({ text: (e as Error).message, error: true });
    } finally {
      setBusy("");
    }
  }
  const repo = state?.repos.find((r) => r.id === repoId);
  const issues = state?.issues.filter((i) => i.repoId === repoId) ?? [];
  const jobs = state?.jobs.filter((j) => j.repoId === repoId) ?? [];
  const pending = reviewQueue(jobs);
  const running = jobs.filter((j) => ["running", "queued"].includes(j.status));
  const open = issues.filter((i) => i.state === "open" && !i.origin);
  const triaged = open.filter((i) => i.type === "issue" && i.analysis);
  const filtered = issues.filter(
    (i) =>
      (filter === "closed" ? i.state === "closed" : i.state === "open") &&
      (type === "all" || i.type === type) &&
      (filter !== "untriaged" || !i.analysis) &&
      (filter !== "priority" ||
        ["P0", "P1"].includes(i.analysis?.priority ?? "")) &&
      (filter !== "duplicates" || i.analysis?.duplicateOf) &&
      `${i.title} ${i.number} ${i.labels.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const issue = issues.find((i) => i.id === focused);
  const job =
    jobs.find((j) => j.id === jobFocus) ??
    (issue ? jobs.find((j) => j.issueId === issue.id) : undefined);
  const previewJob = jobs.find((item) => item.id === publishPreview?.id);
  const displayedIssue = page === "inbox" ? issue : issues.find(i => i.id === job?.issueId) ?? job?.issueSnapshot;
  const result = selectedAnalysis(page === "inbox" ? issue : undefined, job);
  const openEvidenceJob = (id: string, tab: DetailTab) => {
    if (!jobs.some((item) => item.id === id && item.issueId === job?.issueId))
      return;
    navigationGeneration.current += 1;
    rememberOrigin();
    navigate("tasks", repoId, true);
    setTaskFilter("all");
    setFocused(undefined);
    setJobFocus(id);
    setDetailTab(tab);
    setPublishAction(undefined);
    if (id !== job?.id) setReviewNote("");
    moveFocusToDetail();
  };
  const groups = taskGroups(jobs, showQuickTasks);
  const visibleGroups = groups.filter(group => (page === "reviews" ? group.state === "attention" : taskFilter === "all" || group.state === taskFilter))
    .filter(group => group.members.some(j => `${j.issueSnapshot.title} ${j.issueSnapshot.number} ${kindNames[j.kind]}`.toLowerCase().includes(search.toLowerCase())));
  const listJobs = visibleGroups.map(group => group.latest);
  async function openPublishPreview(
    publishKind: NonNullable<typeof publishAction>,
  ) {
    if (!job || busy) return;
    const preview = await action(
      "publish-preview",
      "/publish/preview",
      { id: job.id, action: publishKind },
      "已重新核对发布输入，请确认预览内容",
    );
    if (preview) {
      setPublishPreview(preview);
      setPublishPreviewError("");
      setPublishAction(publishKind);
    }
  }
  async function enqueue(kind: JobKind, ids = selected, forceNew = false) {
    const requestContext = {
      ...currentContext.current,
      navigation: navigationGeneration.current,
      ids,
    };
    const response = await action(
      "dispatch",
      kind === "triage" ? "/classify" : "/jobs",
      { issueIds: ids, kind, forceNew },
      "任务已进入队列",
    );
    if (response) {
      const record: OperationRecord = {
        ids: response.created ?? [],
        reused: response.reused ?? [],
        errors: response.errors ?? [],
        at: new Date().toISOString(),
      };
      setToast({
        text: `已记录本次派发：新建 ${record.ids.length}，复用 ${record.reused.length}，失败 ${record.errors.length}`,
      });
      if (
        currentContext.current.repoId === requestContext.repoId &&
        currentContext.current.page === requestContext.page &&
        navigationGeneration.current === requestContext.navigation
      )
        setSelected((current) =>
          current.filter((id) => !requestContext.ids.includes(id)),
        );
    }
  }
  const nav = [
    { id: "inbox", label: "Issues & PRs", icon: Inbox, count: open.length },
    { id: "organize", label: "Repository", icon: FileCheck2, count: 0 },
    { id: "tasks", label: "Tasks", icon: Layers3, count: groups.filter(g => g.state === "attention").length },
    { id: "repository-settings", label: "仓库设置", icon: Settings2, count: 0 },
  ] as const;
  return (
    <div className="mw mw-layout-tabs">
      <div className="mw-shell">
        <header className="mw-header">
          <div className="mw-header-controls">
            <div className="mw-header-brand">
              <GitBranch size={20} />
              <strong>Maintainer</strong>
              <small>v{state?.version ?? "…"}</small>
            </div>
            <div className="mw-repo-switch">
              <Code2 size={16} />
              <select
                aria-label="选择仓库"
                value={repoId}
                onChange={(e) => navigate(page, e.target.value)}
              >
                {!state?.repos.length && <option value="">选择仓库</option>}
                {state?.repos.map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
            <button
              title="接入仓库"
              aria-label="接入仓库"
              className="mw-button"
              onClick={(e) => {
                e.currentTarget.focus();
                setConnectionResults([]);
                setRepoInput("");
                setConnect(true);
              }}
            >
              <Plus size={15} />
            </button>
            <div className="mw-header-status">
              <span className="mw-dot" />
              {state?.capabilities.model
                ? state.capabilities.modelName
                : "模型未配置"}
            </div>
            <button
              className={`mw-button ${page === "settings" ? "active" : ""}`}
              aria-label="全局设置"
              onClick={() => navigate("settings")}
            >
              <Settings2 size={16} />
            </button>
          </div>
          <nav className="mw-global-tabs" aria-label="工作台页面">
            {nav.map((n) => (
              <button
                key={n.id}
                aria-current={(page === n.id || n.id === "tasks" && page === "reviews") ? "page" : undefined}
                className={`${page === n.id || n.id === "tasks" && page === "reviews" ? "active" : ""} ${n.id === "repository-settings" ? "mw-repo-settings-tab" : ""}`}
                onClick={() => {
                  navigate(n.id);
                  setFocused(undefined);
                  setJobFocus(undefined);
                  setSearchValue("");
                  setDetailOpen(false);
                }}
              >
                <n.icon size={16} />
                {n.label}
                {n.count > 0 && <span>{n.count}</span>}
              </button>
            ))}
            <button
              className="mw-tab-sync"
              disabled={
                !!busy || !repo || (repo.mode === "local" && !repo.githubName)
              }
              onClick={() =>
                void action(
                  "sync",
                  "/sync",
                  { fullName: repo?.githubName ?? repo?.fullName },
                  "仓库同步完成",
                )
              }
            >
              <RefreshCw
                size={15}
                className={busy === "sync" ? "mw-spin" : ""}
              />
              同步仓库
            </button>
          </nav>
        </header>
        <main
          id="mw-main"
          tabIndex={-1}
          ref={mainRef}
          className={`mw-main ${["inbox", "tasks", "reviews"].includes(page) ? "mw-queue-page" : ""}`}
          data-page={page}
        >
          {loadError && (
            <div className="mw-callout red">
              <TriangleAlert size={18} />
              <span>
                连接中断：{loadError}。正在重试，当前显示上次成功读取的数据。
              </span>
            </div>
          )}
          {repo?.discovered && (
            <details className="mw-workspace-notice">
              <summary>工作区 · {repo.localPath}</summary>
              <div>
                <strong>自动发现 · {repo.localPath}</strong>
                <p>
                  {repo.localKind === "folder"
                    ? "普通文件夹：可执行只读仓库检查。"
                    : `当前分支：${repo.defaultBranch} · ${repo.dirty ? "有未提交修改：可只读检查；隔离修改暂需提交后执行" : "工作区干净，可执行隔离任务"}`}
                </p>
                <p>
                  {repo.githubName
                    ? `GitHub：${repo.githubName}，同步时复用已有登录`
                    : repo.remoteCandidates?.length
                      ? "存在多个 GitHub 远端，暂不自动选择协作目标。"
                      : "本地模式，无需 GitHub 登录。"}
                </p>
              </div>
            </details>
          )}
          {repo?.syncWarning && (
            <details className="mw-compact-notice">
              <summary>同步详情</summary>
              <p>{repo.syncWarning}</p>
            </details>
          )}
          {!state ? (
            <Empty title="正在连接工作台" text="读取仓库与任务状态…" />
          ) : state.repos.length === 0 && page !== "settings" ? (
            <section className="mw-onboarding">
              <GitBranch size={40} />
              <h2>自动发现 Harness 工作区</h2>
              <p>
                在 Harness 添加或打开开发目录，插件会自动识别。
                <br />
                无需先连接 GitHub；也可手动添加其他远程仓库。
              </p>
              <button
                className="mw-button primary"
                onClick={(e) => {
                  e.currentTarget.focus();
                  setConnectionResults([]);
                  setRepoInput("");
                  setConnect(true);
                }}
              >
                <Plus size={16} />
                添加其他远程仓库
              </button>
            </section>
          ) : (
            <>
              <OperationTracker
                record={operationRecords[repoId]}
                jobs={jobs}
                close={() =>
                  setOperationRecords((records) => {
                    const next = { ...records };
                    delete next[repoId];
                    return next;
                  })
                }
                open={(id) => {
                  navigationGeneration.current += 1;
                  rememberOrigin(id);
                  navigate("tasks", repoId, true);
    setTaskFilter("all");
                  setFocused(undefined);
                  setJobFocus(id);
                  setDetailTab("overview");
                  setReviewNote(reviewNoteForTask(jobFocus, id, reviewNote));
                  moveFocusToDetail();
                }}
              />
              {page === "organize" && (
                <RepositoryOrganize
                  state={state}
                  repoId={repoId}
                  busy={!!busy}
                  run={async (data) => {
                    const r = await action(
                      "organize",
                      "/organize",
                      data,
                      "整理任务已派发",
                    );
                    if (r) {
                      setPage("tasks");
                      setTaskFilter("all");
                      setJobFocus(r.created[0] ?? r.reused[0]);
                    }
                  }}
                  open={(id) => {
                    setPage("tasks");
                    setTaskFilter("all");
                    setJobFocus(id);
                  }}
                />
              )}
              {page === "attention" && (
                <Attention
                  state={state}
                  open={(id) => {
                    navigate("inbox", id);
                  }}
                />
              )}
              {page === "inbox" && (
                <div className="mw-workarea">
                  <section
                    id="mw-list-inbox"
                    tabIndex={-1}
                    className="mw-list-panel"
                  >
                    <div className="mw-panel-top">
                      <div className="mw-tabs">
                        <button
                          className={type === "all" ? "active" : ""}
                          onClick={() => setType("all")}
                        >
                          全部 <span>{open.length}</span>
                        </button>
                        <button
                          className={type === "issue" ? "active" : ""}
                          onClick={() => setType("issue")}
                        >
                          Issues
                        </button>
                        <button
                          className={type === "pr" ? "active" : ""}
                          onClick={() => setType("pr")}
                        >
                          Pull Requests
                        </button>
                      </div>
                      <span className="mw-muted">
                        {repo?.syncedAt
                          ? `同步于 ${date(repo.syncedAt)}`
                          : "尚未同步"}
                      </span>
                    </div>
                    <div className="mw-toolbar">
                      <label className="mw-search">
                        <Search size={16} />
                        <input
                          placeholder="搜索标题、编号或标签…"
                          aria-label="搜索问题"
                          value={search}
                          onChange={(e) => setSearchValue(e.target.value)}
                        />
                      </label>
                      <label className="mw-filter">
                        <Filter size={14} />
                        <select
                          aria-label="筛选问题"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                        >
                          <option value="all">所有开放问题</option>
                          <option value="untriaged">尚未分诊</option>
                          <option value="priority">高优先级</option>
                          <option value="duplicates">疑似重复</option>
                          <option value="closed">已关闭</option>
                        </select>
                      </label>
                    </div>
                    <div className="mw-batch">
                      <label>
                        <input
                          type="checkbox"
                          aria-label="选择当前列表"
                          checked={
                            filtered.length > 0 &&
                            filtered
                              .slice(0, listLimit)
                              .every((i) => selected.includes(i.id))
                          }
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [
                                    ...new Set([
                                      ...selected,
                                      ...filtered
                                        .slice(0, listLimit)
                                        .map((i) => i.id),
                                    ]),
                                  ]
                                : selected.filter(
                                    (id) =>
                                      !filtered
                                        .slice(0, listLimit)
                                        .some((i) => i.id === id),
                                  ),
                            )
                          }
                        />
                        <span>
                          {selected.length
                            ? `已选 ${selected.length} 项`
                            : `${filtered.length} 条记录`}
                        </span>
                      </label>
                      <div>
                        <button
                          disabled={!selected.length || !!busy}
                          onClick={() => void enqueue("triage")}
                        >
                          <Sparkles size={14} />
                          分诊 / 预检
                        </button>
                        <button
                          disabled={!selected.length || !!busy}
                          onClick={() => void enqueue("investigate")}
                        >
                          <Search size={14} />
                          调查
                        </button>
                        <select
                          aria-label="更多批量操作"
                          value=""
                          disabled={!selected.length || !!busy}
                          onChange={(e) =>
                            e.target.value &&
                            void enqueue(
                              e.target.value.replace("rerun:", "") as JobKind,
                              selected,
                              e.target.value.startsWith("rerun:"),
                            )
                          }
                        >
                          <option value="">更多操作</option>
                          <option value="fix">修复与验证</option>
                          <option value="preflight">PR 预检</option>
                          <option value="review">PR 审查</option>
                          <option value="rerun:review">
                            重新运行 PR 审查（原始 PR）
                          </option>
                          <option value="validate">验证变更</option>
                          <option value="ci">诊断 CI</option>
                          <option value="docs">文档维护</option>
                        </select>
                      </div>
                    </div>
                    <div className="mw-issues" id="mw-inbox-items">
                      {filtered.slice(0, listLimit).map((i) => {
                        const current = jobs.find(
                          (j) =>
                            j.issueId === i.id &&
                            ["running", "queued"].includes(j.status),
                        );
                        return (
                          <div
                            className={`mw-issue-row ${focused === i.id ? "focused" : ""}`}
                            key={i.id}
                          >
                            <input
                              aria-label={`选择 #${i.number}`}
                              type="checkbox"
                              checked={selected.includes(i.id)}
                              onChange={(e) =>
                                setSelected((v) =>
                                  e.target.checked
                                    ? [...v, i.id]
                                    : v.filter((id) => id !== i.id),
                                )
                              }
                            />
                            <button
                              id={`mw-item-${i.id}`}
                              className="mw-issue-content"
                              onClick={() => {
                                rememberOrigin(i.id);
                                navigationGeneration.current += 1;
                                setFocused(i.id);
                                setJobFocus(undefined);
                                setDetailOpen(false);
                                setDetailTab("overview");
                                moveFocusToDetail();
                              }}
                            >
                              <div className="mw-issue-title">
                                {i.type === "pr" ? (
                                  <GitPullRequest
                                    size={17}
                                    className="mw-violet"
                                  />
                                ) : (
                                  <CircleDot size={17} className="mw-green" />
                                )}
                                <strong>{i.title}</strong>
                              </div>
                              <div className="mw-issue-meta">
                                <span>
                                  #{i.number} · {i.author}
                                </span>
                                {i.labels.slice(0, 2).map((l) => (
                                  <Tag key={l}>{l}</Tag>
                                ))}
                                <span className="mw-issue-comments">
                                  {i.comments} 条讨论
                                </span>
                              </div>
                            </button>
                            <div className="mw-row-status">
                              {current ? (
                                <Tag tone="violet">
                                  <Loader2 size={11} className="mw-spin" />{" "}
                                  {current.waitingReason ||
                                    taskStatus(current).label}
                                </Tag>
                              ) : i.analysis ? (
                                <>
                                  <Tag
                                    tone={
                                      i.analysis.priority === "P1" ? "red" : ""
                                    }
                                  >
                                    {i.analysis.priority}
                                  </Tag>
                                  <span className="mw-triaged">
                                    <CheckCheck size={13} />
                                    已分诊
                                  </span>
                                </>
                              ) : (
                                <span className="mw-untriaged">
                                  {i.workflow
                                    ? ((
                                        {
                                          review: "待审查",
                                          draft: "草稿阶段",
                                          blocked: "存在阻塞",
                                        } as Record<string, string>
                                      )[i.workflow.stage] ?? "已预检")
                                    : i.type === "pr"
                                      ? "待预检"
                                      : "待分诊"}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {filtered.length > listLimit && (
                        <button
                          className="mw-list-more"
                          onClick={() => setListLimit((v) => v + 50)}
                        >
                          加载更多 · 还有 {filtered.length - listLimit} 条
                        </button>
                      )}
                      {filtered.length === 0 && (
                        <Empty
                          title="这里暂时没有问题"
                          text="尝试更换筛选条件，或同步一个 GitHub 仓库。"
                        />
                      )}
                    </div>
                  </section>
                  {displayedIssue ? (
                    renderReader()
                  ) : (
                    <aside
                      className={`mw-detail mw-detail-placeholder${originRef.current ? " mw-return-available" : ""}`}
                    >
                      <div className="mw-detail-art">
                        <GitBranch size={38} />
                        <span>
                          <Sparkles size={16} />
                        </span>
                      </div>
                      <h3>选择 PR 或 Issue</h3>
                      <p>从左侧列表选择一项查看详情。</p>
                    </aside>
                  )}
                </div>
              )}
              {(page === "tasks" || page === "reviews") && (
                <div className="mw-workarea">
                  <section
                    id={`mw-list-${page}`}
                    tabIndex={-1}
                    className="mw-list-panel"
                  >
                    <div className="mw-panel-top">
                      <h3>
                        {"任务"}{" "}
                        <span>{listJobs.length}</span>
                      </h3>
                      <div className="mw-task-filters" aria-label="任务状态筛选">
                        {([['attention','需要我处理'],['running','正在运行'],['completed','已完成'],['failed','失败 / 已停止'],['all','全部']] as const).map(([value,label]) => <button className={taskFilter === value ? 'active' : ''} key={value} onClick={() => {setTaskFilter(value); if(page === 'reviews') setPage('tasks');}}>{label} <small>{groups.filter(g => value === 'all' || g.state === value).length}</small></button>)}
                      </div>
                      <details className="mw-task-options"><summary>显示选项</summary><label><input type="checkbox" checked={showQuickTasks} onChange={e => setShowQuickTasks(e.target.checked)}/>包含快速分诊与预检</label></details>
                      <label className="mw-search">
                        <Search size={16} />
                        <input
                          aria-label="搜索任务"
                          placeholder="搜索任务…"
                          value={search}
                          onChange={(e) => setSearchValue(e.target.value)}
                        />
                      </label>
                    </div>
                    {taskFilter === "attention" && issues.filter(i => i.state === "open" && !i.origin && (["decision","needs_info"].includes(i.workflow?.stage ?? "") || i.informationRequests?.some(r => r.state === "reply_received"))).map(i => <button className="mw-task-row mw-decision-row" key={`decision-${i.id}`} onClick={() => {navigate("inbox",repoId);setFocused(i.id);}}><div><strong>{i.title}</strong><p>#{i.number} · {i.workflow?.stage === "needs_info" ? "需要补充信息" : "需要确认目标"}</p></div></button>)}
                    {listJobs.length ? (
                      listJobs.slice(0, listLimit).map((j) => (
                        <button
                          key={j.id}
                          id={`mw-item-${j.id}`}
                          className={`mw-task-row ${visibleGroups.find(g => g.latest.id === j.id)?.members.some(m => m.id === jobFocus) ? "focused" : ""}`}
                          onClick={() => {
                            rememberOrigin(j.id);
                            navigationGeneration.current += 1;
                            setJobFocus(j.id);
                            setFocused(undefined);
                            setDetailTab("overview");
                            setReviewNote("");
                            moveFocusToDetail();
                          }}
                        >
                          <span
                            className={`mw-task-icon ${j.status === "running" ? "violet" : ""}`}
                          >
                            {j.status === "running" ? (
                              <Loader2 size={20} className="mw-spin" />
                            ) : (
                              <FileCode2 size={20} />
                            )}
                          </span>
                          <div>
                            <strong>{j.issueSnapshot.title}</strong>
                            <p>
                              {j.issueSnapshot.origin === "repository"
                                ? "仓库整理"
                                : `#${j.issueSnapshot.number}`}{" "}
                              <span>·</span> {kindNames[j.kind]} <span>·</span>{" "}
                              {visibleGroups.find(g => g.latest.id === j.id)?.members.length ?? 1} 个处理步骤
                            </p>
                            <small>
                              {j.engine ?? "等待执行器"} · {date(j.createdAt)} ·{" "}
                              {elapsed(j)}
                            </small>
                          </div>
                          <Tag tone={taskStatus(j).tone}>
                            {j.waitingReason || taskStatus(j).label}
                          </Tag>
                          <ChevronRight size={15} />
                        </button>
                      ))
                    ) : (
                      <Empty
                        title={
                          page === "reviews"
                            ? "暂时没有待审核结果"
                            : "还没有维护任务"
                        }
                        text="当前筛选下没有任务，可切换筛选或从 Issues & PRs 开始处理。"
                      />
                    )}
                    {listJobs.length > listLimit && (
                      <button
                        className="mw-list-more"
                        onClick={() => setListLimit((v) => v + 50)}
                      >
                        加载更多 · 还有 {listJobs.length - listLimit} 个任务
                      </button>
                    )}
                  </section>
                  {displayedIssue && job ? (
                    renderReader()
                  ) : (
                    <aside
                      className={`mw-detail mw-detail-placeholder${originRef.current ? " mw-return-available" : ""}`}
                    >
                      {originRef.current && (
                        <button
                          aria-label="返回来源列表"
                          onClick={returnToOrigin}
                        >
                          返回列表
                        </button>
                      )}
                      <ShieldCheck size={36} />
                      <h3>
                        {jobFocus
                          ? "任务已不在当前列表中"
                          : "选择任务"}
                      </h3>
                      <p>
                        {jobFocus
                          ? "该任务可能已删除或已切换仓库。你可以返回原来的列表继续处理。"
                          : "选择任务查看输入版本、执行证据、"}
                        <br />
                        代码差异与待审核草稿。
                      </p>
                    </aside>
                  )}
                </div>
              )}
              {page === "activity" && (
                <section className="mw-list-panel mw-activity">
                  <div className="mw-panel-top">
                    <h3>
                      工作区活动 <span>最近 250 条</span>
                    </h3>
                    <Tag>持久化审计</Tag>
                  </div>
                  {state.audit.map((a) => (
                    <div className="mw-audit-row" key={a.id}>
                      <span className="mw-audit-dot" />
                      <time>{date(a.at)}</time>
                      <div>
                        <strong>{a.detail}</strong>
                        <small>
                          {a.action}
                          {a.jobId ? ` · ${a.jobId.slice(0, 8)}` : ""}
                        </small>
                      </div>
                    </div>
                  ))}
                </section>
              )}
              {page === "repository-settings" && (
                <RepositoryPolicy
                  key={repoId}
                  state={state}
                  repoId={repoId}
                  busy={!!busy}
                  save={(value) =>
                    void action("policy", "/policy", value, "仓库策略已保存")
                  }
                />
              )}
              {(page === "settings" || page === "repository-settings") && (
                <SettingsView
                  key={page}
                  scope={
                    page === "repository-settings" ? "repository" : "global"
                  }
                  state={state}
                  repoId={repoId}
                  busy={!!busy}
                  prepare={() =>
                    void action(
                      "prepare",
                      "/prepare",
                      { repoId },
                      "独立仓库已准备完成",
                    )
                  }
                  save={(s) =>
                    void action("settings", "/settings", s, "设置已保存")
                  }
                  credentials={(c) =>
                    void action(
                      "credentials",
                      "/credentials",
                      c,
                      "连接配置已保存",
                    )
                  }
                  bind={(path) =>
                    void action(
                      "bind",
                      "/bind",
                      { repoId, localPath: path },
                      "工作区绑定成功",
                    )
                  }
                />
              )}
              {page === "settings" && (
                <section className="mw-repository-manager mw-repository-table">
                  <div className="mw-repository-toolbar">
                    <div className="mw-section-title">
                      <GitBranch size={19} />
                      已连接仓库 · {state.repos.length}
                    </div>
                    <button
                      className="mw-button"
                      disabled={!!busy}
                      onClick={() => {
                        setRepoInput("");
                        setConnectionResults([]);
                        setConnect(true);
                      }}
                    >
                      <Plus size={16} />
                      添加仓库
                    </button>
                  </div>
                  <p>
                    点击仓库切换工作区。Issue、任务、审核和本地克隆分别归属各自仓库；模型和
                    GitHub 登录由工作台共享。
                  </p>
                  <button
                    className="mw-button"
                    disabled={!!busy || !state.repos.length}
                    onClick={async () => {
                      const r = await action(
                        "sync-all",
                        "/sync-all",
                        {},
                        "全部仓库同步检查完成",
                      );
                      if (r) {
                        setConnectionResults(r.results);
                        setRepoInput(
                          state.repos.map((r) => r.fullName).join("\n"),
                        );
                        setConnect(true);
                      }
                    }}
                  >
                    同步全部仓库
                  </button>
                  <div className="mw-repository-list">
                    {state.repos.map((r) => (
                      <button
                        className={`mw-button ${r.id === repoId ? "is-current" : ""}`}
                        aria-pressed={r.id === repoId}
                        disabled={!!busy}
                        key={r.id}
                        onClick={() => {
                          navigate("repository-settings", r.id);
                        }}
                      >
                        <GitBranch size={16} />
                        <span className="mw-repository-name">
                          <strong>{r.fullName}</strong>
                          <small>
                            {r.mode === "local" && !r.githubName
                              ? "本地工作区"
                              : r.private
                                ? "私有仓库"
                                : "公开仓库"}{" "}
                            ·{" "}
                            {
                              state.issues.filter(
                                (i) => i.repoId === r.id && i.state === "open",
                              ).length
                            }{" "}
                            条开放记录
                          </small>
                        </span>
                        {r.id === repoId ? (
                          <Tag tone="green">
                            <Check size={12} />
                            当前仓库
                          </Tag>
                        ) : (
                          <ChevronRight size={16} />
                        )}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </main>
      </div>
      {toast && (
        <div role="status" className={`mw-toast ${toast.error ? "error" : ""}`}>
          {toast.error ? <TriangleAlert size={19} /> : <Check size={19} />}
          <span>{toast.text}</span>
          <button aria-label="关闭提示" onClick={() => setToast(undefined)}>
            <X size={16} />
          </button>
        </div>
      )}
      {detailOpen && displayedIssue && (
        <RepositoryDetail
          key={`${displayedIssue.id}:${displayedIssue.updatedAt}`}
          issue={displayedIssue}
          repository={
            state?.repos.find((r) => r.id === displayedIssue.repoId)
              ?.fullName ?? ""
          }
          hasGitHub={
            !displayedIssue.origin &&
            !!state?.repos.find(
              (r) =>
                r.id === displayedIssue.repoId &&
                (r.mode === "github" || r.githubName),
            )
          }
          close={() => setDetailOpen(false)}
          returnToList={originRef.current?.repoId === repoId ? returnToOrigin : undefined}
        renderAgentPanel={renderStage}
        renderAgentActions={renderStageActions}
          agentPanel={
            <>
              <WorkflowPanel
                key={displayedIssue.id}
                issue={
                  issues.find((i) => i.id === displayedIssue.id) ??
                  displayedIssue
                }
                job={job}
                history={jobs.filter((j) => j.issueId === displayedIssue.id)}
                busy={!!busy}
                act={(path, data, message) =>
                  action("workflow", path, data, message)
                }
              />
              {job?.error && <div className="mw-callout red">{job.error}</div>}
              {result && <Result result={result} />}
              <button
                className="mw-button"
                onClick={() => {
                  setDetailOpen(false);
                  setDetailTab("evidence");
                }}
              >
                查看 Agent 证据与审核
              </button>
            </>
          }
        />
      )}
      {publishAction && previewJob && (
        <Modal
          title="发布预览"
          busy={!!busy}
          close={() => setPublishAction(undefined)}
        >
          <div className="mw-modal" onClick={(e) => e.stopPropagation()}>
            <button
              disabled={!!busy}
              className="mw-modal-close"
              aria-label="关闭发布预览"
              onClick={() => setPublishAction(undefined)}
            >
              <X size={18} />
            </button>
            <h2>
              {
                {
                  comment: "发布回复到 GitHub",
                  labels: "应用建议标签",
                  pr: "创建草稿 Pull Request",
                  update_pr: "更新原 PR 分支",
                  review: "发布 PR 审查评论",
                }[publishAction]
              }
            </h2>
            <p>
              {repo?.fullName} · #{previewJob.issueSnapshot.number}
            </p>
            <div className="mw-publish-preview">
              {publishAction === "comment"
                ? previewJob.result?.responseDraft
                : publishAction === "labels"
                  ? previewJob.result?.labels.join(", ")
                  : publishAction === "review"
                    ? JSON.stringify(
                        {
                          summary: previewJob.artifact?.summary,
                          coverage: previewJob.artifact?.coverage,
                          findings:
                            previewJob.artifact?.stage === "review"
                              ? previewJob.artifact.findings.filter(
                                  (f) =>
                                    previewJob.findingDecisions?.[f.id] ===
                                    "accepted",
                                )
                              : [],
                        },
                        null,
                        2,
                      )
                    : publishAction === "update_pr"
                      ? `将已审核补丁提交并推送至现有 PR 分支 ${previewJob.prContext?.headRef}，不会强制推送。\n${previewJob.result?.summary}`
                      : `分支：${previewJob.branch}\n目标：${repo?.defaultBranch}\n将提交已审核差异、推送分支并创建草稿 PR。\n\n${previewJob.result?.summary}`}
            </div>
            <PublicationConfirm
              preview={publishPreview}
              job={previewJob}
              busy={!!busy}
              error={publishPreviewError}
              confirm={() => {
                if (!publicationPreviewCurrent(publishPreview, previewJob))
                  return;
                void action(
                  "publish",
                  "/publish",
                  {
                    id: previewJob.id,
                    action: publishAction,
                    previewStamp: publishPreview!.stamp,
                  },
                  "GitHub 发布结果已确认",
                ).then((r) => {
                  if (r) setPublishAction(undefined);
                  else
                    setPublishPreviewError(
                      "本次发布未确认完成。请查看错误提示，关闭后重新打开预览；重试会先核查已发布记录。",
                    );
                });
              }}
            />
          </div>
        </Modal>
      )}
      {connect && (
        <Modal
          title="连接 GitHub 仓库"
          busy={!!busy}
          close={() => setConnect(false)}
        >
          <form
            className="mw-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await action(
                "connect",
                "/sync-many",
                {
                  names: repoInput
                    .split(/[\n,，]+/)
                    .map((n) => n.trim())
                    .filter(Boolean),
                },
                "仓库连接检查完成",
              );
              if (r) {
                setConnectionResults(r.results);
                const connected = r.results.find(
                  (item: { repoId?: string }) => item.repoId,
                );
                if (connected) navigate(page, connected.repoId);
              }
            }}
          >
            <button
              disabled={!!busy}
              className="mw-modal-close"
              type="button"
              aria-label="关闭"
              onClick={() => setConnect(false)}
            >
              <X size={19} />
            </button>
            <span className="mw-modal-icon">
              <GitBranch size={24} />
            </span>
            <h2>连接 GitHub 仓库</h2>
            <p>
              同步 Issue 与
              PR，在一个工作台中组织维护任务。他人的公开仓库也可接入；发布回复、标签或推送代码需要相应权限，向他人仓库贡献代码通常需通过
              Fork 和 PR。
            </p>
            <label>
              GitHub 仓库（每行一个，最多 20 个）
              <textarea
                disabled={!!busy}
                required
                rows={4}
                placeholder={
                  "owner/repository\nhttps://github.com/owner/another-repository"
                }
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
              />
            </label>
            {connectionResults.map((item) => (
              <div
                className={`mw-callout mw-connect-result ${item.error ? "red" : ""}`}
                key={item.fullName}
              >
                {item.error ? <TriangleAlert size={16} /> : <Check size={16} />}
                <div>
                  <strong>{item.fullName}</strong>
                  <p>{item.error ?? "已连接，已保存到仓库列表"}</p>
                </div>
              </div>
            ))}
            <GitHubConnection configure />
            <button
              className="mw-button primary"
              disabled={!!busy || !repoInput.trim()}
            >
              {busy === "connect" ? (
                <Loader2 className="mw-spin" size={16} />
              ) : (
                <Plus size={16} />
              )}
              {busy === "connect"
                ? "正在连接，请稍候…"
                : connectionResults.length
                  ? "重新检查并同步"
                  : "连接并同步"}
            </button>
            {connectionResults.some((r) => r.repoId) && (
              <button
                type="button"
                className="mw-button"
                disabled={!!busy}
                onClick={() => setConnect(false)}
              >
                完成，返回工作台
              </button>
            )}
          </form>
        </Modal>
      )}
    </div>
  );

  function renderReader() {
    if (!displayedIssue) return null;
    return (
      <RepositoryDetail
        key={`${page}:${displayedIssue.id}:${jobFocus ?? ""}:${displayedIssue.updatedAt}`}
        embedded
        initialTab={
          page === "inbox"
            ? "triage"
            : page === "tasks"
              ? job?.kind === "review"
                ? "review"
                : "execution"
              : "review"
        }
        issue={displayedIssue}
        repository={
          state?.repos.find((r) => r.id === displayedIssue.repoId)?.fullName ??
          ""
        }
        hasGitHub={
          !displayedIssue.origin &&
          !!state?.repos.find(
            (r) =>
              r.id === displayedIssue.repoId &&
              (r.mode === "github" || r.githubName),
          )
        }
        close={() => {
          navigationGeneration.current += 1;
          setFocused(undefined);
          setJobFocus(undefined);
        }}
        returnToList={originRef.current?.repoId === repoId ? returnToOrigin : undefined}
        renderAgentPanel={renderStage}
        renderAgentActions={renderStageActions}
        agentPanel={renderDetail()}
      />
    );
  }

  function renderStageActions(stage: "triage" | "execution" | "review" | "assistant") {
    if (!displayedIssue) return null;
    if (stage === "assistant") {
      const active = jobs.find(j => j.issueId === displayedIssue.id && ["running", "queued"].includes(j.status));
      if (active) return <button className="mw-button" disabled={!!busy} onClick={() => void action("cancel", "/cancel", {id:active.id}, "任务已停止，已有产物保留")}>停止任务</button>;
      if (job && ["failed","cancelled","rejected"].includes(job.status)) return <button className="mw-button" disabled={!!busy || job.artifactState === "stale"} onClick={() => void action("retry", "/retry", {id:job.id}, "已重新派发任务")}>重试任务</button>;
      const category = displayedIssue.plan?.category ?? displayedIssue.analysis?.category;
      let primary: JobKind | undefined = displayedIssue.type === "pr" ? "review" : nextIssueStage(displayedIssue, job);
      if (!primary && displayedIssue.type !== "pr") primary = !displayedIssue.analysis ? "triage" : category === "question" ? undefined : category === "feature" ? undefined : "investigate";
      if (job && ["fix","docs"].includes(job.kind) && job.patch) primary = "validate";
      if (job?.kind === "validate" && job.artifact?.stage === "validate" && job.artifact.tests.length && job.artifact.tests.every(t => t.status === "passed") && !job.artifact.blockers.length) primary = "review";
      if (job?.kind === "review") primary = undefined;
      if (job?.artifactState === "stale") primary = displayedIssue.type === "pr" ? "preflight" : "triage";
      const labels: Partial<Record<JobKind,string>> = {triage:"分析此 Issue",preflight:"重新预检",review:"审查此 PR",investigate:"调查并修复",fix:"开始修复",docs:"检查并更新",validate:"验证改动"};
      if (category === "feature") labels.fix = "确认并实现";
      const secondary: JobKind[] = displayedIssue.type === "pr" ? ["preflight","review","ci"] : ["triage","investigate",...(category === "docs" ? ["docs" as JobKind] : [])];
      return <>
        {primary && <button className="mw-button primary" title={planBlocker(displayedIssue, primary)} disabled={!!busy || !!planBlocker(displayedIssue, primary)} onClick={() => void action("workflow", primary === "triage" ? "/classify" : "/jobs", {issueIds:[displayedIssue.id],kind:primary,sourceJobId:job?.result && job.artifactState !== "stale" ? job.id : undefined, instructions:assistantInstructions[displayedIssue.id], goal:["investigate","fix","docs"].includes(primary) ? "resolve" : undefined}, "已启动任务，结果会保存在此事项中")}>{labels[primary] ?? kindNames[primary]}</button>}
        <details className="mw-assistant-more"><summary>更多</summary><div>{secondary.filter(kind => kind !== primary).map(kind => <button key={kind} className="mw-button" disabled={!!busy || !!planBlocker(displayedIssue,kind)} onClick={() => void action("workflow", kind === "triage" ? "/classify" : "/jobs", {issueIds:[displayedIssue.id],kind,sourceJobId:job?.result && job.artifactState !== "stale" ? job.id : undefined,instructions:assistantInstructions[displayedIssue.id]}, "已启动所选操作")}>{kind === "preflight" ? "快速预检" : kindNames[kind]}</button>)}{job && <button className="mw-button" onClick={() => openEvidenceJob(job.id,"log")}>查看执行记录</button>}</div></details>
      </>;
    }
    if (stage === "review") return null;
    const kinds: JobKind[] = stage === "triage"
      ? (displayedIssue.type === "pr" ? ["preflight", "review"] : ["triage"])
      : displayedIssue.type === "pr" ? ["review", "ci"] : ["investigate", "fix"];
    return kinds.map(kind => (
      <button key={kind} className="mw-button" disabled={!!busy}
        onClick={() => void enqueue(kind, [displayedIssue.id])}>
        {kind === "review" ? "启动代码审查" : kindNames[kind]}
      </button>
    ));
  }

  function renderAssistant(history: Job[]) {
    if (!displayedIssue) return null;
    const active = history.find(j => ["running", "queued"].includes(j.status));
    const selected = job;
    const quick = !selected || ["triage", "preflight"].includes(selected.kind) && detailTab === "overview";
    const saved = selected?.result ?? displayedIssue.analysis;
    const category = displayedIssue.plan?.category ?? displayedIssue.analysis?.category;
    const needsPlan = displayedIssue.type === "issue" && category === "feature" && displayedIssue.plan?.decision !== "accepted";
    return <section className="mw-assistant" aria-label="Assistant 处理事项">
      <div className="mw-assistant-status" role="status">
        <strong>{active ? `${kindNames[active.kind]}中` : selected?.error ? "任务未完成" : selected?.artifactState === "stale" ? "结果对应旧版本" : needsPlan ? "需要确认需求" : selected?.result ? "结果已保存" : "尚未开始处理"}</strong>
        <span>{active?.waitingReason ?? (selected?.status === "approved" ? undefined : selected?.goalPauseReason) ?? (selected ? taskStatus(selected).label : displayedIssue.type === "pr" ? "审查此 PR 后显示具体发现" : "分析问题后选择处理方向")}</span>
      </div>
      {quick ? <>
        {saved ? <Result result={saved} classification /> : <p className="mw-assistant-intro">{displayedIssue.type === "pr" ? "查看变更范围、CI 和源码中的问题。" : "确认问题类型、影响和缺少的信息。"}</p>}
        <WorkflowPanel compact hideSummary issue={displayedIssue} job={selected} history={history} busy={!!busy} act={(path,data,message) => action("workflow",path,data,message)} />
      </> : renderDetail(true)}
      {selected?.error && quick && <p className="mw-callout red">{selected.error}</p>}
      {quick && <details><summary>验证与执行详情</summary>{selected?.result?.evidence.map((e,i) => <p key={i}>{e.detail}</p>)}{selected?.sessionId && openSession && <button className="mw-button" onClick={() => openSession(selected.sessionId!)}>打开 Harness 会话</button>}</details>}
      <details className="mw-assistant-instructions"><summary>补充本次要求</summary><label>给 Agent 的补充要求<textarea rows={3} value={assistantInstructions[displayedIssue.id] ?? ""} onChange={e => setAssistantInstructions(values => ({...values,[displayedIssue.id]:e.target.value}))} placeholder="已有调查与验收条件会自动传递，无需重复填写" /></label></details>
      <details className="mw-assistant-history"><summary>处理历史 · {history.length}</summary>{history.map(j => <button className="mw-task-row" key={j.id} onClick={() => openEvidenceJob(j.id,"overview")}><div><strong>{kindNames[j.kind]} · {taskStatus(j).label}</strong><small>{date(j.createdAt)}{j.artifactState === "stale" ? " · 旧版本" : ""}</small></div></button>)}</details>
    </section>;
  }

  function renderStage(stage: "triage" | "execution" | "review" | "assistant") {
    if (!displayedIssue) return null;
    const history = jobs.filter((j) => j.issueId === displayedIssue.id);
    if (stage === "assistant") return renderAssistant(history);
    const relevant = history.filter((j) =>
      stage === "triage"
        ? ["triage", "preflight"].includes(j.kind)
        : stage === "execution"
          ? ["investigate", "fix", "docs", "ci", "validate"].includes(j.kind)
          : j.kind === "review",
    );
    const latest = relevant[0];
    if (stage === "review")
      return (
        <>
          {relevant.length > 0 && (
            <div className="mw-stage-jobs">
              {relevant.map((j) => (
                <button
                  key={j.id}
                  className="mw-button"
                  onClick={() => openEvidenceJob(j.id, "overview")}
                >
                  审查 · {taskStatus(j).label} · {date(j.createdAt)}
                </button>
              ))}
            </div>
          )}
          <p className="mw-muted">
            核对补丁、验证结果和审查发现，再接受或退回本地产物。
          </p>
          {renderDetail()}
        </>
      );
    return (
      <section className="mw-stage-panel">
        {relevant.length > 0 && (
          <div className="mw-stage-jobs">
            {relevant.map((j) => (
              <button
                className="mw-button"
                key={j.id}
                onClick={() => openEvidenceJob(j.id, "overview")}
              >
                {kindNames[j.kind]} · {taskStatus(j).label} ·{" "}
                {date(j.createdAt)}
              </button>
            ))}
          </div>
        )}
        {latest?.error && <div className="mw-callout red">{latest.error}</div>}
        {latest?.result ? (
          <Result result={latest.result} classification={stage === "triage"} />
        ) : (
          <Empty
            title={stage === "triage" ? "尚无分诊结果" : "尚无执行结果"}
            text="选择上方操作启动对应阶段；切换页签不会调用模型。"
          />
        )}
        {stage === "triage" && (
          <WorkflowPanel
            hideSummary
            compact
            issue={displayedIssue}
            job={latest}
            history={history}
            busy={!!busy}
            act={(path, data, message) =>
              action("workflow", path, data, message)
            }
          />
        )}
        {stage === "execution" && latest && (
          <section>
            {state?.audit
              .filter((a) => a.jobId === latest.id)
              .slice()
              .reverse()
              .map((a) => (
                <div className="mw-job-log" key={a.id}>
                  <time>{date(a.at)}</time>
                  <p>{a.detail}</p>
                </div>
              ))}
          </section>
        )}
      </section>
    );
  }

  function renderDetail(assistantMode = false) {
    if (!displayedIssue) return null;
    const acceptance = job ? acceptanceEligibility(job, jobs) : undefined;
    const reviewActions = job && (
      <div className="mw-review-bar">
        {["awaiting_review", "completed"].includes(job.status) ? (
          <>
            <label>
              审核备注
              <input
                placeholder="可选：接受或退回的理由"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
              />
            </label>
            <div>
              <AcceptArtifactButton
                job={job}
                busy={!!busy}
                blockedReason={acceptance?.reason}
                accept={() =>
                  void action(
                    "approve",
                    "/review",
                    { id: job.id, decision: "approve", note: reviewNote },
                    "本地产物已接受，未执行外部发布",
                  )
                }
              />
              <button
                className="mw-button"
                disabled={!!busy}
                onClick={() =>
                  void action(
                    "reject",
                    "/review",
                    { id: job.id, decision: "reject", note: reviewNote },
                    "结果已退回",
                  )
                }
              >
                退回
              </button>
            </div>
            <p className="mw-muted">
              接受只保存本地决定，不代表测试通过，也不会自动发布。
            </p>
          </>
        ) : ["queued", "running"].includes(job.status) ? (
          <button
            className="mw-button"
            disabled={!!busy}
            onClick={() =>
              void action("cancel", "/cancel", { id: job.id }, "已请求停止任务")
            }
          >
            <Square size={13} />
            停止任务
          </button>
        ) : ["failed", "cancelled", "rejected"].includes(job.status) ? (
          <button
            className="mw-button"
            disabled={!!busy}
            onClick={() =>
              void action("retry", "/retry", { id: job.id }, "已创建重试任务")
            }
          >
            <RefreshCw size={14} />
            {executionExplanation(job, !!state?.capabilities.harness, [])
              .formatRetry
              ? "仅整理已保存输出"
              : "重新执行"}
          </button>
        ) : (
          <Tag tone={taskStatus(job).tone}>
            <CheckCheck size={14} /> {taskStatus(job).label}
          </Tag>
        )}
        {!["queued", "running"].includes(job.status) && (
          <button
            className="mw-button"
            disabled={!!busy}
            title="创建新的执行任务，沿用本任务来源和说明，保留旧结果；不会自动接受或发布"
            onClick={() =>
              void action(
                "rerun",
                "/rerun",
                { id: job.id },
                "已派发重新运行任务，请查看本次任务追踪",
              )
            }
          >
            <RefreshCw size={14} />
            重新运行
          </button>
        )}
        {job.status === "approved" && job.artifactState !== "stale" && (
          <div className="mw-publish-actions">
            <button
              className="mw-button"
              onClick={() => void openPublishPreview("comment")}
              disabled={!!busy}
            >
              发布回复
            </button>
            <button
              className="mw-button"
              onClick={() => void openPublishPreview("labels")}
              disabled={!!busy}
            >
              应用标签
            </button>
            {job.artifact?.stage === "review" && job.prContext && (
              <button
                className="mw-button"
                disabled={!!busy}
                onClick={() => void openPublishPreview("review")}
              >
                发布已采纳发现
              </button>
            )}
            {job.patch && ["fix", "docs"].includes(job.kind) && (
              <button
                className="mw-button primary"
                onClick={() =>
                  void openPublishPreview(
                    job.issueSnapshot.type === "pr" ? "update_pr" : "pr",
                  )
                }
                disabled={!!busy}
              >
                <GitPullRequest size={13} />
                {job.issueSnapshot.type === "pr" ? "更新原 PR" : "创建草稿 PR"}
              </button>
            )}
          </div>
        )}
        {job.publications &&
          Object.entries(job.publications).map(([key, receipt]) => (
            <div className="mw-publication" key={key}>
              {key} ·{" "}
              {receipt.status === "published"
                ? "已发布"
                : receipt.status === "failed"
                  ? "发布失败"
                  : "发布中 / 待核查"}
              {receipt.error && <p>{receipt.error}</p>}
              {receipt.urls.map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  查看 GitHub 结果 ↗
                </a>
              ))}
            </div>
          ))}
        <div className="mw-export-links">
          {job.sessionId && openSession && (
            <button
              className="mw-text-button"
              onClick={() => openSession(job.sessionId!)}
            >
              打开 Harness 会话 / 审批
            </button>
          )}
          <a href={`${API}/export/${job.id}`}>
            <ArrowDownToLine size={13} />
            导出结果
          </a>
          {job.patch && (
            <a href={`${API}/export/${job.id}?format=patch`}>下载补丁</a>
          )}
        </div>
      </div>
    );
    return (
      <aside id="mw-detail" tabIndex={-1} className={`mw-detail${assistantMode ? " mw-assistant-detail" : ""}`}>
        <div className="mw-detail-header">
          <span>
            {displayedIssue.origin === "repository"
              ? "仓库整理"
              : `${displayedIssue.type === "pr" ? "PULL REQUEST" : "ISSUE"} #${displayedIssue.number}`}{" "}
          </span>
          <div>
            {originRef.current && (
              <button aria-label="返回来源列表" onClick={returnToOrigin}>
                返回列表
              </button>
            )}
            {displayedIssue.url && (
              <a
                href={displayedIssue.url}
                target="_blank"
                rel="noreferrer"
                aria-label="在 GitHub 打开"
              >
                <ExternalLink size={15} />
              </a>
            )}
            <button
              aria-label="打开完整详情"
              onClick={() => setDetailOpen(true)}
            >
              <BookOpen size={17} />
            </button>
            <button
              aria-label="关闭详情"
              onClick={() => {
                if (originRef.current) {
                  returnToOrigin();
                  return;
                }
                navigationGeneration.current += 1;
                setFocused(undefined);
                setJobFocus(undefined);
              }}
            >
              <X size={17} />
            </button>
          </div>
        </div>
        <h2>{displayedIssue.title}</h2>
        <div className="mw-detail-meta">
          <span className="mw-avatar small">
            {displayedIssue.author[0]?.toUpperCase()}
          </span>
          {displayedIssue.author}
          <span>·</span>
          {date(displayedIssue.updatedAt)}
        </div>
        {page === "inbox" && (
          <div className="mw-detail-actions">
            <button
              className="mw-button primary"
              disabled={!!busy}
              onClick={() =>
                void enqueue(
                  displayedIssue.type === "pr" ? "preflight" : "triage",
                  [displayedIssue.id],
                )
              }
            >
              <Sparkles size={14} />
              {displayedIssue.type === "pr" ? "变更预检" : "快速分诊"}
            </button>
            <button
              className="mw-button"
              disabled={!!busy}
              onClick={() =>
                void enqueue(
                  displayedIssue.type === "pr" ? "review" : "investigate",
                  [displayedIssue.id],
                )
              }
            >
              {displayedIssue.type === "pr" ? "审查 PR" : "深入调查"}
              <ArrowRight size={14} />
            </button>
          </div>
        )}
        <div className="mw-tabs mw-detail-tabs">
          {[
            ["overview", "概览"],
            ["evidence", "证据"],
            ["diff", "差异"],
            ["log", "执行记录"],
          ].map(([key, name]) => (
            <button
              className={detailTab === key ? "active" : ""}
              key={key}
              onClick={() => setDetailTab(key)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="mw-detail-scroll">
          {detailTab === "overview" && (
            <>
              {job && (
                <ReviewSummary
                  job={job}
                  jobs={jobs}
                  issue={
                    issues.find((i) => i.id === displayedIssue.id) ??
                    displayedIssue
                  }
                  deliveryActions={reviewActions}
                  audit={state?.audit ?? []}
                  native={!!state?.capabilities.harness}
                  open={openEvidenceJob}
                  openSession={openSession}
                />
              )}
              <details open={!assistantMode}><summary>后续操作与远端进度</summary>
              <WorkflowPanel
                hideSummary={!!job}
                key={displayedIssue.id}
                issue={
                  issues.find((i) => i.id === displayedIssue.id) ??
                  displayedIssue
                }
                job={job}
                history={jobs.filter((j) => j.issueId === displayedIssue.id)}
                busy={!!busy}
                act={(path, data, message) =>
                  action("workflow", path, data, message)
                }
              />
              </details>
              {job?.error && (
                <div className="mw-callout red">
                  <TriangleAlert size={17} />
                  <p>{job.error}</p>
                </div>
              )}
              {job?.rawOutput && !job.result && (
                <details className="mw-original">
                  <summary>查看模型原始输出（未通过结果校验）</summary>
                  <p>{job.rawOutput}</p>
                </details>
              )}
              {result && (!assistantMode || !job?.artifact) ? (
                <Result
                  result={result}
                  summary={!job?.artifact}
                  classification={
                    !job?.artifact || job.artifact.stage === "triage"
                  }
                />
              ) : !result ? (
                <>
                  <div className="mw-section-title">
                    <BookOpen size={15} /> 问题描述
                  </div>
                  <p className="mw-description">
                    {displayedIssue.origin === "repository"
                      ? "按选定范围检查仓库或准备修改，结果与补丁将在这里显示。"
                      : displayedIssue.body || "未提供描述"}
                  </p>
                  <div className="mw-callout">
                    <Sparkles size={17} />
                    <p>
                      {displayedIssue.origin === "repository"
                        ? "任务结束后可查看整理结果、证据与补丁。"
                        : "派发分诊后，可获得分类、优先级、重复问题建议与下一步操作。"}
                    </p>
                  </div>
                </>
              ) : null}
              {result && (
                <details className="mw-original">
                  <summary>查看原始报告</summary>
                  <p>
                    {displayedIssue.origin === "repository"
                      ? "仓库整理任务：按选定范围检查或准备修改，结果与补丁将在这里显示。"
                      : displayedIssue.body}
                  </p>
                </details>
              )}
            </>
          )}
          {detailTab === "evidence" && (
            <>
              {job?.toolDiagnostics && (
                <div className="mw-evidence">
                  <div>
                    <h4>工具可用性诊断</h4>
                    <p>
                      {job.toolDiagnostics.provider}/{job.toolDiagnostics.model}{" "}
                      · {job.toolDiagnostics.preset} ·{" "}
                      {job.toolDiagnostics.permission}
                    </p>
                    <p>
                      挂载：
                      {job.toolDiagnostics.mountedTools.join(", ") || "无"}
                      ；模型请求：{job.toolDiagnostics.requests.length}{" "}
                      次；调用：{job.toolDiagnostics.calls}；结果：
                      {job.toolDiagnostics.results}；宿主结果：
                      {job.toolDiagnostics.canonicalResults}；错误：
                      {job.toolDiagnostics.errors}
                    </p>
                    <p>
                      请求携带工具：
                      {[
                        ...new Set(
                          job.toolDiagnostics.requests.flatMap((r) => r.tools),
                        ),
                      ].join(", ") || "无"}
                    </p>
                  </div>
                </div>
              )}
              {job?.toolDiagnostics?.implementationRepair && (
                <p className="mw-callout">
                  已尝试补齐实施{" "}
                  {job.toolDiagnostics.implementationRepair.attempts} 次：
                  {job.toolDiagnostics.implementationRepair.reason}
                </p>
              )}
              {job?.toolDiagnostics?.evidenceRepair && (
                <p className="mw-callout">
                  已尝试补齐证据 {job.toolDiagnostics.evidenceRepair.attempts}{" "}
                  次：{job.toolDiagnostics.evidenceRepair.reasons.join("；")}
                </p>
              )}
              {job?.evidenceGate && (
                <p
                  className={`mw-callout ${job.evidenceGate.allowed ? "" : "red"}`}
                >
                  证据验收：
                  {job.evidenceGate.allowed
                    ? "通过"
                    : job.evidenceGate.reasons.join("；")}
                </p>
              )}
              {job?.executionRecords?.map((record) => (
                <ExecutionEvidence key={record.id} job={job} record={record} />
              ))}
              {result?.evidence.length ? (
                result.evidence.map((e, index) => (
                  <div className="mw-evidence" key={index}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <h4>{e.source}</h4>
                      <p>{e.detail}</p>
                    </div>
                  </div>
                ))
              ) : (
                <Empty
                  title="尚无分析证据"
                  text="完成调查后，证据与来源将在这里显示。"
                />
              )}
              {job && (
                <section className="mw-identity">
                  <h4>执行身份</h4>
                  <dl>
                    <dt>任务</dt>
                    <dd>{job.id}</dd>
                    <dt>代码基线</dt>
                    <dd>{job.baseSha}</dd>
                    <dt>输入版本</dt>
                    <dd>{job.revision.slice(0, 20)}</dd>
                    <dt>执行器</dt>
                    <dd>{job.engine ?? "等待执行"}</dd>
                    <dt>Session</dt>
                    <dd>{job.sessionId ?? "未创建"}</dd>
                    <dt>Token</dt>
                    <dd>{job.tokens ?? "未采集"}</dd>
                  </dl>
                </section>
              )}
            </>
          )}
          {detailTab === "diff" &&
            (job?.patch ? (
              <>
                <div className="mw-section-title">
                  <GitBranch size={14} />
                  {job.branch}
                </div>
                <pre className="mw-diff">
                  {job.patch.split("\n").map((l, i) => (
                    <div
                      className={
                        l.startsWith("+")
                          ? "add"
                          : l.startsWith("-")
                            ? "del"
                            : l.startsWith("@@")
                              ? "hunk"
                              : ""
                      }
                      key={i}
                    >
                      {l || " "}
                    </div>
                  ))}
                </pre>
              </>
            ) : (
              <Empty
                title="没有代码差异"
                text="修复与文档任务会在独立 worktree 中生成可审核差异。"
              />
            ))}
          {detailTab === "log" && (
            <>
              {job ? (
                state?.audit
                  .filter((a) => a.jobId === job.id)
                  .slice()
                  .reverse()
                  .map((a) => (
                    <div className="mw-job-log" key={a.id}>
                      <time>{date(a.at)}</time>
                      <p>{a.detail}</p>
                    </div>
                  ))
              ) : (
                <Empty
                  title="尚未创建任务"
                  text="派发后会记录每一步执行状态。"
                />
              )}
              {job?.worktree && (
                <div className="mw-path">工作区：{job.worktree}</div>
              )}
            </>
          )}
        </div>
        {detailTab !== "overview" && reviewActions}
      </aside>
    );
  }
}
function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: number;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="mw-stat">
      <div>
        <span>{label}</span>
        <span className="mw-stat-icon">{icon}</span>
      </div>
      <strong>
        {value}
        <span>项</span>
      </strong>
      <p>{sub}</p>
    </div>
  );
}
function SettingsView({
  scope,
  state,
  repoId,
  busy,
  save,
  bind,
  credentials,
  prepare,
}: {
  scope: "global" | "repository";
  state: Snapshot;
  repoId: string;
  busy: boolean;
  prepare: () => void;
  save: (s: Settings) => void;
  bind: (path: string) => void;
  credentials: (c: {
    apiKey?: string;
    githubToken?: string;
    baseUrl?: string;
  }) => void;
}) {
  const [settings, setSettings] = useState(state.settings);
  const [apiKey, setApiKey] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [baseUrl, setBaseUrl] = useState(state.capabilities.baseUrl);
  const repo = state.repos.find((r) => r.id === repoId);
  const [path, setPath] = useState(repo?.localPath ?? "");
  useEffect(() => setPath(repo?.localPath ?? ""), [repo?.id, repo?.localPath]);
  const native = state.capabilities.harness;
  const host = state.capabilities.host;
  return (
    <div className="mw-settings-grid">
      <section className="mw-settings-card">
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
                onClick={() => {
                  credentials({
                    ...(native
                      ? {}
                      : { ...(apiKey ? { apiKey } : {}), baseUrl }),
                    ...(githubToken ? { githubToken } : {}),
                  });
                  setApiKey("");
                  setGithubToken("");
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
      </section>
      {scope === "global" && (
        <form
          className="mw-settings-card"
          onSubmit={(e) => {
            e.preventDefault();
            save(settings);
          }}
        >
          <div className="mw-section-title">
            <Settings2 size={19} />
            全局默认执行策略
          </div>
          <div className="mw-form-grid">
            {!native && (
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
            <label>
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
            </label>
            <label>
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
          </div>
          <details className="mw-advanced">
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
          </details>
          <div className="mw-callout amber">
            <ShieldCheck size={18} />
            <p>
              单次输出上限不等于总费用上限。执行遵循 Harness
              的权限策略；工作台不自动发布评论、推送分支或合并 PR。
            </p>
          </div>
          <button className="mw-button primary" disabled={busy}>
            <Check size={15} />
            保存设置
          </button>
        </form>
      )}
    </div>
  );
}
