import type { ReactNode } from "react";
import { Loader2, Clock3, CircleAlert } from "lucide-react";
import type { Audit, Issue, Job } from "../core/types.ts";

export function StageProgress({
  job,
  issue,
  audit,
  readOnly,
  input,
  openSession,
}: {
  job?: Job;
  issue: Issue;
  audit: Audit[];
  readOnly: boolean;
  input?: ReactNode;
  openSession?: (id: string) => void;
}) {
  if (!job)
    return (
      <section className="mw-stage-progress">
        <p>暂无执行任务。</p>
        {input}
      </section>
    );
  const waits = readOnly
    ? []
    : (issue.processing?.waits.filter(
        (w) =>
          w.state === "open" &&
          (!w.requestedByRunId || w.requestedByRunId === job.id),
      ) ?? []);
  const userInput = waits.some((w) => w.type === "user_input");
  const permission = waits.find((w) => w.type === "host_permission");
  const environment = waits.find((w) => w.type === "environment_ready");
  const failure = job.status === "failed";
  const waiting =
    userInput ||
    !!permission ||
    !!environment ||
    ["waiting_input", "waiting_environment"].includes(job.status);
  const latest = audit
    .filter((a) => a.jobId === job.id && a.action === "job.progress")
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  const detail =
    latest?.detail && !latest.detail.includes("已创建 Harness Session")
      ? latest.detail
      : "等待新的执行信息";
  const title = failure
    ? "本次执行失败"
    : userInput
      ? "需要你补充信息"
      : permission
        ? "需要你授权工具执行"
        : environment
          ? "等待执行环境"
          : waiting
            ? "任务已暂停"
            : job.status === "queued"
              ? "等待执行"
              : job.status === "cancelled"
                ? "任务已停止"
                : job.status === "running"
                  ? "正在处理"
                  : "执行已结束";
  const Icon =
    failure || waiting
      ? CircleAlert
      : job.status === "running"
        ? Loader2
        : Clock3;
  return (
    <section
      className={`mw-stage-progress ${failure ? "failed" : ""}`}
      aria-label="处理进度"
    >
      <div className="mw-stage-progress-heading">
        <Icon
          size={18}
          className={
            job.status === "running" && !waiting ? "mw-spin" : undefined
          }
        />
        <h4>{title}</h4>
      </div>
      {userInput ? (
        input
      ) : (
        <p role={failure ? "alert" : "status"}>
          {failure
            ? job.error || "未保存具体失败原因，请查看执行详情。"
            : (permission?.reason ??
              environment?.reason ??
              job.waitingReason ??
              (job.status === "running"
                ? detail
                : job.status === "queued"
                  ? "任务已加入队列，等待开始。"
                  : job.status === "cancelled"
                    ? "已有记录保留，可在执行详情中查看。"
                    : (job.result?.summary ??
                      "未保存阶段结论，请查看执行详情。")))}
        </p>
      )}
      {!waiting && job.status === "running" && (
        <p className="mw-stage-progress-hint">
          {readOnly
            ? "这是该次运行保存的进度。"
            : "当前无需操作，完成后会在此显示结果。"}
        </p>
      )}
      {waiting && !userInput && !permission && !environment && (
        <p className="mw-stage-progress-hint">
          请核对暂停原因，再通过可用操作继续任务。
        </p>
      )}
      <div className="mw-stage-progress-footer">
        {job.sessionId &&
          openSession &&
          (permission || job.status === "running") && (
            <button
              className="mw-button primary"
              onClick={() => openSession(job.sessionId!)}
            >
              {permission
                ? "前往授权"
                : readOnly
                  ? "查看执行会话"
                  : "查看实时执行"}
            </button>
          )}
        {permission && (!job.sessionId || !openSession) && (
          <p className="mw-stage-progress-hint">请在对应宿主会话中完成授权。</p>
        )}
        <small>
          最近更新{" "}
          <time dateTime={latest?.at ?? job.updatedAt}>
            {new Date(latest?.at ?? job.updatedAt).toLocaleString("zh-CN", {
              hour12: false,
            })}
          </time>
        </small>
      </div>
      {failure && (job.result || job.patch || job.rawOutput) && (
        <p className="mw-stage-progress-hint">
          已有产物和执行记录保留，可在执行详情中核对。
        </p>
      )}
      {job.evidenceGate && !job.evidenceGate.allowed && (
        <p className="mw-stage-progress-hint">
          证据待补齐：{job.evidenceGate.reasons.join("；")}
        </p>
      )}
      {!userInput && input}
    </section>
  );
}
