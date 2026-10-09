import type { Issue, Job } from "../core/types.ts";
import { availableActions, type WorkflowAction } from "../workflow/actions.ts";
import { actionLabel } from "../workflow/presentation.ts";

interface Props {
  issue: Issue;
  job?: Job;
  history: Job[];
  busy: boolean;
  instructions?: string;
  act: (path: string, data: unknown, message: string) => Promise<unknown>;
  openEvidence: (id: string) => void;
  projected?: import("../workflow/actions.ts").WorkflowActions;
}
export function AssistantActions({
  issue,
  job,
  history,
  busy,
  instructions,
  act,
  openEvidence,
  projected,
}: Props) {
  const actions =
    projected ??
    job?.actionsAvailable ??
    issue.actionsAvailable ??
    availableActions(issue, job, history);
  const control = actions.controls?.[0];
  if (control)
    return (
      <button
        className="mw-button primary"
        disabled={busy || !control.enabled}
        title={control.blockedReasons.join("；")}
        onClick={() =>
          void act(
            control.kind === "prepare"
              ? "/prepare"
              : control.kind === "resume"
                ? "/processing/resume"
                : `/${control.kind}`,
            control.kind === "prepare"
              ? { repoId: issue.repoId }
              : { id: control.runId, expectedVersion: actions.expectedVersion },
            control.kind === "resume"
              ? "已根据补充输入继续，原运行与证据保留"
              : control.kind === "prepare"
                ? "仓库环境已准备，可继续原任务"
                : control.kind === "cancel"
                  ? "任务已停止，已有产物保留"
                  : "已重新派发任务",
          )
        }
      >
        {control.label}
      </button>
    );
  const run = (action: WorkflowAction, goal: boolean) =>
    act(
      action.kind === "triage" ? "/classify" : "/jobs",
      {
        issueIds: [issue.id],
        kind: action.kind,
        sourceJobId: action.sourceJobId,
        instructions,
        expectedVersion: actions.expectedVersion,
        goal:
          goal &&
          ["investigate", "fix", "docs"].includes(action.kind) &&
          !(issue.type === "pr" && action.kind === "investigate")
            ? "resolve"
            : undefined,
      },
      "已启动任务，结果会保存在此事项中",
    );
  return (
    <>
      {actions.primary && (
        <button
          className="mw-button primary"
          title={actions.primary.blockedReasons.join("；")}
          disabled={busy || !actions.primary.enabled}
          onClick={() => void run(actions.primary!, true)}
        >
          {actionLabel(actions.primary.kind, issue, job)}
        </button>
      )}
      <details className="mw-assistant-more">
        <summary>更多</summary>
        <div>
          {actions.stages
            .filter((action) => action.kind !== actions.primary?.kind)
            .map((action) => (
              <button
                key={action.kind}
                className="mw-button"
                disabled={busy || !action.enabled}
                title={action.blockedReasons.join("；")}
                onClick={() => void run(action, false)}
              >
                {actionLabel(action.kind, issue, job)}
              </button>
            ))}
          {job && (
            <button className="mw-button" onClick={() => openEvidence(job.id)}>
              查看执行记录
            </button>
          )}
        </div>
      </details>
    </>
  );
}
