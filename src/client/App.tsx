import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  FileCheck2,
  FileCode2,
  GitBranch,
  GitPullRequest,
  Inbox,
  Layers3,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobKind, Snapshot } from "../core/types.ts";
import { kindNames } from "../core/types.ts";
import { AssistantActions } from "./AssistantActions.tsx";
import { Attention, RepositoryPolicy } from "./Attention.tsx";
import { BatchWorkflow } from "./BatchWorkflow.tsx";
import { WorkflowCard } from "./WorkflowCard.tsx";
import { OperationTracker, type OperationRecord } from "./OperationTracker.tsx";
import { Empty, Modal, Tag } from "./Primitives.tsx";
import { ProcessingHistory } from "./ProcessingHistory.tsx";
import { ProcessingInput } from "./ProcessingInput.tsx";
import {
  PublicationConfirm,
  publicationPreviewCurrent,
  type PublicationPreview,
} from "./PublicationConfirm.tsx";
import { RepositoryDetail } from "./RepositoryDetail.tsx";
import { RepositoryOrganize } from "./RepositoryOrganize.tsx";

import { ReviewSummary, type DetailTab } from "./ReviewSummary.tsx";
import { GitHubConnection, SettingsView } from "./SettingsView.tsx";
import type { HostWorkspaces } from "./host-workspaces.ts";
import { GlobalSettings } from "./GlobalSettings.tsx";

import { API, request } from "./api.ts";
import { InboxFilter } from "./InboxFilter.tsx";
import { IssuePlanning } from "./IssuePlanning.tsx";
import { flushItemDraft } from "./item-draft.ts";
import { ItemInstructions } from "./ItemInstructions.tsx";
import {
  captureOrigin,
  focusDetail,
  restoreOrigin,
  type NavigationOrigin,
} from "./navigation-origin.ts";
import {
  operationFailureRecord,
  operationRecordFromResponse,
  pageSearchKey,
  reviewNoteForTask,
} from "./operation-state.ts";
import { date, elapsed, type Page } from "./presentation.ts";
import { RemoteProgress } from "./RemoteProgress.tsx";
import type { AgentTab } from "./RepositoryDetail.tsx";
import {
  reviewQueue,
  selectedAnalysis,
  taskStatus,
} from "./review-evidence.ts";
import { ReviewActions } from "./ReviewActions.tsx";
import { ReviewFindingControls } from "./ReviewFindingControls.tsx";

import { WorkflowDetail } from "./WorkflowDetail.tsx";
import { StageProgress } from "./StageProgress.tsx";
import { StageExecutionDetails } from "./StageExecutionDetails.tsx";
import { StageResult } from "./StageResult.tsx";
import { taskGroups, type TaskFilter } from "./task-presentation.ts";
export function App({
  openSession,
  host = false,
  hostWorkspaces,
}: {
  hostWorkspaces?: HostWorkspaces;
  openSession?: (id: string) => void;
  host?: boolean;
} = {}) {
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
  const [assistantInstructions, setAssistantInstructions] = useState<
    Record<string, string>
  >({});
  const [showQuickTasks, setShowQuickTasks] = useState(false);
  const [pageSearch, setPageSearch] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("all");
  const [type, setType] = useState("issue");
  const [listLimit, setListLimit] = useState(50);
  const [detailOpen, setDetailOpen] = useState(false);
  const [readerRequest, setReaderRequest] = useState<{
    sequence: number;
    issueId: string;
    tab: "overview" | "plan" | "work" | "review" | "files";
    path?: string;
    line?: number;
  }>();
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
    setType("issue");
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
      listScrollTop:
        (
          document
            .getElementById(`mw-list-${page}`)
            ?.querySelector(".mw-issues") ??
          document.getElementById(`mw-list-${page}`)
        )?.scrollTop ?? 0,
      areaScrollTop:
        document.getElementById(`mw-list-${page}`)?.parentElement?.scrollTop ??
        0,
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
    if (origin.showQuickTasks !== undefined)
      setShowQuickTasks(origin.showQuickTasks);
    setFilter(origin.filter);
    setType(origin.type);
    setSelected(origin.selected);
    const narrow = (mainRef.current?.clientWidth ?? window.innerWidth) <= 560;
    if (origin.page === "inbox")
      setFocused(narrow ? undefined : origin.focused);
    else setJobFocus(narrow ? undefined : origin.focused);
    restoreOrigin(origin, repoId, {
      frame: (callback) =>
        requestAnimationFrame(() => requestAnimationFrame(callback)),
      scrollTo: (top) => {
        mainRef.current?.scrollTo({ top });
        const list = document.getElementById(`mw-list-${origin.page}`);
        (list?.querySelector(".mw-issues") ?? list)?.scrollTo({
          top: origin.listScrollTop ?? 0,
        });
        list?.parentElement?.scrollTo({ top: origin.areaScrollTop ?? 0 });
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
        setReaderRequest({
          sequence: Date.now(),
          issueId:
            jobs.find((j) => j.id === result.delivery.implementationJobId)
              ?.issueId ??
            displayedIssue?.id ??
            "",
          tab: "review",
        });
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
  const pending = reviewQueue(jobs).filter((job) => {
    const run = issues.find((issue) => issue.id === job.issueId)?.orchestration
      ?.run;
    return !run || (run.status === "review" && run.currentJobId === job.id);
  });
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
  const displayedIssue =
    page === "inbox"
      ? issue
      : (issues.find((i) => i.id === job?.issueId) ?? job?.issueSnapshot);
  const result = selectedAnalysis(page === "inbox" ? issue : undefined, job);
  useEffect(() => {
    const id = displayedIssue?.id;
    if (!id) return;
    const controller = new AbortController();
    void flushItemDraft(id)
      .then(() =>
        fetch(`${API}/item-draft?id=${encodeURIComponent(id)}`, {
          signal: controller.signal,
        }),
      )
      .then(async (response) => {
        if (!response.ok) throw Error("draft");
        return response.json();
      })
      .then((value) => {
        if (!controller.signal.aborted)
          setAssistantInstructions((current) => ({
            ...current,
            [id]:
              typeof value.instructions === "string" ? value.instructions : "",
          }));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [displayedIssue?.id]);
  const openEvidenceJob = (id: string, tab: DetailTab) => {
    if (!jobs.some((item) => item.id === id && item.issueId === job?.issueId))
      return;
    navigationGeneration.current += 1;
    rememberOrigin();
    navigate("tasks", repoId, true);
    setTaskFilter("all");
    setFocused(undefined);
    setJobFocus(id);
    setReaderRequest({
      sequence: Date.now(),
      issueId: job!.issueId,
      tab: tab === "diff" ? "files" : tab === "overview" ? "review" : "work",
    });
    setPublishAction(undefined);
    if (id !== job?.id) setReviewNote("");
    moveFocusToDetail();
  };
  const groups = taskGroups(jobs, showQuickTasks);
  const visibleGroups = groups
    .filter((group) =>
      page === "reviews"
        ? group.state === "attention"
        : taskFilter === "all" || group.state === taskFilter,
    )
    .filter((group) =>
      group.members.some((j) =>
        `${j.issueSnapshot.title} ${j.issueSnapshot.number} ${kindNames[j.kind]}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    );
  const listJobs = visibleGroups.map((group) => group.latest);
  async function openPublishPreview(
    publishKind: NonNullable<typeof publishAction>,
    targetId?: string,
  ) {
    const job = targetId
      ? jobs.find((j) => j.id === targetId)
      : (jobs.find((j) => j.id === jobFocus) ??
        (issue ? jobs.find((j) => j.issueId === issue.id) : undefined));
    if (!job || busy) return;
    if (publishKind === "comment") {
      try {
        await flushItemDraft(job.issueId);
      } catch {
        setToast({ text: "回复草稿尚未保存，请重试", error: true });
        return;
      }
    }
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
    {
      id: "inbox",
      label: "Issues",
      icon: Inbox,
      count: open.filter((i) => i.type === "issue").length,
    },
    {
      id: "inbox",
      label: "Pull Requests",
      icon: GitPullRequest,
      count: open.filter((i) => i.type === "pr").length,
    },
    { id: "organize", label: "Repository", icon: FileCheck2, count: 0 },
    {
      id: "tasks",
      label: "Tasks",
      icon: Layers3,
      count: groups.filter((g) => g.state === "attention").length,
    },
    { id: "repository-settings", label: "Settings", icon: Settings2, count: 0 },
  ] as const;
  return (
    <div className="mw mw-layout-tabs" data-mw-host={host ? "" : undefined}>
      <div className="mw-shell">
        <header className="mw-header">
          <div className="mw-header-controls">
            <div className="mw-header-brand">
              <GitBranch size={20} />
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
              title={
                host
                  ? "全局设置 · 也可从 Harness 设置 → 维护工作台进入"
                  : "全局设置"
              }
              onClick={() => navigate("settings")}
            >
              <Settings2 size={16} />
            </button>
          </div>
          <nav className="mw-global-tabs" aria-label="工作台页面">
            {nav.map((n) => (
              <button
                key={n.label}
                aria-current={
                  (page === n.id &&
                    (n.id !== "inbox" ||
                      type === (n.label === "Issues" ? "issue" : "pr"))) ||
                  (n.id === "tasks" && page === "reviews")
                    ? "page"
                    : undefined
                }
                className={`${(page === n.id && (n.id !== "inbox" || type === (n.label === "Issues" ? "issue" : "pr"))) || (n.id === "tasks" && page === "reviews") ? "active" : ""} `}
                onClick={() => {
                  navigationGeneration.current += 1;
                  navigate(n.id);
                  if (n.id === "inbox") {
                    setType(n.label === "Issues" ? "issue" : "pr");
                    setSelected([]);
                    setListLimit(50);
                  }
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
            {repo?.syncedAt && (
              <time
                className="mw-sync-time"
                title="最近同步时间"
                dateTime={repo.syncedAt}
              >
                {date(repo.syncedAt)}
              </time>
            )}
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
              {page === "tasks" && !displayedIssue && (
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
                    setReaderRequest(undefined);
                    setReviewNote(reviewNoteForTask(jobFocus, id, reviewNote));
                    moveFocusToDetail();
                  }}
                />
              )}
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
                  open={(id, issueId) => {
                    navigate("inbox", id);
                    setFocused(issueId);
                    setReaderRequest(
                      issueId
                        ? { sequence: Date.now(), issueId, tab: "overview" }
                        : undefined,
                    );
                    if (issueId) moveFocusToDetail();
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
                      <InboxFilter value={filter} onChange={setFilter} />
                    </div>
                    <div className="mw-batch">
                      <div>
                        <BatchWorkflow
                          issues={issues.filter((issue) =>
                            selected.includes(issue.id),
                          )}
                          busy={!!busy}
                          act={(path, data, message) =>
                            action("workflow-batch", path, data, message)
                          }
                        />
                        <details className="mw-batch-advanced">
                          <summary>更多操作</summary>
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
                        </details>
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
                                setReaderRequest(undefined);
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
                                <span
                                  className="mw-issue-labels"
                                  aria-label="标签"
                                >
                                  {i.labels
                                    .filter((l) => !/^p[0-3]$/i.test(l))
                                    .slice(0, 2)
                                    .map((l) => (
                                      <Tag key={l}>{l}</Tag>
                                    ))}
                                </span>
                                <span className="mw-issue-comments">
                                  {i.comments} 条讨论
                                </span>
                              </div>
                            </button>
                            <div className="mw-row-status">
                              {i.type === "issue" &&
                                (i.plan?.category ?? i.analysis?.category) && (
                                  <Tag>
                                    {i.plan?.category ?? i.analysis?.category}
                                  </Tag>
                                )}
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
                                  {i.processing
                                    ? ((
                                        {
                                          review: "待审查",
                                          draft: "草稿阶段",
                                          blocked: "存在阻塞",
                                        } as Record<string, string>
                                      )[i.processing.phase] ?? "已预检")
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
                        {"任务"} <span>{listJobs.length}</span>
                      </h3>
                      <div
                        className="mw-task-filters"
                        aria-label="任务状态筛选"
                      >
                        {(
                          [
                            ["attention", "需要我处理"],
                            ["running", "正在运行"],
                            ["completed", "已完成"],
                            ["failed", "失败 / 已停止"],
                            ["all", "全部"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            className={taskFilter === value ? "active" : ""}
                            key={value}
                            onClick={() => {
                              setTaskFilter(value);
                              if (page === "reviews") setPage("tasks");
                            }}
                          >
                            {label}{" "}
                            <small>
                              {
                                groups.filter(
                                  (g) => value === "all" || g.state === value,
                                ).length
                              }
                            </small>
                          </button>
                        ))}
                      </div>
                      <details className="mw-task-options">
                        <summary>显示选项</summary>
                        <label>
                          <input
                            type="checkbox"
                            checked={showQuickTasks}
                            onChange={(e) =>
                              setShowQuickTasks(e.target.checked)
                            }
                          />
                          包含快速分诊与预检
                        </label>
                      </details>
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
                    {taskFilter === "attention" &&
                      issues
                        .filter(
                          (i) =>
                            i.state === "open" &&
                            !i.origin &&
                            (["decision", "needs_info"].includes(
                              i.processing?.phase ?? "",
                            ) ||
                              i.informationRequests?.some(
                                (r) => r.state === "reply_received",
                              )),
                        )
                        .map((i) => (
                          <button
                            className="mw-task-row mw-decision-row"
                            key={`decision-${i.id}`}
                            onClick={() => {
                              navigate("inbox", repoId);
                              setFocused(i.id);
                            }}
                          >
                            <div>
                              <strong>{i.title}</strong>
                              <p>
                                #{i.number} ·{" "}
                                {i.processing?.phase === "needs_info"
                                  ? "需要补充信息"
                                  : "需要确认目标"}
                              </p>
                            </div>
                          </button>
                        ))}
                    {listJobs.length ? (
                      listJobs.slice(0, listLimit).map((j) => (
                        <button
                          key={j.id}
                          id={`mw-item-${j.id}`}
                          className={`mw-task-row ${visibleGroups.find((g) => g.latest.id === j.id)?.members.some((m) => m.id === jobFocus) ? "focused" : ""}`}
                          onClick={() => {
                            rememberOrigin(j.id);
                            navigationGeneration.current += 1;
                            setJobFocus(j.id);
                            setFocused(undefined);
                            setReaderRequest(undefined);
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
                              {visibleGroups.find((g) => g.latest.id === j.id)
                                ?.members.length ?? 1}{" "}
                              个处理步骤
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
                        text="当前筛选下没有任务，可切换筛选或从 Issues 或 Pull Requests 开始处理。"
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
                      <h3>{jobFocus ? "任务已不在当前列表中" : "选择任务"}</h3>
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
                <div className="mw-repository-settings">
                  <RepositoryPolicy
                    key={repoId}
                    state={state}
                    repoId={repoId}
                    busy={!!busy}
                    save={(value) =>
                      action("policy", "/policy", value, "仓库策略已保存")
                    }
                  />
                </div>
              )}
              {page === "settings" && (
                <GlobalSettings native={host} hostWorkspaces={hostWorkspaces} openSession={openSession} />
              )}
              {page === "repository-settings" && (
                <div className="mw-repository-settings">
                  <SettingsView
                    key={page}
                    scope="repository"
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
                </div>
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
                          state.repos
                            .map((r) =>
                              r.mode === "github" ? r.fullName : r.githubName,
                            )
                            .filter((n): n is string => !!n)
                            .join("\n"),
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
          returnToList={
            originRef.current?.repoId === repoId ? returnToOrigin : undefined
          }
          returnToListVisible={
            !!readerRequest || originRef.current?.page !== page
          }
          workflow
          renderAgentPanel={renderWorkflow}
          agentPanel={null}
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
                ? (publishPreview?.responseDraft ??
                  previewJob.result?.responseDraft)
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
              const names = repoInput
                .split(/[\n,，]+/)
                .map((n) => n.trim())
                .filter(Boolean);
              if (busy || !names.length) return;
              setBusy("connect");
              try {
                const results: {
                  fullName: string;
                  repoId?: string;
                  error?: string;
                }[] = [];
                for (let i = 0; i < names.length; i += 20)
                  results.push(
                    ...(
                      await request("/sync-many", {
                        names: names.slice(i, i + 20),
                      })
                    ).results,
                  );
                await refresh();
                setConnectionResults(results);
                setToast({ text: "仓库连接检查完成" });
                const connected = results.find((item) => item.repoId);
                if (connected) navigate(page, connected.repoId);
              } catch (e) {
                setToast({ text: (e as Error).message, error: true });
              } finally {
                setBusy("");
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
        key={`${page}:${displayedIssue.id}:${jobFocus ?? ""}`}
        embedded
        requestedTab={
          readerRequest?.issueId === displayedIssue.id
            ? readerRequest
            : undefined
        }
        localPatch={
          job?.patch
            ? {
                patch: job.patch,
                label: kindNames[job.kind],
                revision: job.baseSha,
              }
            : undefined
        }
        responseDraft={result?.responseDraft}
        onPreviewReply={
          job?.status === "approved"
            ? () => void openPublishPreview("comment")
            : undefined
        }
        initialTab="overview"
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
        returnToList={
          originRef.current?.repoId === repoId ? returnToOrigin : undefined
        }
        returnToListVisible={
          !!readerRequest || originRef.current?.page !== page
        }
        workflow
        renderAgentPanel={renderWorkflow}
        agentPanel={null}
      />
    );
  }

  function renderWorkflow(tab: AgentTab) {
    if (!displayedIssue) return null;
    return (
      <WorkflowDetail
        openSession={openSession}
        issue={displayedIssue}
        jobs={jobs}
        job={job}
        legacyTab={tab}
        render={renderStage}
        track={renderTrack}
        evidence={renderLinkedEvidence}
        context={renderProcessingAdvice}
        instructions={
          <ItemInstructions
            issueId={displayedIssue.id}
            onChange={(value) =>
              setAssistantInstructions((current) => ({
                ...current,
                [displayedIssue.id]: value,
              }))
            }
          />
        }
        actions={renderWorkflowActions}
      />
    );
  }

  function renderWorkflowActions(
    currentJob?: typeof job,
    projected?: import("../workflow/actions.ts").WorkflowActions,
  ) {
    if (!displayedIssue) return null;
    return (
      <AssistantActions
        issue={displayedIssue}
        job={currentJob}
        projected={projected}
        history={jobs.filter((j) => j.issueId === displayedIssue.id)}
        busy={!!busy}
        instructions={assistantInstructions[displayedIssue.id]}
        act={async (path, data, message) => {
          if (["/jobs", "/classify"].includes(path))
            await flushItemDraft(displayedIssue.id);
          return action("workflow", path, data, message);
        }}
        openEvidence={(id) => openEvidenceJob(id, "log")}
      />
    );
  }

  function renderStage(
    stage: AgentTab,
    selectedJob?: typeof job,
    readOnly = false,
    decision = false,
    execution = false,
  ) {
    const job = selectedJob;
    if (!displayedIssue) return null;
    const history = jobs.filter((j) => j.issueId === displayedIssue.id);
    if (stage === "plan")
      return readOnly ? (
        <p>
          历史计划只读：{job?.issueSnapshot.plan?.goal ?? "未保存单独计划"}
          。当前计划请返回当前阶段查看。
        </p>
      ) : (
        <>
          {renderProcessingAdvice(true)}
          <details open={!displayedIssue.orchestration?.draft}>
            <summary>高级操作</summary>
            <IssuePlanning
              start={(kind, expectedVersion) =>
                action(
                  "workflow",
                  "/jobs",
                  {
                    issueIds: [displayedIssue.id],
                    kind,
                    expectedVersion,
                    goal: "resolve",
                    instructions: assistantInstructions[displayedIssue.id],
                  },
                  "已按确认计划开始实施",
                )
              }
              issue={displayedIssue}
              job={job}
              busy={
                !!busy ||
                history.some((j) => ["running", "queued"].includes(j.status))
              }
              act={(path, data, message) =>
                action("workflow", path, data, message)
              }
            />
          </details>
        </>
      );
    if (stage === "work") {
      if (!execution)
        return (
          <StageProgress
            job={job}
            issue={displayedIssue}
            audit={state?.audit ?? []}
            readOnly={readOnly}
            openSession={openSession}
            input={
              !readOnly && (
                <ProcessingInput
                  issue={displayedIssue}
                  runId={job?.id}
                  embedded
                  busy={!!busy}
                  act={(path, data, message) =>
                    action("workflow", path, data, message)
                  }
                />
              )
            }
          />
        );
      return (
        <StageExecutionDetails
          job={job}
          audit={state?.audit ?? []}
          openEvidence={(id) => openEvidenceJob(id, "log")}
          openSession={openSession}
          tools={
            <details className="mw-processing-tools">
              <summary>处理记录与操作追踪</summary>
              {!readOnly && (
                <ProcessingHistory
                  issue={displayedIssue}
                  busy={!!busy}
                  act={(path, data, message) =>
                    action("workflow", path, data, message)
                  }
                />
              )}
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
                  setReaderRequest(undefined);
                  setReviewNote(reviewNoteForTask(jobFocus, id, reviewNote));
                  moveFocusToDetail();
                }}
              />
            </details>
          }
        />
      );
    }
    if (stage === "review")
      return job && (job.result || job.artifact || job.patch) ? (
        <>
          <StageResult
            job={job}
            open={openEvidenceJob}
            openLocation={(path, line) =>
              setReaderRequest({
                sequence: Date.now(),
                issueId: displayedIssue.id,
                tab: "files",
                path,
                line,
              })
            }
          />
          {!readOnly &&
            !["triage", "preflight"].includes(job.kind) &&
            (decision ? (
              renderReviewActions(job)
            ) : (
              <details className="mw-stage-review-actions">
                <summary>审核与交付操作</summary>
                {renderReviewActions(job)}
              </details>
            ))}
          {job.kind === "review" && !readOnly && (
            <details>
              <summary>发现处置与讨论串</summary>
              <ReviewFindingControls
                job={job}
                history={history}
                busy={!!busy}
                act={(path, data, message) =>
                  action("workflow", path, data, message)
                }
              />
            </details>
          )}
        </>
      ) : (
        <p>尚无保存结果，请查看执行详情与恢复入口。</p>
      );

    return null;
  }

  function renderProcessingAdvice(full = false) {
    if (!displayedIssue) return null;
    const card = (
      <WorkflowCard
        issue={displayedIssue}
        history={jobs.filter((j) => j.issueId === displayedIssue.id)}
        busy={!!busy}
        act={(path, data, message) => action("workflow", path, data, message)}
      />
    );
    return full || displayedIssue.orchestration ? (
      card
    ) : (
      <details>
        <summary>处理建议与进度</summary>
        {card}
      </details>
    );
  }

  function renderLinkedEvidence(selectedJob?: typeof job) {
    if (
      !displayedIssue ||
      !selectedJob ||
      ["triage", "preflight"].includes(selectedJob.kind)
    )
      return null;
    return (
      <details className="mw-delivery-evidence">
        <summary>关联验证与交付证据</summary>
        <ReviewSummary
          compact
          job={selectedJob}
          jobs={jobs}
          issue={displayedIssue}
          audit={state?.audit ?? []}
          native={!!state?.capabilities.harness}
          open={openEvidenceJob}
          openSession={openSession}
        />
      </details>
    );
  }

  function renderTrack(
    selectedJob = job,
    readOnly = false,
    monitoring = false,
  ) {
    if (!displayedIssue) return null;
    return (
      <>
        {renderLinkedEvidence(selectedJob)}
        {selectedJob &&
          (readOnly
            ? Object.entries(selectedJob.publications ?? {}).map(
                ([kind, receipt]) => (
                  <p key={kind}>
                    {kind} · {receipt.status}
                    {receipt.urls.map((url) => (
                      <a key={url} href={url} target="_blank" rel="noreferrer">
                        查看交付结果
                      </a>
                    ))}
                  </p>
                ),
              )
            : renderReviewActions(selectedJob))}
        {(!readOnly || monitoring) && (
          <RemoteProgress
            issue={displayedIssue}
            busy={!!busy}
            act={(path, data, message) =>
              action("workflow", path, data, message)
            }
          />
        )}
      </>
    );
  }

  function renderReviewActions(selectedJob = job) {
    const job = selectedJob;
    return (
      <ReviewActions
        job={job}
        jobs={jobs}
        native={!!state?.capabilities.harness}
        busy={!!busy}
        reviewNote={reviewNote}
        setReviewNote={setReviewNote}
        action={action}
        openPublishPreview={(kind) => openPublishPreview(kind, job?.id)}
        openSession={openSession}
      />
    );
  }
}
