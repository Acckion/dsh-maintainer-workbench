import {prReviewValidation} from '../core/pr-review-validation.ts';
import { EnvironmentStatus } from './EnvironmentStatus.tsx';
import {GapSummary} from './GapSummary.tsx';
import {readOnlyScope} from '../core/issue-flow.ts';
import React, { useEffect, useState } from "react";
import type { Issue, IssuePlan, Job } from "../core/types.ts";
import type { WorkflowAction } from "./IssuePlanning.tsx";
import { useItemDraft, flushItemDraft } from "./item-draft.ts";
import { categoryNames } from "../core/issue-flow.ts";
import { kindNames } from "../core/types.ts";

const fieldLabels: Record<keyof IssuePlan, string> = {
  goal: "维护目标",
  scope: "修改范围与排除项",
  acceptanceCriteria: "验收条件（每行一项）",
  reproduction: "复现条件与步骤（可选）",
  reproductionMode: "复现策略",
  expected: "预期行为",
  actual: "实际行为",
  category: "类型",
  decision: "取舍",
};

export function WorkflowCard({
  issue,
  history,
  busy,
  act: perform,
}: {
  issue: Issue;
  history: Job[];
  busy: boolean;
  act: WorkflowAction;
}) {
  const act: WorkflowAction = (path, data, message) =>
    perform(
      path,
      {
        ...(data as Record<string, unknown>),
        ...(path === "/workflow/analyze"
          ? {}
          : { expectedVersion: issue.processing?.version }),
      },
      message,
    );
  const draft = issue.orchestration?.draft,
    run = issue.orchestration?.run;
  const {
    draft: savedDraft,
    ready,
    error: draftError,
    update,
  } = useItemDraft(issue.id);
  const [plan, setPlan] = useState<IssuePlan | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  useEffect(() => {
    setPlan(
      draft
        ? ready &&
          savedDraft.plan &&
          savedDraft.systemPlanInputKey === draft.inputKey &&
          !["running", "review"].includes(run?.status ?? "")
          ? savedDraft.plan
          : run?.plan && draft.sourceJobId !== run.currentJobId
            ? run.plan
            : {
                category: draft.category,
                goal: draft.goal,
                scope: draft.scope,
                acceptanceCriteria: draft.acceptanceCriteria,
                reproduction: draft.reproduction,
                reproductionMode:
                  issue.plan?.reproductionMode ?? draft.reproductionMode,
                expected: draft.expected,
                actual: draft.actual,
                decision: "accepted",
              }
        : undefined,
    );
  }, [draft?.inputKey, draft?.sourceJobId, run?.planVersion, issue.id, ready]);
  const active = history.find((j) => ["queued", "running"].includes(j.status));
  const current = history.find((j) => j.id === run?.currentJobId);
  const pendingValidation=!!current && current.artifact?.stage==='review' && current.artifact.verdict==='no_findings' && !prReviewValidation(current,history,issue.processing).passed;
  const edit = (key: keyof IssuePlan, value: string) => {
    if (!plan || !draft) return;
    const next = {
      ...plan,
      [key]:
        key === "acceptanceCriteria"
          ? value.split("\n").filter((s) => s.trim())
          : value,
    };
    setPlan(next);
    update({ plan: next, systemPlanInputKey: draft.inputKey });
  };
  const status = issue.orchestrationView?.status;
  const suggestedRoute =
    issue.type === "pr" || !draft || !plan
      ? draft?.route
      : plan.category === "question"
        ? "answer"
        : plan.category === "docs"
          ? "docs"
          : ["answer", "docs"].includes(draft.route)
            ? "investigate"
            : draft.route;
  const start = async (
    route?: "fix" | "docs" | "investigate" | "review",
    sourceJobId?: string,
  ) => {
    if (!plan || !draft) return;
    await flushItemDraft(issue.id);
    return act(
      "/workflow/start",
      {
        issueId: issue.id,
        inputKey: draft.inputKey,
        expectedVersion: issue.processing?.version,
        plan,
        route: route ?? suggestedRoute,
        sourceJobId,
        feedback: current?.reviewNote,
      },
      "已确认计划，系统将连续执行并整理最终审核",
    );
  };
  if (issue.origin) return null;
  return (
    <section className="mw-workflow-card" aria-label="处理建议与进度">
      {draftError && <p role="alert">{draftError}</p>}
      <h3>{run ? "事项处理进度" : "系统处理建议"}</h3>
      <EnvironmentStatus job={current}/>
      <p>
        {issue.orchestrationView?.reason ??
          "系统先整理已有材料、范围和验收草稿；只请你补充真正缺失的信息。"}
      </p>
      {run && (
        <>
          <p className="mw-muted">
            本次最多 {run.maxSteps} 个步骤 · 截止{" "}
            {new Date(run.deadlineAt).toLocaleString("zh-CN")} ·
            审查问题由你决定处置
          </p>
        </>
      )}
      {run && ["paused", "blocked"].includes(run.status) && status !== "stale" && (
        <p>明确继续或重试会续期当前计划的执行预算，保留已有修改与历史记录。</p>
      )}
      {active ? (
        <p className="mw-callout">
          系统正在{kindNames[active.kind]}：
          {active.waitingReason || "执行后自动交接有效结果"}
        </p>
      ) : null}
      {!run || ["paused", "blocked", "cancelled"].includes(run.status) ? (
        draft && plan ? (
          <>
            <h4>目标与范围草稿</h4>
            <p>{plan.goal}</p>
            <p>范围：{plan.scope || "尚未明确"}</p>
            <ul>
              {plan.acceptanceCriteria.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            <details>
              <summary>草稿来源与覆盖</summary>
              {draft.sources.map((s, i) => (
                <p key={i}>
                  <strong>
                    {
                      {
                        goal: "目标",
                        scope: "范围",
                        acceptanceCriteria: "验收条件",
                        reproduction: "复现",
                        expected: "预期行为",
                        actual: "实际行为",
                        category: "事项类型",
                      }[s.field]
                    }
                  </strong>{" "}
                  · {s.source}：{s.detail}
                </p>
              ))}
            </details>
            <GapSummary plan={draft} />
            <details className="mw-plan-editor"><summary>编辑目标、范围与验收</summary>
              <div className="mw-issue-planning">
                <label>
                  处理类型
                  <select
                    aria-label="处理类型"
                    value={plan.category}
                    disabled={busy || !ready}
                    onChange={(e) => edit("category", e.target.value)}
                  >
                    {Object.entries(categoryNames).map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {plan.category === "bug" && issue.type === "issue" && (
                  <label>
                    复现策略
                    <select
                      aria-label="复现策略"
                      value={plan.reproductionMode ?? "omit"}
                      onChange={(e) => edit("reproductionMode", e.target.value)}
                    >
                      <option value="omit">不主动复现（默认）</option>
                      <option value="best_effort">让 Agent 尝试复现</option>
                      <option value="required">必须复现后继续</option>
                    </select>
                  </label>
                )}
                {(
                  [
                    "goal",
                    "scope",
                    "acceptanceCriteria",
                    ...(plan.category === "bug" && issue.type === "issue"
                      ? ["reproduction", "expected", "actual"]
                      : []),
                  ] as (keyof IssuePlan)[]
                ).map((key) => (
                  <label key={key}>
                    {fieldLabels[key]}
                    <textarea
                      aria-label={fieldLabels[key]}
                      value={
                        Array.isArray(plan[key])
                          ? (plan[key] as string[]).join("\n")
                          : plan[key]
                      }
                      onChange={(e) => edit(key, e.target.value)}
                      rows={3}
                    />
                  </label>
                ))}
                <button
                  type="button"
                  className="mw-button"
                  disabled={
                    busy ||
                    saving ||
                    !ready ||
                    (issue.type === "issue" && !!active)
                  }
                  onClick={async () => {
                    setSaving(true);
                    setSaveMessage("");
                    try {
                      await flushItemDraft(issue.id);
                      if (issue.type === "issue")
                        await act(
                          "/issue-plan",
                          {
                            issueId: issue.id,
                            plan: {
                              ...plan,
                              decision: issue.plan?.decision ?? "proposed",
                            },
                          },
                          "已保存计划，尚未开始执行",
                        );
                      else setSaveMessage("草稿已保存，确认开始后才生效。");
                    } catch (error) {
                      setSaveMessage(
                        error instanceof Error ? error.message : "保存失败",
                      );
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  {saving
                    ? "正在保存…"
                    : issue.type === "pr"
                      ? "保存草稿"
                      : "保存计划"}
                </button>
                {saveMessage && <p role="status">{saveMessage}</p>}
              </div>
            </details>
            <div className="mw-workflow-actions">
              {!["answer", "track"].includes(suggestedRoute ?? "") &&
                status !== "stale" &&
                !run && (
                  <button
                    className="mw-button primary"
                    disabled={
                      busy ||
                      !ready ||
                      issue.processing?.waits.some(
                        (w) =>
                          w.state === "open" &&
                          ["user_input", "environment_ready"].includes(w.type),
                      ) ||
                      !!active ||
                      !plan.goal ||
                      !plan.scope ||
                      !plan.acceptanceCriteria.length
                    }
                    onClick={() => void start()}
                  >
                    {suggestedRoute === "review"
                      ? "确认并开始审查"
                      : (draft.route === "investigate" || readOnlyScope(plan.scope))
                        ? "确认并开始调查"
                        : "确认并开始"}
                  </button>
                )}
              {!plan.scope || !plan.acceptanceCriteria.length ? (
                <button
                  className="mw-text-button"
                  disabled={busy || !!active}
                  onClick={() =>
                    void act(
                      "/workflow/analyze",
                      { issueIds: [issue.id], refresh: true },
                      "已重新整理现有材料",
                    )
                  }
                >
                  重新整理建议
                </button>
              ) : null}
              {!run && (
                <button
                  className="mw-text-button"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      "/decision",
                      {
                        issueId: issue.id,
                        stage: "deferred",
                        reason: "维护者暂缓处理",
                      },
                      "已暂缓",
                    )
                  }
                >
                  暂缓
                </button>
              )}
            </div>
          </>
        ) : null
      ) : null}
      {draft?.route === "answer" && (
        <section>
          <h4>答复草稿</h4>
          <p>
            {history.find((j) => j.id === draft.sourceJobId)?.result
              ?.responseDraft || "尚无答复草稿，请重新整理材料"}
          </p>
          <p>在概览核对来源后接受此报告，再预览并确认发布答复。</p>
        </section>
      )}
      {draft?.route === "track" && (
        <p>建议跟踪已有工作，请查看关联 PR 和远端进度。</p>
      )}
      {issue.informationRequests
        ?.filter((r) => r.state === "reply_received")
        .map((r) => (
          <section key={r.id}>
            <h4>有新回复，待重新评估</h4>
            {r.replies.map((reply) => (
              <p key={reply.id}>
                {reply.author}：{reply.body}
              </p>
            ))}
            <button
              className="mw-button"
              disabled={busy || !!active}
              onClick={async () => {
                const result = await act(
                  "/information/finish",
                  { issueId: issue.id, requestId: r.id, state: "fulfilled" },
                  "已核对补充信息",
                );
                if (result)
                  await act(
                    "/workflow/analyze",
                    { issueIds: [issue.id] },
                    "已开始重新评估补充信息",
                  );
              }}
            >
              信息已足够
            </button>
          </section>
        ))}
      {!active && status !== "waiting" && (!draft || status === "stale") && (
        <button
          className="mw-button primary"
          disabled={busy}
          onClick={() =>
            void act(
              "/workflow/analyze",
              { issueIds: [issue.id], refresh: status === "stale" },
              "已开始整理处理建议",
            )
          }
        >
          开始处理
        </button>
      )}
      {run && (
        <div className="mw-workflow-actions">
          {run.status === "running" && (
            <>
              <button
                className="mw-button"
                disabled={busy}
                onClick={() =>
                  void act(
                    "/workflow/pause",
                    { issueId: issue.id },
                    "已暂停后续推进，当前任务结果会保留",
                  )
                }
              >
                暂停
              </button>
              <button
                className="mw-text-button"
                disabled={busy}
                onClick={() =>
                  void act(
                    "/workflow/cancel",
                    { issueId: issue.id },
                    "已取消执行，产物保留",
                  )
                }
              >
                取消
              </button>
            </>
          )}
          {["failed", "cancelled", "rejected"].includes(
            current?.status ?? "",
          ) && (
            <button
              className="mw-button"
              disabled={busy || !!active}
              onClick={() =>
                void act(
                  "/workflow/retry",
                  { issueId: issue.id },
                  "已按明确授权重试当前步骤",
                )
              }
            >
              检查现场后重试当前步骤
            </button>
          )}
          {["paused", "blocked"].includes(run.status) && status !== "stale" && (
            <button
              className="mw-button"
              disabled={busy || !!active}
              onClick={() =>
                void act(
                  "/workflow/resume",
                  { issueId: issue.id },
                  "已检查并恢复计划",
                )
              }
            >
              {current?.status === "waiting_environment" && current.kind === "validate" ? "重新检查环境并继续验证" : "恢复可继续的步骤"}
            </button>
          )}
          {current?.kind==='validate'&&current.status==='waiting_environment'&&<button className="mw-button" disabled={busy||!!active} onClick={()=>void act('/environment/prepare',{id:current.id},'已授权本次工作区准备依赖，成功后自动验证')}>授权本次依赖准备并继续</button>}
          {["paused", "blocked", "cancelled"].includes(run.status) &&
            draft &&
            plan && (
              <button
                className="mw-button"
                disabled={busy || !!active}
                onClick={() =>
                  void start(
                    plan.category === "docs" ? "docs" : "fix",
                    current?.kind === "validate"
                      ? current.sourceJobId
                      : current?.id,
                  )
                }
              >
                确认修订并继续
              </button>
            )}
          {run.status === "review" && pendingValidation && <>
            <p className="mw-callout amber">源码审查已完成，必要验证尚未补齐；完成后再最终审核。</p>
            <button className="mw-button primary" disabled={busy || !!active || status === "stale"} onClick={()=>void act("/workflow/resume",{issueId:issue.id},"已继续当前计划的必要验证")}>继续工作流，补齐验证</button>
          </>}
          {run.status === "review" && !pendingValidation && (
            <>
              <button
                className="mw-button"
                disabled={busy || !!active}
                onClick={() =>
                  void start(
                    plan?.category === "docs" ? "docs" : "fix",
                    current?.id,
                  )
                }
              >
                交给 Agent 修订（确认范围）
              </button>
              {issue.type === "pr" &&
                current?.publications?.review?.status === "published" && (
                  <button
                    className="mw-button"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        "/workflow/wait-author",
                        { id: current.id },
                        "已等待作者新提交，届时自动复核",
                      )
                    }
                  >
                    交给作者，等待新提交
                  </button>
                )}
              <p>请在维护者确认阶段核对结果，接受或退回后再选择交付操作。</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
