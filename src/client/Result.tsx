import { Layers3, Sparkles } from "lucide-react";
import type { Analysis } from "../core/types.ts";
import { CopyDraft, Tag } from "./Primitives.tsx";
import { categoryNames } from "./presentation.ts";
export function Result({
  result,
  classification = true,
  summary = true,
}: {
  result: Analysis;
  classification?: boolean;
  summary?: boolean;
}) {
  return (
    <div className="mw-result">
      <div className="mw-section-title">
        <Sparkles size={15} /> {summary ? "分析结论" : "建议与回复"}{" "}
      </div>
      {summary && <p className="mw-summary">{result.summary}</p>}
      {classification && (
        <div className="mw-tags">
          <Tag
            tone={
              result.priority === "P0" || result.priority === "P1"
                ? "red"
                : "violet"
            }
          >
            {result.priority}
          </Tag>
          <Tag>{categoryNames[result.category]}</Tag>
          {result.labels.map((l) => (
            <Tag key={l}>{l}</Tag>
          ))}
        </div>
      )}
      {result.duplicateOf && (
        <div className="mw-callout amber">
          <Layers3 size={17} />
          <div>
            <strong>可能与 #{result.duplicateOf} 重复</strong>
            <p>{result.duplicateReason}</p>
          </div>
        </div>
      )}
      {result.missingInfo.length > 0 && (
        <section>
          <h4>还需要的信息</h4>
          <ul>
            {result.missingInfo.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      )}
      {result.nextSteps.length > 0 && (
        <section>
          <h4>建议下一步</h4>
          <ol>
            {result.nextSteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </section>
      )}
      {result.tests.length > 0 && (
        <section>
          <h4>
            测试记录 <span className="mw-muted">· Agent 报告，需核对日志</span>
          </h4>
          {result.tests.map((t, i) => (
            <div className="mw-test" key={i}>
              <Tag
                tone={
                  t.status === "passed"
                    ? "green"
                    : t.status === "failed"
                      ? "red"
                      : ""
                }
              >
                {t.status === "passed"
                  ? "报告通过"
                  : t.status === "failed"
                    ? "报告失败"
                    : "未执行"}
              </Tag>
              <code>{t.command}</code>
              <p>{t.output}</p>
            </div>
          ))}
        </section>
      )}
      <details className="mw-response-draft">
        <summary>
          回复草稿
          {result.responseDraft.trim() && (
            <span className="mw-muted"> · 草稿，尚未发布</span>
          )}
        </summary>
        {result.responseDraft.trim() ? (
          <>
            <div className="mw-draft">{result.responseDraft}</div>
            <CopyDraft text={result.responseDraft} />
          </>
        ) : (
          <p className="mw-muted">
            暂无需要向作者发布的内容，可继续处理下一阶段。
          </p>
        )}
      </details>
    </div>
  );
}
