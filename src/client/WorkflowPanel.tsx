import { useEffect, useState } from "react";
import { organizeActions } from "../core/organize.ts";
import { validationInstructions } from "../core/validation-scope.ts";
import { availableActions } from "../workflow/actions.ts";
import { RemoteProgress } from "./RemoteProgress.tsx";

import type { Issue, Job, JobKind } from "../core/types.ts";
import { kindNames } from "../core/types.ts";
import { validationState } from "../core/workflow-state.ts";
import { IssuePlanning } from "./IssuePlanning.tsx";
import { WorkflowCard } from "./WorkflowCard.tsx";
import { reviewVerdicts } from "./review-evidence.ts";
import { ReviewFindingControls } from "./ReviewFindingControls.tsx";
const stages: Record<string, string> = {
  answered: "答复已记录，本地处理结束",
  needs_info: "等待补充信息",
  decision: "等待维护者决策",
  accepted: "已接受",
  deferred: "已暂缓",
  investigate: "调查原因",
  implement: "可以实施",
  answer: "准备答复",
  track: "跟踪已有工作",
  draft: "远端草稿阶段",
  review: "等待审查",
  blocked: "存在阻塞",
  fix: "实施完成",
  docs: "文档变更完成",
  validate: "验证完成",
  validated: "验证报告通过",
  ci: "CI 诊断完成",
};
export function WorkflowPanel({
  issue,
  job,
  history,
  busy,
  act,
  hideSummary = false,
  compact = false,
}: {
  issue: Issue;
  job?: Job;
  history: Job[];
  busy: boolean;
  hideSummary?: boolean;
  compact?: boolean;
  act: (path: string, data: unknown, message: string) => Promise<unknown>;
}) {
  const [instructions, setInstructions] = useState("");
  useEffect(() => {
    setInstructions("");
  }, [job?.id]);
  const a = job?.artifact;
  const validation = validationState(a);
  const actions =
    job?.actionsAvailable ??
    issue.actionsAvailable ??
    availableActions(issue, job, history);
  const primary = actions.primary?.kind;
  const blocker = actions.primary?.blockedReasons.join("；") || undefined;
  const next = async (kind: JobKind) =>
    act(
      "/jobs",
      {
        issueIds: [issue.id],
        expectedVersion: actions.expectedVersion,
        kind,
        sourceJobId: actions.stages.find((action) => action.kind === kind)
          ?.sourceJobId,
        instructions:
          kind === "validate"
            ? validationInstructions(instructions, job?.kind)
            : issue.origin === "repository"
              ? `Repository maintenance follow-up. Current stage is ${kind}; preserve the accepted scope and use handoff evidence. ${kind === "docs" && issue.organizeMode ? organizeActions[issue.organizeMode === "audit" ? "docs" : issue.organizeMode].instructions : ""} ${instructions}`
              : instructions,
      },
      "已派发下一阶段，自动交接现有证据",
    );
  if (compact)
    return (
      <section className="mw-triage-followup">
        <WorkflowCard issue={issue} history={history} busy={busy} act={act} />
        {!issue.origin && issue.type === "issue" && issue.state === "open" && (
          <IssuePlanning issue={issue} job={job} busy={busy} act={act} />
        )}
        {a?.stage === "preflight" && a.risks.length > 0 && (
          <section>
            <h4>需核对事项</h4>
            <ul>
              {a.risks.map((risk, index) => (
                <li key={index}>{risk}</li>
              ))}
            </ul>
          </section>
        )}
        {job?.prContext && (
          <details>
            <summary>判断依据 · PR 版本与 CI</summary>
            <p>
              HEAD {job.prContext.headSha} · BASE {job.prContext.baseSha}
            </p>
            {job.prContext.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
            <pre>
              {JSON.stringify(
                {
                  checks: job.prContext.checks,
                  reviews: job.prContext.reviews,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </section>
    );
  return (
    <section className={compact ? "mw-triage-followup" : "mw-workflow"}>
      {compact && (
        <p className="mw-muted">
          {job?.status === "completed" ? "分析报告已保存" : "尚未完成分析"}
          {issue.type === "pr" && (
            <>
              {" "}
              ·{" "}
              {history.some((j) => j.kind === "review")
                ? "已创建代码审查任务，可在 Execution 查看"
                : "尚未启动代码审查"}
            </>
          )}
        </p>
      )}
      {!compact && (
        <div className="mw-section-title">
          处理流程{" "}
          <span className="mw-tag">
            {issue.state === "closed"
              ? issue.merged
                ? "GitHub 已合并"
                : "GitHub 已关闭"
              : (stages[issue.processing?.phase ?? ""] ??
                (issue.origin === "repository"
                  ? "仓库整理任务"
                  : issue.type === "pr"
                    ? "待预检"
                    : "待分诊"))}
          </span>
        </div>
      )}
      <WorkflowCard issue={issue} history={history} busy={busy} act={act} />
      {!issue.origin && issue.type === "issue" && issue.state === "open" && (
        <details><summary>高级操作</summary>
        <IssuePlanning issue={issue} job={job} busy={busy} act={act} />
        </details>
      )}
      {job?.deliveryReviewId && (
        <p className="mw-callout">
          此产物保存了审查关联；当前有效性与限制请核对审阅摘要，发布时仍会再次检查。
        </p>
      )}
      {job?.artifactState === "stale" && (
        <div className="mw-callout amber">
          此产物对应旧版本，仅供参考；请对当前版本重新执行。
        </div>
      )}
      {!hideSummary && (
        <p className="mw-muted">
          {a?.summary ??
            issue.processing?.reason ??
            "先判断处理方向，再按需要调查、实施和验证。"}
        </p>
      )}
      {!compact && (
        <RemoteProgress key={issue.id} issue={issue} busy={busy} act={act} />
      )}
      {validation && validation.state !== "passed" && (
        <div className="mw-callout amber">
          <strong>{validation.reason}</strong>
        </div>
      )}
      {a && (
        <>
          {!hideSummary && <p>{a.coverage}</p>}
          {a.stage === "triage" && (
            <div className="mw-callout">
              <div>
                <strong>
                  {stages[a.route]} · {a.module || "模块待确定"}
                </strong>
                <p>{a.routeReason}</p>
                <p>影响：{a.impact}</p>
              </div>
            </div>
          )}
          {(a.stage === "investigate" || a.stage === "ci") && (
            <>
              <h4>事实与假设</h4>
              {"facts" in a &&
                a.facts.map((s, i) => <p key={`f${i}`}>事实：{s}</p>)}
              {"hypotheses" in a &&
                a.hypotheses.map((s, i) => <p key={`h${i}`}>待验证：{s}</p>)}
            </>
          )}
          {a.stage === "ci" && (
            <p className="mw-callout">
              诊断判断：
              {
                {
                  regression: "代码回归",
                  baseline: "基线已有问题",
                  flaky: "不稳定测试",
                  environment: "环境失败",
                  unknown: "无法确定",
                }[a.classification]
              }
              。请结合事实与假设核对，分类不是自动确认的根因。
            </p>
          )}
          {a.stage === "preflight" && a.risks.length > 0 && (
            <>
              <h4>需核对事项</h4>
              <ul>
                {a.risks.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <p className="mw-muted">
                以下是需要核对的影响点，不代表已发现缺陷。
              </p>
            </>
          )}
          {a.stage === "investigate" && (
            <>
              <h4>复现与根因</h4>
              <p>{a.reproduction}</p>
              <p>{a.rootCause}</p>
            </>
          )}
          {"acceptanceCriteria" in a && (
            <>
              <h4>验收条件</h4>
              <ul>
                {a.acceptanceCriteria.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {"blockers" in a && a.blockers.length > 0 && (
            <div className="mw-callout amber">
              <div>
                <strong>阻塞</strong>
                {a.blockers.map((s, i) => (
                  <p key={i}>{s}</p>
                ))}
              </div>
            </div>
          )}
          {a.stage === "review" && (
            <>
              <h4>审查发现 · {a.findings.length}</h4>
              <p>{reviewVerdicts[a.verdict]}</p>
              {a.findings.length === 0 && a.verdict !== "incomplete" && (
                <p>本次覆盖范围内没有已确认的发现；请同时检查覆盖限制。</p>
              )}
              {a.findings.map((f) => (
                <article className="mw-finding" key={f.id}>
                  <strong>
                    {f.severity} · {f.title}
                  </strong>
                  <code>
                    {f.path}
                    {f.line ? `:${f.line}` : ""}
                  </code>
                  <p>触发条件：{f.trigger}</p>
                  <p>{f.evidence}</p>
                  <p>建议：{f.recommendation}</p>
                  <label>
                    维护者处置
                    <select
                      disabled={busy || job?.artifactState === "stale"}
                      value={job?.findingDecisions?.[f.id] ?? ""}
                      onChange={(e) =>
                        void act(
                          "/finding",
                          {
                            id: job!.id,
                            findingId: f.id,
                            decision: e.target.value,
                          },
                          "已保存发现处置",
                        )
                      }
                    >
                      <option value="" disabled>
                        尚未决定
                      </option>
                      <option value="accepted">接受，交给实施</option>
                      <option value="needs_evidence">需要更多证据</option>
                      <option value="dismissed">不适用</option>
                      <option value="resolved">已解决（维护者判断）</option>
                    </select>
                  </label>
                </article>
              ))}
            </>
          )}
        </>
      )}
      {job?.artifact?.stage === "review" && (
        <ReviewFindingControls
          key={job.id}
          job={job}
          history={history}
          busy={busy}
          act={act}
        />
      )}
      {job?.ciEvidence && (
        <details>
          <summary>本次 CI 诊断使用的 Actions 证据</summary>
          <p>
            固定提交 <code>{job.ciEvidence.snapshot.headSha}</code> ·{" "}
            {job.ciEvidence.snapshot.syncedAt}
          </p>
          {job.ciEvidence.snapshot.warnings.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
          {job.ciEvidence.logs.map((log) => (
            <details key={log.jobId}>
              <summary>
                run {log.runId} · 第 {log.attempt} 次 · job {log.jobId}
              </summary>
              {log.truncated && <p>诊断上下文已裁剪，不能视为完整日志。</p>}
              <pre>{log.text}</pre>
            </details>
          ))}
        </details>
      )}
      {job?.prContext && (
        <details>
          <summary>PR 版本、CI 与审查事实</summary>
          <p>Head：{job.prContext.headSha}</p>
          <p>Base：{job.prContext.baseSha}</p>
          <p>
            {job.prContext.draft ? "草稿" : "非草稿"} · GitHub 可合并状态：
            {job.prContext.mergeable === null
              ? "未知"
              : job.prContext.mergeable
                ? "可合并"
                : "存在冲突或不可合并"}
          </p>
          {job.prContext.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <pre>
            {JSON.stringify(
              {
                checks: job.prContext.checks,
                reviews: job.prContext.reviews,
                reviewComments: job.prContext.reviewComments,
                commitStatus: job.prContext.commitStatus,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
      {blocker && <p className="mw-callout amber">{blocker}</p>}
      {issue.state === "open" && (
        <>
          <details>
            <summary>补充要求与下一步操作</summary>
            <label>
              给下一次 Agent 任务补充要求
              <textarea
                rows={3}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="可选。已有调查、验收条件和处置记录将自动传递。"
              />
            </label>
            <div className="mw-workflow-actions">
              {primary && (
                <button
                  className="mw-button primary"
                  disabled={
                    busy ||
                    !!blocker ||
                    history.some((j) =>
                      ["running", "queued"].includes(j.status),
                    )
                  }
                  onClick={() => void next(primary)}
                >
                  下一步：{kindNames[primary]}
                </button>
              )}
            </div>
          </details>
          {!compact && (
            <details>
              <summary>其他阶段与快捷操作</summary>
              <div className="mw-workflow-actions">
                {actions.stages.map((action) => {
                  const k = action.kind;
                  return (
                    <button
                      className="mw-button"
                      key={k}
                      disabled={
                        busy ||
                        !action.enabled ||
                        history.some((j) =>
                          ["running", "queued"].includes(j.status),
                        )
                      }
                      onClick={() => void next(k as JobKind)}
                    >
                      {kindNames[k as JobKind]}
                    </button>
                  );
                })}
              </div>
            </details>
          )}
          {issue.type === "issue" && (
            <div className="mw-workflow-actions">
              {[
                ["accepted", "接受事项"],
                ["needs_info", "等待信息"],
                ["deferred", "暂缓"],
              ].map(([stage, label]) => (
                <button
                  className="mw-text-button"
                  key={stage}
                  disabled={busy}
                  onClick={() =>
                    void act(
                      "/decision",
                      { issueId: issue.id, stage, reason: instructions },
                      "已更新本地处理阶段",
                    )
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <details>
        <summary>阶段历史与交接 · {history.length}</summary>
        {[...history].reverse().map((j) => (
          <div className="mw-stage-event" key={j.id}>
            <strong>{kindNames[j.kind]}</strong>
            <span>{new Date(j.createdAt).toLocaleString("zh-CN")}</span>
            <p>{j.error ?? j.result?.summary ?? "尚无产物"}</p>
            {j.sourceJobId && (
              <small>继承来源：{j.sourceJobId.slice(0, 8)}</small>
            )}
            {j.reviewNote && <p>维护者反馈：{j.reviewNote}</p>}
          </div>
        ))}
      </details>
    </section>
  );
}
