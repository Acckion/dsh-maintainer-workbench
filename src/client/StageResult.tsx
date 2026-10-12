import {GapSummary} from './GapSummary.tsx';
import type { Job } from "../core/types.ts";
import { TestExecutionLink } from "./ExecutionEvidence.tsx";
import type { DetailTab } from "./ReviewSummary.tsx";

/** Only the selected attempt's artifact is rendered; evidence from other stages stays on their nodes. */
export function StageResult({
  job,
  open,
  openLocation,
}: {
  job: Job;
  open?: (id: string, tab: DetailTab) => void;
  openLocation?: (path: string, line?: number) => void;
}) {
  const artifact = job.artifact;
  const groups: [string, string[]][] = [];
  if (artifact && "risks" in artifact) groups.push(["风险", artifact.risks]);
  if (artifact && "facts" in artifact)
    groups.push(["已核实事实", artifact.facts]);
  if (artifact && "hypotheses" in artifact)
    groups.push(["待核实假设", artifact.hypotheses]);
  if (artifact && "blockers" in artifact)
    groups.push(["待补足的证据", artifact.blockers]);
  if (artifact && "changes" in artifact)
    groups.push(["本次变更", artifact.changes]);
  if (artifact && "proposedChanges" in artifact)
    groups.push(["建议变更", artifact.proposedChanges]);
  if (artifact && "acceptanceCriteria" in artifact)
    groups.push(["验收条件", artifact.acceptanceCriteria]);
  if (artifact && "limitations" in artifact)
    groups.push(["未验证范围", artifact.limitations]);

  if (!artifact && job.result)
    groups.push([
      job.issueSnapshot.type === "pr" ? "审查覆盖缺口" : "信息缺口",
      job.result.missingInfo,
    ]);
  const tests =
    artifact && "tests" in artifact
      ? artifact.tests
      : (job.result?.tests ?? []);
  return (
    <section className="mw-stage-result">
      {artifact && <GapSummary plan={{gaps:artifact.gaps,missingInfo:artifact.stage==="triage"?artifact.missingInfo:[]}} />}
      <p className="mw-stage-summary">
        {artifact?.summary ?? job.result?.summary ?? "暂无保存结果"}
      </p>
      {artifact && (
        <p className="mw-muted">
          覆盖范围：{artifact.coverage || "未说明，需继续核对"}
        </p>
      )}
      {artifact?.stage === "preflight" && (
        <>
          <p>变更意图：{artifact.intent}</p>
          <p>
            预检结果：
            {
              {
                draft: "Draft，需核对暂缓条件",
                review: "可以继续深入审查",
                blocked: "预检存在阻塞",
              }[artifact.readiness]
            }
          </p>
        </>
      )}
      {artifact?.stage === "triage" && (
        <>
          <p>
            影响范围：{artifact.module} · {artifact.impact}
          </p>
          <p>{artifact.routeReason}</p>
        </>
      )}
      {artifact?.stage === "investigate" && (
        <dl className="mw-stage-facts">
          <dt>复现情况</dt>
          <dd>{artifact.reproduction || "尚未确认"}</dd>
          <dt>根因判断</dt>
          <dd>{artifact.rootCause || "尚未确认"}</dd>
          <dt>影响范围</dt>
          <dd>{artifact.impact || "尚未确认"}</dd>
        </dl>
      )}
      {artifact?.stage === "validate" && (
        <p>验证环境：{artifact.environment}</p>
      )}
      {artifact?.stage === "review" &&
        artifact.findings.map((f) => (
          <article className="mw-finding" key={f.id}>
            <strong>
              {f.severity} · {f.title}
            </strong>
            <button
              className="mw-text-button"
              disabled={!openLocation}
              onClick={() => openLocation?.(f.path, f.line ?? undefined)}
            >
              {f.path}
              {f.line ? `:${f.line}` : ""}
            </button>
            <p>触发条件：{f.trigger}</p>
            <p>依据：{f.evidence}</p>
            <p>建议：{f.recommendation}</p>
            {f.reproduction && (
              <details>
                <summary>
                  复现依据 ·{" "}
                  {f.reproduction.basis === "executed" ? "已执行" : "源码推理"}
                </summary>
                <p>输入：{f.reproduction.input}</p>
                <p>预期：{f.reproduction.expected}</p>
                <p>实际：{f.reproduction.actual}</p>
              </details>
            )}
            <small>
              处置：
              {(
                {
                  accepted: "已接受，等待修订",
                  needs_evidence: "需要更多证据",
                  dismissed: "不适用",
                  resolved: "维护者标记已解决",
                } as Record<string, string>
              )[job.findingDecisions?.[f.id] ?? ""] ?? "尚未决定"}
            </small>
          </article>
        ))}
      {groups
        .filter(([, items]) => items.length)
        .map(([label, items]) => (
          <section key={label}>
            <h4>{label}</h4>
            <ul>
              {items.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          </section>
        ))}
      {tests.length > 0 && (
        <section>
          <details open={artifact?.stage === "validate"}>
            <summary>本阶段验证记录 · {tests.length} 项</summary>
            {tests.map((test, index) => (
              <div className="mw-test" key={index}>
                <strong>
                  {
                    { passed: "通过", failed: "失败", not_run: "未执行" }[
                      test.status
                    ]
                  }
                </strong>
                <code>{test.command}</code>
                <pre>{test.output || "未保存输出"}</pre>
                <TestExecutionLink job={job} test={test} />
              </div>
            ))}
          </details>
        </section>
      )}
      {job.patch && open && (
        <button className="mw-text-button" onClick={() => open(job.id, "diff")}>
          查看本次补丁
        </button>
      )}
      {(artifact?.responseDraft || job.result?.responseDraft) && (
        <details>
          <summary>答复草稿</summary>
          <p className="mw-publish-preview">
            {artifact?.responseDraft ?? job.result?.responseDraft}
          </p>
        </details>
      )}
      {!!job.result?.evidence.length && (
        <details>
          <summary>分析依据 · {job.result?.evidence.length ?? 0}</summary>
          {job.result?.evidence.map((e, index) => (
            <article key={index}>
              <strong>{e.source}</strong>
              <p>{e.detail}</p>
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
