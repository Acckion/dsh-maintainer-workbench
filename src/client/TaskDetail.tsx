import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  CheckCheck,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  RefreshCw,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import React from "react";
import type { PublishAction } from "../core/publish.ts";
import type { Analysis, Issue, Job, JobKind, Snapshot } from "../core/types.ts";
import { API } from "./api.ts";
import { ExecutionEvidence } from "./ExecutionEvidence.tsx";
import { type NavigationOrigin } from "./navigation-origin.ts";
import { date, type Page } from "./presentation.ts";
import { Empty, Tag } from "./Primitives.tsx";
import { Result } from "./Result.tsx";
import {
  acceptanceEligibility,
  executionExplanation,
  taskStatus,
} from "./review-evidence.ts";
import {
  AcceptArtifactButton,
  ReviewSummary,
  type DetailTab,
} from "./ReviewSummary.tsx";
import { WorkflowPanel } from "./WorkflowPanel.tsx";
interface TaskDetailProps {
  composed?: boolean;
  displayedIssue: Issue | undefined;
  job: Job | undefined;
  jobs: Job[];
  reviewNote: string;
  setReviewNote: React.Dispatch<React.SetStateAction<string>>;
  busy: string;
  action: (
    label: string,
    path: string,
    data: unknown,
    success?: string,
  ) => Promise<unknown>;
  state: Snapshot | undefined;
  openPublishPreview: (publishKind: PublishAction) => Promise<void>;
  openSession: ((id: string) => void) | undefined;
  originRef: React.MutableRefObject<NavigationOrigin | undefined>;
  returnToOrigin: () => void;
  setDetailOpen: React.Dispatch<React.SetStateAction<boolean>>;
  navigationGeneration: React.MutableRefObject<number>;
  setFocused: React.Dispatch<React.SetStateAction<string | undefined>>;
  setJobFocus: React.Dispatch<React.SetStateAction<string | undefined>>;
  page: Page;
  enqueue: (kind: JobKind, ids?: string[], forceNew?: boolean) => Promise<void>;
  detailTab: string;
  setDetailTab: React.Dispatch<React.SetStateAction<string>>;
  issues: Issue[];
  openEvidenceJob: (id: string, tab: DetailTab) => void;
  result: Analysis | undefined;
}
export function TaskDetail(props: TaskDetailProps) {
  const {
    displayedIssue,
    job,
    jobs,
    reviewNote,
    setReviewNote,
    busy,
    action,
    state,
    openPublishPreview,
    openSession,
    originRef,
    returnToOrigin,
    setDetailOpen,
    navigationGeneration,
    setFocused,
    setJobFocus,
    page,
    enqueue,
    detailTab,
    setDetailTab,
    issues,
    openEvidenceJob,
    result,
  } = props;
  const assistantMode = props.composed ?? false;

  if (!displayedIssue) return null;
  const acceptance = job ? acceptanceEligibility(job, jobs) : undefined;
  const reviewActions = job && (
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
              busy={!!busy}
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
              disabled={!!busy}
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
          disabled={!!busy}
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
          disabled={!!busy}
          onClick={() =>
            void action("retry", "/retry", { id: job.id }, "已创建重试任务")
          }
        >
          <RefreshCw size={14} />
          {executionExplanation(job, !!state?.capabilities.harness, [])
            .formatRetry
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
          disabled={!!busy}
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
            disabled={!!busy}
          >
            发布回复
          </button>
          <button
            className="mw-button"
            onClick={() => void openPublishPreview("labels")}
            disabled={!!busy}
          >
            应用标签
          </button>
          {job.artifact?.stage === "review" && job.prContext && (
            <button
              className="mw-button"
              disabled={!!busy}
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
              disabled={!!busy}
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
  );
  return (
    <aside
      id="mw-detail"
      tabIndex={-1}
      className={`mw-detail${assistantMode ? " mw-assistant-detail" : ""}`}
    >
      <div className="mw-detail-header">
        <span>
          {displayedIssue.origin === "repository"
            ? "仓库整理"
            : `${displayedIssue.type === "pr" ? "PULL REQUEST" : "ISSUE"} #${displayedIssue.number}`}{" "}
        </span>
        <div>
          {originRef.current && (
            <button aria-label="返回来源列表" onClick={returnToOrigin}>
              返回列表
            </button>
          )}
          {displayedIssue.url && (
            <a
              href={displayedIssue.url}
              target="_blank"
              rel="noreferrer"
              aria-label="在 GitHub 打开"
            >
              <ExternalLink size={15} />
            </a>
          )}
          <button aria-label="打开完整详情" onClick={() => setDetailOpen(true)}>
            <BookOpen size={17} />
          </button>
          <button
            aria-label="关闭详情"
            onClick={() => {
              if (originRef.current) {
                returnToOrigin();
                return;
              }
              navigationGeneration.current += 1;
              setFocused(undefined);
              setJobFocus(undefined);
            }}
          >
            <X size={17} />
          </button>
        </div>
      </div>
      <h2>{displayedIssue.title}</h2>
      <div className="mw-detail-meta">
        <span className="mw-avatar small">
          {displayedIssue.author[0]?.toUpperCase()}
        </span>
        {displayedIssue.author}
        <span>·</span>
        {date(displayedIssue.updatedAt)}
      </div>
      {page === "inbox" && (
        <div className="mw-detail-actions">
          <button
            className="mw-button primary"
            disabled={!!busy}
            onClick={() =>
              void enqueue(
                displayedIssue.type === "pr" ? "preflight" : "triage",
                [displayedIssue.id],
              )
            }
          >
            <Sparkles size={14} />
            {displayedIssue.type === "pr" ? "变更预检" : "快速分诊"}
          </button>
          <button
            className="mw-button"
            disabled={!!busy}
            onClick={() =>
              void enqueue(
                displayedIssue.type === "pr" ? "review" : "investigate",
                [displayedIssue.id],
              )
            }
          >
            {displayedIssue.type === "pr" ? "审查 PR" : "深入调查"}
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="mw-tabs mw-detail-tabs">
        {[
          ["overview", "概览"],
          ["evidence", "证据"],
          ["diff", "差异"],
          ["log", "执行记录"],
        ].map(([key, name]) => (
          <button
            className={detailTab === key ? "active" : ""}
            key={key}
            onClick={() => setDetailTab(key)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="mw-detail-scroll">
        {detailTab === "overview" && (
          <>
            {job && (
              <ReviewSummary
                job={job}
                jobs={jobs}
                issue={
                  issues.find((i) => i.id === displayedIssue.id) ??
                  displayedIssue
                }
                deliveryActions={reviewActions}
                audit={state?.audit ?? []}
                native={!!state?.capabilities.harness}
                open={openEvidenceJob}
                openSession={openSession}
              />
            )}
            <details open={!assistantMode}>
              <summary>后续操作与远端进度</summary>
              <WorkflowPanel
                hideSummary={!!job}
                key={displayedIssue.id}
                issue={
                  issues.find((i) => i.id === displayedIssue.id) ??
                  displayedIssue
                }
                job={job}
                history={jobs.filter((j) => j.issueId === displayedIssue.id)}
                busy={!!busy}
                act={(path, data, message) =>
                  action("workflow", path, data, message)
                }
              />
            </details>
            {job?.error && (
              <div className="mw-callout red">
                <TriangleAlert size={17} />
                <p>{job.error}</p>
              </div>
            )}
            {job?.rawOutput && !job.result && (
              <details className="mw-original">
                <summary>查看模型原始输出（未通过结果校验）</summary>
                <p>{job.rawOutput}</p>
              </details>
            )}
            {result && (!assistantMode || !job?.artifact) ? (
              <Result
                result={result}
                summary={!job?.artifact}
                classification={
                  !job?.artifact || job.artifact.stage === "triage"
                }
              />
            ) : !result ? (
              <>
                <div className="mw-section-title">
                  <BookOpen size={15} /> 问题描述
                </div>
                <p className="mw-description">
                  {displayedIssue.origin === "repository"
                    ? "按选定范围检查仓库或准备修改，结果与补丁将在这里显示。"
                    : displayedIssue.body || "未提供描述"}
                </p>
                <div className="mw-callout">
                  <Sparkles size={17} />
                  <p>
                    {displayedIssue.origin === "repository"
                      ? "任务结束后可查看整理结果、证据与补丁。"
                      : "派发分诊后，可获得分类、优先级、重复问题建议与下一步操作。"}
                  </p>
                </div>
              </>
            ) : null}
            {result && (
              <details className="mw-original">
                <summary>查看原始报告</summary>
                <p>
                  {displayedIssue.origin === "repository"
                    ? "仓库整理任务：按选定范围检查或准备修改，结果与补丁将在这里显示。"
                    : displayedIssue.body}
                </p>
              </details>
            )}
          </>
        )}
        {detailTab === "evidence" && (
          <>
            {job?.toolDiagnostics && (
              <div className="mw-evidence">
                <div>
                  <h4>工具可用性诊断</h4>
                  <p>
                    {job.toolDiagnostics.provider}/{job.toolDiagnostics.model} ·{" "}
                    {job.toolDiagnostics.preset} ·{" "}
                    {job.toolDiagnostics.permission}
                  </p>
                  <p>
                    挂载：
                    {job.toolDiagnostics.mountedTools.join(", ") || "无"}
                    ；模型请求：{job.toolDiagnostics.requests.length} 次；调用：
                    {job.toolDiagnostics.calls}；结果：
                    {job.toolDiagnostics.results}；宿主结果：
                    {job.toolDiagnostics.canonicalResults}；错误：
                    {job.toolDiagnostics.errors}
                  </p>
                  <p>
                    请求携带工具：
                    {[
                      ...new Set(
                        job.toolDiagnostics.requests.flatMap((r) => r.tools),
                      ),
                    ].join(", ") || "无"}
                  </p>
                </div>
              </div>
            )}
            {job?.toolDiagnostics?.implementationRepair && (
              <p className="mw-callout">
                已尝试补齐实施{" "}
                {job.toolDiagnostics.implementationRepair.attempts} 次：
                {job.toolDiagnostics.implementationRepair.reason}
              </p>
            )}
            {job?.toolDiagnostics?.evidenceRepair && (
              <p className="mw-callout">
                已尝试补齐证据 {job.toolDiagnostics.evidenceRepair.attempts}{" "}
                次：{job.toolDiagnostics.evidenceRepair.reasons.join("；")}
              </p>
            )}
            {job?.evidenceGate && (
              <p
                className={`mw-callout ${job.evidenceGate.allowed ? "" : "red"}`}
              >
                证据验收：
                {job.evidenceGate.allowed
                  ? "通过"
                  : job.evidenceGate.reasons.join("；")}
              </p>
            )}
            {job?.executionRecords?.map((record) => (
              <ExecutionEvidence key={record.id} job={job} record={record} />
            ))}
            {result?.evidence.length ? (
              result.evidence.map((e, index) => (
                <div className="mw-evidence" key={index}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <h4>{e.source}</h4>
                    <p>{e.detail}</p>
                  </div>
                </div>
              ))
            ) : (
              <Empty
                title="尚无分析证据"
                text="完成调查后，证据与来源将在这里显示。"
              />
            )}
            {job && (
              <section className="mw-identity">
                <h4>执行身份</h4>
                <dl>
                  <dt>任务</dt>
                  <dd>{job.id}</dd>
                  <dt>代码基线</dt>
                  <dd>{job.baseSha}</dd>
                  <dt>输入版本</dt>
                  <dd>{job.revision.slice(0, 20)}</dd>
                  <dt>执行器</dt>
                  <dd>{job.engine ?? "等待执行"}</dd>
                  <dt>Session</dt>
                  <dd>{job.sessionId ?? "未创建"}</dd>
                  <dt>Token</dt>
                  <dd>{job.tokens ?? "未采集"}</dd>
                </dl>
              </section>
            )}
          </>
        )}
        {detailTab === "diff" &&
          (job?.patch ? (
            <>
              <div className="mw-section-title">
                <GitBranch size={14} />
                {job.branch}
              </div>
              <pre className="mw-diff">
                {job.patch.split("\n").map((l, i) => (
                  <div
                    className={
                      l.startsWith("+")
                        ? "add"
                        : l.startsWith("-")
                          ? "del"
                          : l.startsWith("@@")
                            ? "hunk"
                            : ""
                    }
                    key={i}
                  >
                    {l || " "}
                  </div>
                ))}
              </pre>
            </>
          ) : (
            <Empty
              title="没有代码差异"
              text="修复与文档任务会在独立 worktree 中生成可审核差异。"
            />
          ))}
        {detailTab === "log" && (
          <>
            {job ? (
              state?.audit
                .filter((a) => a.jobId === job.id)
                .slice()
                .reverse()
                .map((a) => (
                  <div className="mw-job-log" key={a.id}>
                    <time>{date(a.at)}</time>
                    <p>{a.detail}</p>
                  </div>
                ))
            ) : (
              <Empty title="尚未创建任务" text="派发后会记录每一步执行状态。" />
            )}
            {job?.worktree && (
              <div className="mw-path">工作区：{job.worktree}</div>
            )}
          </>
        )}
      </div>
      {detailTab !== "overview" && reviewActions}
    </aside>
  );
}
