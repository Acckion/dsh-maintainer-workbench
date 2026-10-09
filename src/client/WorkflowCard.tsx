import React, { useEffect, useState } from "react";
import type { Issue, IssuePlan, Job } from "../core/types.ts";
import type { WorkflowAction } from "./IssuePlanning.tsx";
import { useItemDraft, flushItemDraft } from "./item-draft.ts";
import { taskStatus } from "./review-evidence.ts";
import { kindNames } from "../core/types.ts";

const fieldLabels: Record<keyof IssuePlan, string> = {
  goal: "维护目标",
  scope: "修改范围与排除项",
  acceptanceCriteria: "验收条件（每行一项）",
  reproduction: "复现条件与步骤",
  expected: "预期行为",
  actual: "实际行为",
  category: "类型",
  decision: "取舍",
};

export function WorkflowCard({
  issue,
  history,
  busy,
  act,
}: {
  issue: Issue;
  history: Job[];
  busy: boolean;
  act: WorkflowAction;
}) {
  const draft = issue.orchestration?.draft,
    run = issue.orchestration?.run;
  const {
    draft: savedDraft,
    ready,
    error: draftError,
    update,
  } = useItemDraft(issue.id);
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState<IssuePlan | undefined>();
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
                expected: draft.expected,
                actual: draft.actual,
                decision: "accepted",
              }
        : undefined,
    );
  }, [draft?.inputKey, draft?.sourceJobId, run?.planVersion, issue.id, ready]);
  useEffect(
    () => setEditing(false),
    [draft?.inputKey, draft?.sourceJobId, run?.planVersion, issue.id],
  );
  const active = history.find((j) => ["queued", "running"].includes(j.status));
  const current = history.find((j) => j.id === run?.currentJobId);
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
  const status = issue.processingSuggestion?.status;
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
        route,
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
      <p>
        {issue.processingSuggestion?.reason ??
          "系统先整理已有材料、范围和验收草稿；只请你补充真正缺失的信息。"}
      </p>
      {run && (
        <>
          <ol className="mw-workflow-progress">
            {["确认计划", "实施或调查", "验证", "审查", "最终审核"].map(
              (label) => (
                <li key={label}>{label}</li>
              ),
            )}
          </ol>
          <p className="mw-muted">
            本次最多 {run.maxSteps} 个步骤 · 截止{" "}
            {new Date(run.deadlineAt).toLocaleString("zh-CN")} ·
            审查问题由你决定处置
          </p>
        </>
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
            {draft.missingInfo.length > 0 && (
              <div className="mw-callout amber">
                <strong>需要核对的缺口</strong>
                <ul>
                  {draft.missingInfo.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                <p>
                  已有材料由系统整理；下面可以修订草稿或从高级操作记录聚合追问。
                </p>
              </div>
            )}
            {editing && (
              <div className="mw-issue-planning">
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
              </div>
            )}
            <div className="mw-workflow-actions">
              {!["answer", "track"].includes(draft.route) &&
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
                    {draft.route === "review"
                      ? "确认并开始审查"
                      : draft.route === "investigate"
                        ? "确认并开始调查"
                        : "确认并开始"}
                  </button>
                )}
              <button
                className="mw-button"
                disabled={!ready || busy}
                onClick={() => setEditing(!editing)}
              >
                修改建议
              </button>
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
              恢复可继续的步骤
            </button>
          )}
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
          {run.status === "review" && (
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
              <p>
                本次执行已汇总到 Review 的最终审核；接受或退回后再选择具体交付。
              </p>
            </>
          )}
        </div>
      )}
      {history.length > 0 && (
        <details>
          <summary>事项执行历史 · {history.length} 次运行</summary>
          {history.map((j) => (
            <p key={j.id}>
              {kindNames[j.kind]} · {taskStatus(j).label} ·{" "}
              {new Date(j.createdAt).toLocaleString("zh-CN")}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
