import {
  ArrowDownToLine,
  CheckCheck,
  GitPullRequest,
  RefreshCw,
  Square,
} from "lucide-react";
import type { PublishAction } from "../core/publish.ts";
import type { Job } from "../core/types.ts";
import { API } from "./api.ts";
import { Tag } from "./Primitives.tsx";
import {
  acceptanceEligibility,
  executionExplanation,
  taskStatus,
} from "./review-evidence.ts";
import { AcceptArtifactButton } from "./ReviewSummary.tsx";
export function ReviewActions({
  job,
  jobs,
  native,
  busy,
  reviewNote,
  setReviewNote,
  action,
  openPublishPreview,
  openSession,
}: {
  job?: Job;
  jobs: Job[];
  native: boolean;
  busy: boolean;
  reviewNote: string;
  setReviewNote: (value: string) => void;
  action: (
    label: string,
    path: string,
    data: unknown,
    message?: string,
  ) => Promise<unknown>;
  openPublishPreview: (kind: PublishAction) => Promise<void>;
  openSession?: (id: string) => void;
}) {
  const acceptance = job ? acceptanceEligibility(job, jobs) : undefined;
  return (
    job && (
      <div className="mw-review-bar">
        {["awaiting_review", "completed"].includes(job.status) ? (
          <>
            <label>
              审核备注
              <input
                placeholder="可选：接受或退回的理由"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
              />
            </label>
            <div>
              <AcceptArtifactButton
                job={job}
                busy={busy}
                blockedReason={acceptance?.reason}
                accept={() =>
                  void action(
                    "approve",
                    "/review",
                    { id: job.id, decision: "approve", note: reviewNote },
                    "本地产物已接受，未执行外部发布",
                  )
                }
              />
              <button
                className="mw-button"
                disabled={busy}
                onClick={() =>
                  void action(
                    "reject",
                    "/review",
                    { id: job.id, decision: "reject", note: reviewNote },
                    "结果已退回",
                  )
                }
              >
                退回
              </button>
            </div>
            <p className="mw-muted">
              接受只保存本地决定，不代表测试通过，也不会自动发布。
            </p>
          </>
        ) : ["queued", "running"].includes(job.status) ? (
          <button
            className="mw-button"
            disabled={busy}
            onClick={() =>
              void action("cancel", "/cancel", { id: job.id }, "已请求停止任务")
            }
          >
            <Square size={13} />
            停止任务
          </button>
        ) : ["failed", "cancelled", "rejected"].includes(job.status) ? (
          <button
            className="mw-button"
            disabled={busy}
            onClick={() =>
              void action("retry", "/retry", { id: job.id }, "已创建重试任务")
            }
          >
            <RefreshCw size={14} />
            {executionExplanation(job, native, []).formatRetry
              ? "仅整理已保存输出"
              : "重新执行"}
          </button>
        ) : (
          <Tag tone={taskStatus(job).tone}>
            <CheckCheck size={14} /> {taskStatus(job).label}
          </Tag>
        )}
        {!["queued", "running"].includes(job.status) && (
          <button
            className="mw-button"
            disabled={busy}
            title="创建新的执行任务，沿用本任务来源和说明，保留旧结果；不会自动接受或发布"
            onClick={() =>
              void action(
                "rerun",
                "/rerun",
                { id: job.id },
                "已派发重新运行任务，请查看本次任务追踪",
              )
            }
          >
            <RefreshCw size={14} />
            重新运行
          </button>
        )}
        {job.status === "approved" && job.artifactState !== "stale" && (
          <div className="mw-publish-actions">
            <button
              className="mw-button"
              onClick={() => void openPublishPreview("comment")}
              disabled={busy}
            >
              发布回复
            </button>
            <button
              className="mw-button"
              onClick={() => void openPublishPreview("labels")}
              disabled={busy}
            >
              应用标签
            </button>
            {job.artifact?.stage === "review" && job.prContext && (
              <button
                className="mw-button"
                disabled={busy}
                onClick={() => void openPublishPreview("review")}
              >
                发布已采纳发现
              </button>
            )}
            {job.patch && ["fix", "docs"].includes(job.kind) && (
              <button
                className="mw-button primary"
                onClick={() =>
                  void openPublishPreview(
                    job.issueSnapshot.type === "pr" ? "update_pr" : "pr",
                  )
                }
                disabled={busy}
              >
                <GitPullRequest size={13} />
                {job.issueSnapshot.type === "pr" ? "更新原 PR" : "创建草稿 PR"}
              </button>
            )}
          </div>
        )}
        {job.publications &&
          Object.entries(job.publications).map(([key, receipt]) => (
            <div className="mw-publication" key={key}>
              {key} ·{" "}
              {receipt.status === "published"
                ? "已发布"
                : receipt.status === "failed"
                  ? "发布失败"
                  : "发布中 / 待核查"}
              {receipt.error && <p>{receipt.error}</p>}
              {receipt.urls.map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  查看 GitHub 结果 ↗
                </a>
              ))}
            </div>
          ))}
        <div className="mw-export-links">
          {job.sessionId && openSession && (
            <button
              className="mw-text-button"
              onClick={() => openSession(job.sessionId!)}
            >
              打开 Harness 会话 / 审批
            </button>
          )}
          <a href={`${API}/export/${job.id}`}>
            <ArrowDownToLine size={13} />
            导出结果
          </a>
          {job.patch && (
            <a href={`${API}/export/${job.id}?format=patch`}>下载补丁</a>
          )}
        </div>
      </div>
    )
  );
}
