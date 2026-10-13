import { useState } from "react";
import { kindNames, type Job } from "../core/types.ts";
import type { ProcessingTimeline } from "../domain/timeline.ts";
import { eventDescription } from "../workflow/presentation.ts";
import { taskStatus } from "./review-evidence.ts";
import { processingRecords } from "./processing-records.ts";

const when = (at: string) =>
  new Date(at).toLocaleString("zh-CN", { hour12: false });
const actors = {
  user: "维护者",
  agent: "Agent",
  system: "系统",
  github: "GitHub",
};

export function ProcessingRecords({
  timeline,
  jobs,
  openSession,
  openExecution,
}: {
  timeline: ProcessingTimeline;
  jobs: Job[];
  openSession?: (id: string) => void;
  openExecution: (job: Job) => void;
}) {
  const records = processingRecords(timeline, jobs);
  const runs = records.filter((record) => "job" in record);
  const [notice, setNotice] = useState<{ id: string; text: string }>();
  return (
    <details className="mw-processing-records">
      <summary>
        处理记录{runs.length > 0 && <span> · {runs.length} 次执行</span>}
      </summary>
      {!records.length && <p className="mw-muted">暂无处理记录。</p>}
      {timeline.eventTotal > timeline.events.length && (
        <p className="mw-muted">
          最近 {timeline.events.length} 条活动，共 {timeline.eventTotal} 条
        </p>
      )}
      <ol className="mw-processing-record-list">
        {records.map((record) => {
          if ("event" in record)
            return (
              <li
                className="mw-processing-record mw-processing-event"
                key={record.id}
              >
                <header>
                  <strong>{actors[record.event.source]}</strong>
                  <time dateTime={record.at}>{when(record.at)}</time>
                </header>
                <p>{eventDescription(record.event)}</p>
              </li>
            );
          const job = record.job;
          const path = job.worktree ?? job.analysisPath;
          const source = runs.find(
            (candidate) => candidate.job.id === job.sourceJobId,
          )?.job;
          return (
            <li
              className="mw-processing-record mw-processing-run"
              key={record.id}
              data-run-id={job.id}
            >
              <header>
                <strong>
                  {kindNames[job.kind]} · 第 {record.attempt} 次
                </strong>
                <span className="mw-tag">{taskStatus(job).label}</span>
                <time dateTime={record.at}>{when(record.at)}</time>
              </header>
              <div className="mw-processing-record-actions">
                <button
                  type="button"
                  className="mw-text-button"
                  onClick={() => openExecution(job)}
                >
                  执行详情
                </button>
                {job.sessionId && openSession && (
                  <button
                    type="button"
                    className="mw-text-button"
                    onClick={() => openSession(job.sessionId!)}
                  >
                    打开会话
                  </button>
                )}
                {source && (
                  <button
                    type="button"
                    className="mw-text-button"
                    onClick={() => openExecution(source)}
                  >
                    来源：{kindNames[source.kind]}
                  </button>
                )}
              </div>
              {path && (
                <div className="mw-processing-record-path">
                  <span>{job.worktree ? "工作区" : "分析产物"}</span>
                  <code>{path}</code>
                  <button
                    type="button"
                    className="mw-text-button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(path);
                        setNotice({ id: record.id, text: "路径已复制" });
                      } catch {
                        setNotice({
                          id: record.id,
                          text: "复制失败，请选取路径复制",
                        });
                      }
                    }}
                  >
                    复制路径
                  </button>
                </div>
              )}
              {job.branch && (
                <p className="mw-processing-record-branch">
                  分支 <code>{job.branch}</code>
                </p>
              )}
              {job.sessionId && !openSession && (
                <p className="mw-processing-record-branch">
                  会话 <code>{job.sessionId}</code>
                </p>
              )}
              {notice?.id === record.id && (
                <p role="status" className="mw-muted">
                  {notice.text}
                </p>
              )}
              {!!record.events.length && (
                <ol
                  className="mw-processing-run-events"
                  aria-label="执行状态变化"
                >
                  {record.events.map((event) => (
                    <li key={event.id}>
                      <time dateTime={event.occurredAt || event.receivedAt}>
                        {when(event.occurredAt || event.receivedAt)}
                      </time>
                      <span>{eventDescription(event)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
