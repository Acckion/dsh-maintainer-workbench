import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Audit, Issue, Job } from "../core/types.ts";
import { eventDescription } from "../workflow/presentation.ts";
import type { ProcessingCase } from "../domain/processing.ts";
import type { ProcessingTimeline, TimelineNode } from "../domain/timeline.ts";
import { projectTimeline } from "../workflow/timeline.ts";
import { actionsForStage } from "../workflow/stage-actions.ts";
import { availableActions } from "../workflow/actions.ts";
import { StagePanel, type StageSelection } from "./StagePanel.tsx";
import { API, request } from "./api.ts";
import type { AgentTab } from "./RepositoryDetail.tsx";
import { WorkflowTimeline } from "./WorkflowTimeline.tsx";
import { NextAction } from "./NextAction.tsx";

interface Props {
  issue: Issue;
  jobs: Job[];
  job?: Job;
  legacyTab?: AgentTab;
  audit?: Audit[];
  render: (
    tab: AgentTab,
    job?: Job,
    readOnly?: boolean,
    decision?: boolean,
  ) => ReactNode;
  actions: (job?: Job, actions?: ProcessingTimeline["actions"]) => ReactNode;
  evidence: (job?: Job) => ReactNode;
  context: () => ReactNode;
  track: (job?: Job, readOnly?: boolean, monitoring?: boolean) => ReactNode;
}
type Selection = StageSelection;
const fallbackCase = (
  issue: Issue,
  jobs: Job[],
  focused?: Job,
): ProcessingCase =>
  issue.processing ?? {
    id: `legacy:${issue.id}`,
    workItemId: issue.id,
    repositoryId: issue.repoId,
    workflowDefinitionVersion: "legacy",
    lifecycle: issue.state === "closed" ? "completed" : "active",
    phase: issue.type === "pr" ? "preflight" : "triage",
    reason: "历史记录信息有限，请核对保存的证据",
    waits: [],
    activeRunIds: jobs
      .filter((j) => ["running", "queued"].includes(j.status))
      .map((j) => j.id),
    currentRunId: focused?.id ?? jobs[0]?.id,
    sourceFingerprint: "",
    cycle: 1,
    version: 0,
    createdAt: issue.updatedAt,
    updatedAt: issue.updatedAt,
  };

export function WorkflowDetail({
  issue,
  jobs,
  job,
  legacyTab,
  audit = [],
  render,
  actions,
  evidence,
  context,
  track,
}: Props) {
  const history = jobs.filter((j) => j.issueId === issue.id);
  const state = fallbackCase(issue, history, job);
  const fallback = projectTimeline(
    issue,
    state,
    history,
    [],
    issue.actionsAvailable ??
      availableActions(
        issue,
        history.find((j) => j.id === state.currentRunId) ?? history[0],
        history,
      ),
  );
  const [loaded, setLoaded] = useState<ProcessingTimeline>();
  const [cycles, setCycles] = useState<ProcessingCase[]>([]);
  const [cycle, setCycle] = useState("");
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<Selection>(() => {
    if (legacyTab === "plan") return { view: "plan", detail: "result" };
    if (legacyTab === "work" || legacyTab === "review")
      return {
        view: "stage",
        detail: legacyTab === "work" ? "execution" : "result",
        attemptId: job?.id,
      };
    try {
      const saved = JSON.parse(
        localStorage.getItem(`maintainer.stage:${issue.id}:${state.id}`) ??
          "null",
      );
      if (saved?.view === "overview")
        return { view: "stage", detail: "result" };
      if (saved && ["stage", "plan"].includes(saved.view)) return saved;
    } catch {}
    return {
      view: "stage",
      detail: "result",
      attemptId: job?.id !== state.currentRunId ? job?.id : undefined,
    };
  });
  const [seenVersion, setSeenVersion] = useState(state.version);
  const generation = useRef(0);
  const timeline =
    loaded?.caseId === (cycle || state.id) &&
    (cycle || loaded.version === state.version)
      ? loaded
      : fallback;
  useEffect(() => {
    const controller = new AbortController(),
      current = ++generation.current;
    setError("");
    void fetch(
      `${API}/processing/timeline?issueId=${encodeURIComponent(issue.id)}${cycle ? `&caseId=${encodeURIComponent(cycle)}` : ""}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw Error(value.error ?? "阶段加载失败");
        if (!value.nodes || value.issueId !== issue.id)
          throw Error("阶段数据尚不可用");
        if (!controller.signal.aborted && generation.current === current)
          setLoaded(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted && issue.processing) setError(e.message);
      });
    return () => controller.abort();
  }, [issue.id, state.id, state.version, cycle]);
  useEffect(() => {
    let active = true;
    void request(`/processing?issueId=${encodeURIComponent(issue.id)}`)
      .then((value) => {
        if (active && value.cases) setCycles(value.cases);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [issue.id, state.id]);
  const previousTab = useRef(legacyTab);
  useEffect(() => {
    if (previousTab.current === legacyTab) return;
    previousTab.current = legacyTab;
    if (legacyTab === "overview") return;
    setSelection((s) => ({
      ...s,
      view: legacyTab === "plan" ? "plan" : "stage",
      detail: legacyTab === "work" ? "execution" : "result",
      nodeId: undefined,
      attemptId: job?.id,
    }));
  }, [legacyTab]);
  const explicitAttempt = history.find((j) => j.id === selection.attemptId);
  const selected =
    timeline.nodes.find((n) => n.id === selection.nodeId) ??
    (explicitAttempt
      ? timeline.nodes.find((n) => n.attemptIds.includes(explicitAttempt.id))
      : undefined) ??
    timeline.nodes.find((n) => n.id === timeline.currentNodeId)!;
  const currentJob = history.find((j) => j.id === timeline.currentRunId);
  const progress =
    currentJob?.status === "running"
      ? audit.find(
          (a) => a.jobId === currentJob.id && a.action === "job.progress",
        )?.detail
      : undefined;
  const attempt = selected?.attemptIds.includes(selection.attemptId ?? "")
    ? explicitAttempt
    : (history.find((j) => j.id === selected?.attemptIds.at(-1)) ??
      (selected?.id === timeline.currentNodeId &&
      ["decision", "track"].includes(selected.stage)
        ? currentJob
        : undefined));
  const readOnly =
    timeline.historical ||
    selected?.id !== timeline.currentNodeId ||
    (attempt
      ? attempt.id !== timeline.currentRunId ||
        attempt.artifactState === "stale"
      : selected?.id !== timeline.currentNodeId);
  const viewingHistory =
    timeline.historical ||
    selected?.id !== timeline.currentNodeId ||
    (!!attempt && attempt.id !== timeline.currentRunId);
  const choose = (value: Selection) => {
    setSelection(value);
    setSeenVersion(state.version);
    try {
      localStorage.setItem(
        `maintainer.stage:${issue.id}:${state.id}`,
        JSON.stringify(value),
      );
    } catch {}
  };
  const select = (node: TimelineNode) =>
    choose({
      nodeId: node.id,
      attemptId: node.attemptIds.at(-1),
      view: "stage",
      detail: "result",
    });
  const back = () => {
    setCycle("");
    setLoaded(undefined);
    choose({ view: "stage", detail: "result" });
  };
  const changeCycle = (id: string) => {
    setCycle(id);
    setLoaded(undefined);
    setSelection({ view: "stage", detail: "result" });
  };
  // Never expose current controls while an older cycle is still loading.
  const cycleLoading = !!cycle && timeline.caseId !== cycle;
  return (
    <section className="mw-workflow-detail" aria-label="事项处理流程">
      <div className="mw-workflow-toolbar" hidden={cycles.length <= 1}>
        <div className="mw-workflow-views">
          {cycles.length > 1 && (
            <label>
              处理周期
              <select
                aria-label="查看阶段周期"
                value={cycle}
                onChange={(e) => changeCycle(e.target.value)}
              >
                <option value="">当前周期</option>
                {cycles
                  .filter((c) => c.id !== state.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      周期 {c.cycle} · 已归档
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
      </div>
      {error && <p role="alert">{error}。当前显示保存的处理记录。</p>}
      {cycleLoading ? (
        <p role="status">正在读取历史周期…</p>
      ) : (
        <>
          <WorkflowTimeline
            timeline={timeline}
            selected={selection.view === "stage" ? selected?.id : undefined}
            select={select}
          />
          {(issue.type === "issue" || viewingHistory || selection.view !== "stage") && (
            <NextAction timeline={timeline} back={back} showBack={viewingHistory || selection.view !== "stage"} tools={issue.type === "issue" && (
            <button
              type="button"
              className="mw-text-button"
              onClick={() => choose({ view: "plan", detail: "result" })}
            >
              调整分类与计划
            </button>
          )} />
          )}
          {viewingHistory && seenVersion < state.version && (
            <p className="mw-callout">
              当前阶段有更新。查看历史不会改变正在执行的任务。
            </p>
          )}
          {selection.view === "plan"
            ? render("plan", currentJob, timeline.historical)
            : selected && (
                <StagePanel
                  selected={selected}
                  timeline={timeline}
                  issue={issue}
                  attempt={attempt}
                  currentJob={currentJob}
                  history={history}
                  readOnly={readOnly}
                  viewingHistory={viewingHistory}
                  selection={selection}
                  choose={choose}
                  render={render}
                  track={track}
                  evidence={evidence}
                  context={
                    actionsForStage(timeline, selected)?.primary
                      ? context
                      : undefined
                  }
                  progress={progress}
                  actions={
                    actionsForStage(timeline, selected)
                      ? actions(currentJob, actionsForStage(timeline, selected))
                      : undefined
                  }
                />
              )}
          <details className="mw-stage-activity">
            <summary>阶段活动记录 · {timeline.eventTotal}</summary>
            <p className="mw-muted">
              按实际发生顺序记录；同一阶段的重试保留在尝试列表中。
              {timeline.eventTotal > timeline.events.length &&
                "此处显示最近 100 条；完整记录可在执行详情中展开事件历史。"}
            </p>
            <ol>
              {timeline.events.map((e) => (
                <li key={e.id} title={e.payload.type}>
                  <time>{new Date(e.receivedAt).toLocaleString("zh-CN")}</time>{" "}
                  · {eventDescription(e)}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}
