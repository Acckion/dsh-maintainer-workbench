import { useEffect, useState } from "react";
import { kindNames, type Issue, type Job, type JobKind } from "../core/types.ts";
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
  const firstControl = actions.controls?.[0];
  const control = firstControl?.kind === "resume" && !firstControl.enabled ? undefined : firstControl;
  const [selected, setSelected] = useState<JobKind>();
  const [supplement, setSupplement] = useState(instructions ?? "");
  useEffect(() => { setSupplement(instructions ?? ""); }, [issue.id, instructions]);
  useEffect(() => { setSelected(undefined); }, [issue.id, actions.primary?.kind]);
  const stage = actions.stages.find(action => action.kind === selected) ?? actions.primary ?? actions.stages[0];
  const additionalReasons = stage?.input?.reasons.filter(reason => !stage.input?.warnings.includes(reason)) ?? [];
  const controlButton = control && (
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
  const run = (action: WorkflowAction) =>
    act(
      "/jobs",
      {
        issueIds: [issue.id],
        kind: action.kind,
        sourceJobId: action.sourceJobId,
        instructions: supplement,
        supplementalInfo: supplement,
        forceNew: true,
        expectedVersion: actions.expectedVersion,
      },
      "已启动任务，结果会保存在此事项中",
    );
  return (
    <>
      {control?.kind !== "cancel" && controlButton}
      {stage && (
        <div className="mw-stage-launcher">
          <label>
            独立执行节点
            <select aria-label="独立执行节点" value={stage.kind} onChange={event => setSelected(event.target.value as JobKind)}>
              {actions.stages.map(action => <option key={action.kind} value={action.kind}>{kindNames[action.kind]}</option>)}
            </select>
          </label>
          {stage.input?.warnings.map(warning => <p key={warning} className="mw-callout amber" role="status">{warning}</p>)}
          {!!additionalReasons.length &&
            <p className="mw-callout amber">{additionalReasons.join("；")} 请在补充信息中明确本次执行要求。</p>}
          <label>
            用户补充信息（{stage.input?.required ? "必填" : "可选"}）
            <textarea aria-label="用户补充信息" required={stage.input?.required} value={supplement} rows={3}
              onChange={event => setSupplement(event.target.value)} placeholder="说明本节点的目标、范围、已有背景，以及验证或审查的对象。" />
          </label>
          <button
            className="mw-button primary"
            title={stage.blockedReasons.join("；") || (stage.input?.required && !supplement.trim() ? "请先填写用户补充信息" : undefined)}
            disabled={busy || !stage.enabled || (stage.input?.required && !supplement.trim())}
            onClick={() => void run(stage)}
          >
            {actionLabel(stage.kind, issue, job)}
          </button>
          {!!stage.blockedReasons.length && <p className="mw-callout amber">{stage.blockedReasons.join("；")}</p>}
        </div>
      )}
      {((!projected && job) || control?.kind === "cancel") && <details className="mw-assistant-more">
        <summary>更多</summary>
        <div>
          {control?.kind === "cancel" && controlButton}
          {!projected && job &&
          <button className="mw-button" onClick={() => openEvidence(job.id)}>
            查看执行记录
          </button>}
        </div>
      </details>}
    </>
  );
}
