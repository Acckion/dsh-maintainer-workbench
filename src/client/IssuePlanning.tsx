import React, { useEffect, useState } from "react";
import { categoryNames, defaultPlan, planBlocker } from "../core/issue-flow.ts";
import type { Issue, IssuePlan, Job } from "../core/types.ts";
import { useItemDraft } from "./item-draft.ts";

export type WorkflowAction = (
  path: string,
  data: unknown,
  message: string,
) => Promise<unknown>;
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
export function IssuePlanning({
  issue,
  job,
  busy,
  act: perform,
  start,
}: {
  issue: Issue;
  job?: Job;
  busy: boolean;
  act: WorkflowAction;
  start?: (kind: "fix" | "docs", version?: number) => Promise<unknown>;
}) {
  const act: WorkflowAction = (path, data, message) =>
    perform(
      path,
      {
        ...(data as Record<string, unknown>),
        expectedVersion: issue.processing?.version,
      },
      message,
    );
  const { draft, ready, error, update } = useItemDraft(issue.id);
  const restored = React.useRef(false);
  useEffect(() => {
    if (ready && !restored.current) {
      restored.current = true;
      if (draft.plan) setPlan(draft.plan);
    }
  }, [ready]);
  const [plan, setPlan] = useState(defaultPlan(issue));
  const [planOpen, setPlanOpen] = useState(
    !!issue.plan || issue.analysis?.category === "feature",
  );
  useEffect(() => {
    setPlanOpen(!!issue.plan || issue.analysis?.category === "feature");
  }, [issue.id]);
  const [questions, setQuestions] = useState("");
  const [waitingFor, setWaitingFor] = useState(issue.author);
  const [askedAt, setAskedAt] = useState("");
  const [answer, setAnswer] = useState("");
  const [informationOpen, setInformationOpen] = useState(
    !!issue.informationRequests?.some((r) =>
      ["asked", "reply_received"].includes(r.state),
    ),
  );
  useEffect(() => {
    if (
      issue.informationRequests?.some((r) =>
        ["asked", "reply_received"].includes(r.state),
      )
    )
      setInformationOpen(true);
  }, [
    issue.informationRequests?.filter((r) =>
      ["asked", "reply_received"].includes(r.state),
    ).length,
  ]);
  const planKey = JSON.stringify(issue.plan);
  useEffect(() => {
    if (!restored.current) setPlan(defaultPlan(issue));
  }, [issue.id, planKey, issue.analysis?.category]);
  useEffect(() => {
    setQuestions("");
    setWaitingFor(issue.author);
    setAnswer("");
    setAskedAt("");
  }, [issue.id]);
  const active =
    issue.informationRequests?.filter((request) =>
      ["asked", "reply_received"].includes(request.state),
    ) ?? [];
  const pendingQuestions = new Set(
    active.flatMap((request) =>
      request.questions.map((text) => text.trim().toLowerCase()),
    ),
  );
  const missing = (
    job?.artifact?.stage === "triage"
      ? job.artifact.missingInfo
      : (issue.analysis?.missingInfo ?? [])
  ).filter((text) => !pendingQuestions.has(text.trim().toLowerCase()));
  const edit = <K extends keyof IssuePlan>(key: K, value: IssuePlan[K]) => {
    const next = { ...plan, [key]: value };
    setPlan(next);
    if (ready) update({ plan: next });
  };
  const blocker = planBlocker(
    { ...issue, plan },
    plan.category === "docs" ? "docs" : "fix",
  );
  return (
    <section aria-label="事项类型与补充信息" className="mw-issue-planning">
      <p className="mw-muted">此处编辑的是本机草稿；确认后才更新正式计划。</p>
      {error && <p role="alert">{error}</p>}
      <details
        open={true}
        onToggle={(event) => setPlanOpen(event.currentTarget.open)}
      >
        <summary>事项类型、目标与验收</summary>
        <label>
          处理类型
          <select
            aria-label="处理类型"
            value={plan.category}
            disabled={busy}
            onChange={(event) =>
              edit("category", event.target.value as IssuePlan["category"])
            }
          >
            {Object.entries(categoryNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {plan.category === "question" ? "需要回答的问题" : "维护目标"}
          <textarea
            aria-label={
              plan.category === "question" ? "需要回答的问题" : "维护目标"
            }
            value={plan.goal}
            rows={2}
            onChange={(event) => edit("goal", event.target.value)}
          />
        </label>
        {plan.category === "bug" && (
          <>
            <label>
              复现条件与步骤
              <textarea
                aria-label="复现条件与步骤"
                rows={3}
                value={plan.reproduction}
                onChange={(event) => edit("reproduction", event.target.value)}
              />
            </label>
            <label>
              预期行为
              <textarea
                aria-label="预期行为"
                rows={2}
                value={plan.expected}
                onChange={(event) => edit("expected", event.target.value)}
              />
            </label>
            <label>
              实际行为
              <textarea
                aria-label="实际行为"
                rows={2}
                value={plan.actual}
                onChange={(event) => edit("actual", event.target.value)}
              />
            </label>
          </>
        )}
        <label>
          {plan.category === "docs" ? "文档位置与修改范围" : "实施范围与排除项"}
          <textarea
            aria-label={
              plan.category === "docs"
                ? "文档位置与修改范围"
                : "实施范围与排除项"
            }
            rows={2}
            value={plan.scope}
            onChange={(event) => edit("scope", event.target.value)}
          />
        </label>
        <label>
          验收条件（每行一项）
          <textarea
            aria-label="验收条件（每行一项）"
            rows={3}
            value={plan.acceptanceCriteria.join("\n")}
            onChange={(event) =>
              edit("acceptanceCriteria", event.target.value.split("\n"))
            }
          />
        </label>
        <label>
          维护者取舍
          <select
            aria-label="维护者取舍"
            value={plan.decision}
            onChange={(event) =>
              edit("decision", event.target.value as IssuePlan["decision"])
            }
          >
            <option value="proposed">待决定</option>
            <option value="accepted">接受目标与范围</option>
            <option value="deferred">暂缓</option>
          </select>
        </label>
        {plan.category !== "question" && blocker && (
          <p className="mw-callout amber">{blocker}</p>
        )}
        <p className="mw-muted">
          保存新的目标或验收条件会使旧版本产物失效。文档事项可直接进入文档维护。
        </p>
        <button
          className="mw-button primary"
          disabled={busy || !ready}
          onClick={() =>
            void act(
              "/issue-plan",
              {
                issueId: issue.id,
                plan: {
                  ...plan,
                  acceptanceCriteria: lines(plan.acceptanceCriteria.join("\n")),
                },
              },
              "已保存事项类型与验收计划",
            )
          }
        >
          确认类型与验收计划
        </button>
        {start &&
          !["question"].includes(plan.category) &&
          plan.decision !== "deferred" && (
            <button
              className="mw-button primary"
              disabled={
                busy ||
                !ready ||
                !!planBlocker(
                  { ...issue, plan: { ...plan, decision: "accepted" } },
                  plan.category === "docs" ? "docs" : "fix",
                )
              }
              onClick={async () => {
                const confirmed = {
                  ...plan,
                  decision: "accepted" as const,
                  acceptanceCriteria: lines(plan.acceptanceCriteria.join("\n")),
                };
                const saved = await act(
                  "/issue-plan",
                  { issueId: issue.id, plan: confirmed },
                  "已确认计划",
                );
                if (saved) {
                  setPlan(confirmed);
                  update({ plan: confirmed });
                  await start(
                    plan.category === "docs" ? "docs" : "fix",
                    (saved as { version?: number }).version,
                  );
                }
              }}
            >
              {plan.category === "docs"
                ? "确认并更新文档"
                : "确认计划并开始实施"}
            </button>
          )}
      </details>
      <details
        open={informationOpen}
        onToggle={(event) => setInformationOpen(event.currentTarget.open)}
      >
        <summary>
          补充信息与追问记录 · {issue.informationRequests?.length ?? 0}
        </summary>
        {(issue.informationRequests ?? []).map((request) => (
          <article className="mw-stage-event" key={request.id}>
            <strong>
              等待 {request.waitingFor} ·{" "}
              {
                {
                  asked: "已记录提问",
                  reply_received: "有新回复，待重新评估",
                  fulfilled: "维护者确认信息已足够",
                  dismissed: "已结束此追问",
                }[request.state]
              }
            </strong>
            <small>
              {new Date(request.askedAt).toLocaleString("zh-CN")} ·
              维护者本地记录
            </small>
            <ul>
              {request.questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
            {request.warning && (
              <p className="mw-callout amber">{request.warning}</p>
            )}
            {request.replies.map((reply) => (
              <details key={reply.id}>
                <summary>
                  {reply.author} 的补充回复 ·{" "}
                  {new Date(reply.createdAt).toLocaleString("zh-CN")}
                </summary>
                <pre>{reply.body}</pre>
                <a href={reply.url} target="_blank" rel="noreferrer">
                  查看 GitHub 原文
                </a>
              </details>
            ))}
            {["asked", "reply_received"].includes(request.state) && (
              <div className="mw-workflow-actions">
                <button
                  className="mw-button"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      "/information/finish",
                      {
                        issueId: issue.id,
                        requestId: request.id,
                        state: "fulfilled",
                      },
                      "已确认信息足够，可重新分诊或继续调查",
                    )
                  }
                >
                  信息已足够
                </button>
                <button
                  className="mw-text-button"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      "/information/finish",
                      {
                        issueId: issue.id,
                        requestId: request.id,
                        state: "dismissed",
                      },
                      "已结束此追问",
                    )
                  }
                >
                  结束追问
                </button>
              </div>
            )}
          </article>
        ))}
        <p className="mw-muted">
          先通过发布回复或 GitHub
          提出问题，再在这里记录。记录不会发送消息；同步仓库时检查指定用户的新评论。
        </p>
        {missing.length > 0 && (
          <button
            className="mw-text-button"
            disabled={busy}
            onClick={() => setQuestions(missing.join("\n"))}
          >
            填入尚未追问的信息缺口
          </button>
        )}
        <label>
          已提出的问题（每行一项）
          <textarea
            aria-label="已提出的问题（每行一项）"
            rows={3}
            value={questions}
            onChange={(event) => setQuestions(event.target.value)}
          />
        </label>
        <label>
          等待回复的 GitHub 用户名
          <input
            value={waitingFor}
            onChange={(event) => setWaitingFor(event.target.value)}
          />
        </label>
        <label>
          实际提问时间（可选，留空为现在）
          <input
            type="datetime-local"
            value={askedAt}
            onChange={(event) => setAskedAt(event.target.value)}
          />
        </label>
        <button
          className="mw-button"
          disabled={busy || !lines(questions).length || !waitingFor.trim()}
          onClick={async () => {
            const result = await act(
              "/information",
              {
                issueId: issue.id,
                questions: lines(questions),
                waitingFor,
                ...(askedAt
                  ? { askedAt: new Date(askedAt).toISOString() }
                  : {}),
              },
              "已记录追问；重复问题会复用已有记录",
            );
            if (result) {
              setQuestions("");
              setAskedAt("");
            }
          }}
        >
          记录已提出的追问
        </button>
      </details>
      {plan.category === "question" && (
        <section>
          <h4>答复并结束本地处理</h4>
          <p className="mw-muted">
            记录已给出的答复或发布链接；GitHub Issue 的关闭状态仍由远端同步。
          </p>
          <label>
            已给出的答复或链接
            <textarea
              aria-label="已给出的答复或链接"
              rows={3}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
          </label>
          {job?.result?.responseDraft && (
            <button
              className="mw-text-button"
              onClick={() => setAnswer(job.result!.responseDraft)}
            >
              使用当前答复草稿
            </button>
          )}
          <button
            className="mw-button"
            disabled={busy || !answer.trim()}
            onClick={() =>
              void act(
                "/decision",
                { issueId: issue.id, stage: "answered", reason: answer },
                "已记录答复并结束本地处理，未关闭远端 Issue",
              )
            }
          >
            记录答复并结束
          </button>
        </section>
      )}
    </section>
  );
}
