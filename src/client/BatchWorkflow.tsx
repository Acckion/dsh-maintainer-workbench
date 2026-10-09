import React, { useState } from "react";
import { kindNames } from "../core/types.ts";
import type { Issue } from "../core/types.ts";
import type { WorkflowAction } from "./IssuePlanning.tsx";
export function BatchWorkflow({
  issues,
  busy,
  act,
}: {
  issues: Issue[];
  busy: boolean;
  act: WorkflowAction;
}) {
  const [results, setResults] = useState<
    {
      id: string;
      error?: string;
      skipped?: string;
      created?: string[];
      reused?: string[];
    }[]
  >([]);
  const run = async (path: string, data: unknown) => {
    const response = await act(path, data, "已逐项处理，请检查下面的结果");
    if (response && typeof response === "object" && "results" in response)
      setResults((response as { results: typeof results }).results);
  };
  const ready = issues.filter(
    (i) => i.orchestration?.draft && i.processingSuggestion?.status === "plan",
  );
  return (
    <section aria-label="批量处理建议">
      <div className="mw-workflow-actions">
        <button
          disabled={busy || !issues.length}
          onClick={() =>
            void run("/workflow/analyze", { issueIds: issues.map((i) => i.id) })
          }
        >
          分析所选事项
        </button>
        <button
          disabled={busy || !ready.length}
          onClick={() =>
            void run("/workflow/start-batch", {
              items: ready.map((i) => ({
                issueId: i.id,
                inputKey: i.orchestration!.draft!.inputKey,
                expectedVersion: i.processing?.version,
                plan: { ...i.orchestration!.draft, decision: "accepted" },
              })),
            })
          }
        >
          按建议开始处理 · {ready.length} 项
        </button>
      </div>
      {issues.length > 0 && (
        <details open>
          <summary>逐项建议与范围 · {issues.length} 项</summary>
          {issues.map((i) => (
            <article className="mw-stage-event" key={i.id}>
              <strong>
                #{i.number} {i.title}
              </strong>
              <p>
                {i.orchestration?.draft?.goal ||
                  i.processing?.reason ||
                  "尚未分析"}
              </p>
              {i.orchestration?.draft && (
                <>
                  <p>
                    范围：{i.orchestration.draft.scope || "待明确"} · 路线：
                    {i.orchestration.draft.route === "answer"
                      ? "准备答复"
                      : i.orchestration.draft.route === "track"
                        ? "跟踪已有工作"
                        : kindNames[i.orchestration.draft.route]}
                  </p>
                  <ul>
                    {i.orchestration.draft.acceptanceCriteria.map((s, n) => (
                      <li key={n}>{s}</li>
                    ))}
                  </ul>
                  {i.orchestration.draft.missingInfo.length > 0 && (
                    <p className="mw-callout amber">
                      缺口：{i.orchestration.draft.missingInfo.join("；")}
                    </p>
                  )}
                </>
              )}
            </article>
          ))}
        </details>
      )}
      {results.map((r, n) => (
        <p key={`${r.id}:${n}`} role={r.error ? "alert" : undefined}>
          {issues.find((i) => i.id === r.id)?.title ?? r.id}：
          {r.error ||
            r.skipped ||
            `新建 ${r.created?.length ?? 0}，复用 ${r.reused?.length ?? 0}`}
        </p>
      ))}
    </section>
  );
}
