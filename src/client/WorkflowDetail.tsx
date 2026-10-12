import { stepDisposition } from "../workflow/manual.ts";
import { ManualStepForm, manualStepAccess } from "./ManualStepForm.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Issue, Job } from "../core/types.ts";
import type { ProcessingCase } from "../domain/processing.ts";
import type { ProcessingTimeline, TimelineNode } from "../domain/timeline.ts";
import { projectTimeline } from "../workflow/timeline.ts";
import { actionsForStage } from "../workflow/stage-actions.ts";
import { availableActions } from "../workflow/actions.ts";
import { StagePanel, type StageSelection } from "./StagePanel.tsx";
import { API, request } from "./api.ts";
import type { AgentTab } from "./RepositoryDetail.tsx";
import { WorkflowTimeline } from "./WorkflowTimeline.tsx";
import { ProcessingRecords } from "./ProcessingRecords.tsx";
import { NextAction } from "./NextAction.tsx";
import { reportPresentation } from './report-presentation.ts';

interface Props {
  openSession?: (id: string) => void;
  issue: Issue;
  jobs: Job[];
  job?: Job;
  legacyTab?: AgentTab;
  render: (
    tab: AgentTab,
    job?: Job,
    readOnly?: boolean,
    decision?: boolean,
    execution?: boolean,
  ) => ReactNode;
  actions: (job?: Job, actions?: ProcessingTimeline["actions"]) => ReactNode;
  evidence: (job?: Job) => ReactNode;
  instructions?: ReactNode;
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
  openSession,
  jobs,
  job,
  legacyTab,
  render,
  actions,
  evidence,
  instructions,
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
  const [manualNotices, setManualNotices] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection>(() => {
    if (legacyTab === "plan") return { view: "stage", detail: "plan" };
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
      if (saved?.view === "plan") return { view: "stage", detail: "plan" };
      if (saved?.view === "stage") return saved;
    } catch {}
    return {
      view: "stage",
      detail: "result",
      attemptId: job?.id !== state.currentRunId ? job?.id : undefined,
    };
  });
  const generation = useRef(0);
  const workflowRef = useRef<HTMLElement>(null);
  const navigateToExecution = useRef(false);
  const timeline = reportPresentation(
    loaded?.caseId === (cycle || state.id) &&
    (cycle || loaded.version === state.version)
      ? loaded
      : fallback, history);
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
      view: "stage",
      detail:
        legacyTab === "work"
          ? "execution"
          : legacyTab === "plan"
            ? "plan"
            : "result",
      nodeId: undefined,
      attemptId: job?.id,
    }));
  }, [legacyTab]);
  const explicitAttempt = history.find((j) => j.id === selection.attemptId);
  const selected =
    timeline.nodes.find(
      (n) =>
        n.id === selection.nodeId ||
        (selection.nodeId === `${timeline.caseId}:decision` &&
          issue.type === "issue" &&
          timeline.profile.category === "bug" &&
          n.stage === "investigate"),
    ) ??
    (explicitAttempt
      ? timeline.nodes.find((n) => n.attemptIds.includes(explicitAttempt.id))
      : undefined) ??
    timeline.nodes.find((n) => n.id === timeline.currentNodeId)!;
  const currentJob = history.find((j) => j.id === timeline.currentRunId);
  const manualCurrent =
    selected?.id === timeline.currentNodeId &&
    state.manualCursor === selected.stage &&
    ["takeover", "reopen"].includes(
      stepDisposition(state, selected.stage)?.mode ?? "",
    );
  const attempt =
    manualCurrent && !selection.attemptId
      ? undefined
      : selected?.attemptIds.includes(selection.attemptId ?? "")
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
      attemptId: stepDisposition(state, node.stage)
        ? undefined
        : node.attemptIds.at(-1),
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
  useEffect(() => {
    if (!navigateToExecution.current || cycleLoading) return;
    const panel =
      workflowRef.current?.querySelector<HTMLElement>(".mw-stage-panel");
    if (!panel) return;
    navigateToExecution.current = false;
    panel.scrollIntoView({ block: "start" });
    panel.focus({ preventScroll: true });
  }, [selection, cycleLoading]);
  return (
    <section
      ref={workflowRef}
      className="mw-workflow-detail"
      aria-label="事项处理流程"
    >
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
      {manualNotices.map((notice, index) => (
        <p key={index} role="status" className="mw-callout">
          {notice}
        </p>
      ))}
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
          {viewingHistory && <NextAction timeline={timeline} back={back} />}
          {selected && (
            <StagePanel
              selected={selected}
              manual={
                manualStepAccess(
                  issue,
                  timeline,
                  selected,
                  !!selection.attemptId &&
                    !!attempt &&
                    attempt.id !== timeline.currentRunId,
                ).available ? (
                  <ManualStepForm
                    key={`${timeline.caseId}:${selected.stage}`}
                    issue={issue}
                    timeline={timeline}
                    selected={selected}
                    job={currentJob}
                    readOnlyAttempt={
                      !!selection.attemptId &&
                      !!attempt &&
                      attempt.id !== timeline.currentRunId
                    }
                    onUpdated={(mode, warnings) => {
                      setManualNotices(warnings ?? []);
                      setLoaded(undefined);
                      choose({
                        view: "stage",
                        detail: ["takeover", "supplement"].includes(mode)
                          ? "manual"
                          : "result",
                      });
                    }}
                  />
                ) : undefined
              }
              timeline={timeline}
              issue={issue}
              attempt={attempt}
              currentJob={currentJob}
              history={history}
              readOnly={readOnly}
              selection={selection}
              choose={choose}
              render={render}
              track={track}
              evidence={evidence}
              context={
                !issue.origin &&
                !timeline.historical &&
                (selected.id === timeline.currentNodeId ||
                  actionsForStage(timeline, selected)?.primary)
                  ? () => render("plan", currentJob, issue.state !== "open")
                  : undefined
              }
              instructions={
                actionsForStage(timeline, selected)?.primary
                  ? instructions
                  : undefined
              }
              actions={
                actionsForStage(timeline, selected)
                  ? actions(currentJob, actionsForStage(timeline, selected))
                  : undefined
              }
            />
          )}
          <ProcessingRecords
            timeline={timeline}
            jobs={history}
            openSession={openSession}
            openExecution={(run) => {
              const nextCycle = run.caseId
                ? run.caseId === state.id
                  ? ""
                  : run.caseId
                : timeline.historical
                  ? timeline.caseId
                  : "";
              if (nextCycle !== cycle) {
                setCycle(nextCycle);
                setLoaded(undefined);
              }
              navigateToExecution.current = true;
              choose({ view: "stage", detail: "execution", attemptId: run.id });
            }}
          />
        </>
      )}
    </section>
  );
}
