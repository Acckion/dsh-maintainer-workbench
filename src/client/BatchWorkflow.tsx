import {GapSummary} from './GapSummary.tsx';
import { kindNames } from "../core/types.ts";
import type { Issue } from "../core/types.ts";
export const batchReady = (issues:Issue[]) => issues.filter(i => i.orchestration?.draft && !i.orchestration.run && ["fix", "docs", "investigate", "review"].includes(i.orchestration.draft.route) && i.orchestrationView?.status === "plan");
export type BatchResult = {id:string;error?:string;skipped?:string;created?:string[];reused?:string[]};
export function BatchWorkflow({issues,report=[]}:{issues:Issue[];report?:BatchResult[]}) {
  return (
    <section aria-label="批量处理建议">
      {issues.length > 0 && (
        <details>
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
                  <GapSummary plan={i.orchestration.draft} />
                </>
              )}
            </article>
          ))}
        </details>
      )}
      {report.map((r, n) => (
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
