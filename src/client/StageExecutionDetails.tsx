import type { ReactNode } from "react";
import type { Audit, Job } from "../core/types.ts";
import { ExecutionEvidence } from "./ExecutionEvidence.tsx";

export function StageExecutionDetails({
  job,
  audit,
  tools,
  openEvidence,
  openSession,
}: {
  job?: Job;
  audit: Audit[];
  tools: ReactNode;
  openEvidence: (id: string) => void;
  openSession?: (id: string) => void;
}) {
  if (!job) return <p>暂无执行记录。</p>;
  const logs = audit
    .filter((a) => a.jobId === job.id)
    .sort((a, b) => b.at.localeCompare(a.at));
  return (
    <section className="mw-stage-execution" aria-label="执行详情">
      <div className="mw-stage-execution-toolbar">
        <button className="mw-text-button" onClick={() => openEvidence(job.id)}>
          查看完整执行记录
        </button>
        {job.sessionId && openSession && (
          <button
            className="mw-text-button"
            onClick={() => openSession(job.sessionId!)}
          >
            打开执行会话
          </button>
        )}
      </div>
      <section className="mw-stage-log" aria-label="运行日志">
        <h4>运行日志</h4>
        {logs.length ? (
          logs.map((a) => (
            <div className="mw-job-log" key={a.id}>
              <time dateTime={a.at}>
                {new Date(a.at).toLocaleString("zh-CN", { hour12: false })}
              </time>
              <p>{a.detail}</p>
            </div>
          ))
        ) : (
          <p className="mw-muted">暂未收到运行日志。</p>
        )}
      </section>
      {!!job.executionRecords?.length && (
        <details>
          <summary>命令与验证记录 · {job.executionRecords.length}</summary>
          {job.executionRecords.map((record) => (
            <ExecutionEvidence key={record.id} job={job} record={record} />
          ))}
        </details>
      )}
      {!!job.result?.evidence.length && (
        <details>
          <summary>分析依据 · {job.result.evidence.length}</summary>
          {job.result.evidence.map((e, i) => (
            <article className="mw-evidence" key={i}>
              <strong>{e.source}</strong>
              <p>{e.detail}</p>
            </article>
          ))}
        </details>
      )}
      <details>
        <summary>来源与执行环境</summary>
        <dl className="mw-stage-facts">
          <dt>来源提交</dt>
          <dd>
            <code>{job.baseSha || "未保存"}</code>
          </dd>
          <dt>输入版本</dt>
          <dd>{job.revision}</dd>
          <dt>创建时间</dt>
          <dd>
            {new Date(job.createdAt).toLocaleString("zh-CN", { hour12: false })}
          </dd>
          <dt>产物状态</dt>
          <dd>
            {job.artifactState === "stale"
              ? "已过期，不能用于当前交付"
              : "请以阶段结论及审核状态为准"}
          </dd>
        </dl>
        {job.toolDiagnostics && (
          <>
            <p>
              {job.toolDiagnostics.provider}/{job.toolDiagnostics.model} ·{" "}
              {job.toolDiagnostics.preset} · {job.toolDiagnostics.permission}
            </p>
            <p>挂载工具：{job.toolDiagnostics.mountedTools.join(", ")}</p>
            <p>
              请求 {job.toolDiagnostics.requests.length} · 调用{" "}
              {job.toolDiagnostics.calls} · 宿主结果{" "}
              {job.toolDiagnostics.canonicalResults} · 错误{" "}
              {job.toolDiagnostics.errors}
            </p>
            <p>Token {job.tokens ?? "未采集"}</p>
          </>
        )}
      </details>
      {job.rawOutput && !job.result && (
        <details>
          <summary>未解析的原始输出</summary>
          <pre>{job.rawOutput}</pre>
        </details>
      )}
      {tools}
    </section>
  );
}
