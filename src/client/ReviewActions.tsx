import {PostReviewActions} from './PostReviewActions.tsx';
import {
  ArrowDownToLine,
  CheckCheck,
  GitPullRequest,
  RefreshCw,
  Square,
} from "lucide-react";
import type { PublishAction } from "../core/publish.ts";
import type { Issue, Job } from "../core/types.ts";
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
  issue,
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
  issue?: Issue;
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
  const prReview=job?.artifact?.stage==='review'&&job.issueSnapshot.type==='pr';
  const commentPublished=job?.publications?.comment?.status==='published';
  const acceptance = job ? acceptanceEligibility(job, jobs, issue?.processing) : undefined;
  return (
    job && (
      <div className="mw-review-bar">
        <h4>{['awaiting_review','completed'].includes(job.status)?'审核报告':job.status==='approved'?(prReview?(commentPublished?'PR 审查结论已发布':'下一步：发布审查结论'):'报告已接受 · 交付操作'):'任务操作'}</h4>
        {["awaiting_review", "completed"].includes(job.status) ? (
          <>
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
            <label>
              审核备注
              <input
                placeholder="可选：接受或退回的理由"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
              />
            </label>
            {(job.artifactState==='stale'||acceptance?.reason)&&<p role="status" className="mw-callout amber">{job.artifactState==='stale'?'报告对应的输入版本已变化，请重新核对后再接受。':acceptance?.reason}</p>}
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
              ? "重新整理报告"
              : "重新执行"}
          </button>
        ) : (
          <Tag tone={taskStatus(job).tone}>
            <CheckCheck size={14} /> {taskStatus(job).label}
          </Tag>
        )}
        {job.status === "approved" && job.artifactState !== "stale" && !(prReview&&commentPublished) && (
          <div className="mw-publish-actions">
            <button
              className="mw-button primary"
              onClick={() => void openPublishPreview("comment")}
              disabled={busy}
            >
              {prReview?(commentPublished?'核对已发布的评论':'发布结论到 PR 评论'):'发布回复'}
            </button>

          </div>
        )}
        {job.status==='approved'&&job.artifactState!=='stale'&&<>            {job.patch && ["fix", "docs"].includes(job.kind) && (
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
            )}</>}
        {prReview&&job.status==='approved'&&!commentPublished&&<p className="mw-muted">报告已在本地接受。点击“发布结论到 PR 评论”，贡献者才能在 GitHub 看到本次结论。</p>}
        {prReview&&commentPublished&&<PostReviewActions job={job} issue={issue} jobs={jobs} native={native} busy={busy} action={action}/>}
        <details className="mw-review-secondary"><summary>其他操作</summary>        {!["queued", "running"].includes(job.status) && (
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
{job.status==='approved'&&job.artifactState!=='stale'&&<>            <button
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
</>}</details>
        {job.publications &&
          Object.entries(job.publications).map(([key, receipt]) => (
            <div className="mw-publication" key={key}>
              {({comment:"PR 评论",review:"审查意见",labels:"标签",pr:"草稿 PR",update_pr:"PR 更新"} as Record<string,string>)[key]??key} ·{" "}
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
