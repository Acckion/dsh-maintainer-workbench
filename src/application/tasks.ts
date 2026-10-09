import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ServiceBase,
  type Enqueue,
  type ServiceDependencies,
} from "../application/service.ts";
import { lightweight, type FindingDecision } from "../core/artifacts.ts";
import { resolveDelivery, type DeliveryTarget } from "../core/delivery.ts";
import { documentAcceptance } from "../core/document-acceptance.ts";
import { collectPatch } from "../core/git.ts";
import { assertReviewEvidence } from "../core/review-evidence.ts";
import { revision } from "../core/revision.ts";
import {
  kinds,
  type Issue,
  type Job,
  type JobKind,
  type Repo,
} from "../core/types.ts";
import { validationAcceptance } from "../core/validation-acceptance.ts";
import { validationInstructions } from "../core/validation-context.ts";
import { stageBlocker } from "../workflow/actions.ts";
const settingsSchema = z.object({
  syncLimit: z.number().int().min(0).max(1000000).default(1000),
  autoPreflight: z.boolean().default(false),
  triageMaxTokens: z.number().int().min(500).max(8000).default(1800),
  concurrency: z.number().int().min(1).max(4),
  maxJobsPerBatch: z.number().int().min(1).max(50),
  timeoutMs: z.number().int().min(1000).max(1800000),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  maxTokens: z.number().int().min(500).max(32000),
  agentPreset: z.string().min(1).max(100),
  permissionPreset: z.string().min(1).max(100),
  syncIntervalMinutes: z.number().int().min(0).max(1440),
  autoTriage: z.boolean(),
});

export class TaskService extends ServiceBase {
  constructor(
    deps: ServiceDependencies,
    private hooks: {
      active: Map<string, AbortController>;
      pump: () => void;
      enqueue: Enqueue;
    },
  ) {
    super(deps);
  }
  private get active() {
    return this.hooks.active;
  }
  private pump() {
    this.hooks.pump();
  }
  enqueue(
    issueIds: string[],
    kind: JobKind,
    options: {
      sourceJobId?: string;
      instructions?: string;
      forceNew?: boolean;
      goal?: "resolve";
      goalId?: string;
      resumeInput?: boolean;
    } = {},
  ): { created: string[]; reused: string[] } {
    z.enum(kinds).parse(kind);
    const ids = [
      ...new Set(
        z
          .array(z.string())
          .min(1)
          .max(this.store.settings().maxJobsPerBatch)
          .parse(issueIds),
      ),
    ];
    const candidates = ids.map((id) => {
      const issue = this.store.get<Issue>("issues", id);
      if (!issue) throw new Error(`Issue 不存在：${id}`);
      const repo = this.repo(issue.repoId);
      if (
        !lightweight(kind) &&
        repo.mode === "local" &&
        !repo.headSha &&
        !(issue.organizeMode === "audit" && kind === "investigate")
      )
        throw new Error("无 Git 提交的目录当前仅支持只读仓库检查");
      if (
        !lightweight(kind) &&
        repo.mode === "local" &&
        repo.dirty &&
        !(issue.organizeMode === "audit" && kind === "investigate")
      )
        throw new Error(
          "当前工作区有未提交修改；隔离修改任务需先提交，只读检查仍可使用",
        );
      if (
        (["preflight", "ci"].includes(kind) ||
          (kind === "review" && !options.sourceJobId)) &&
        issue.type !== "pr"
      )
        throw new Error("PR 审查只能选择 Pull Request");
      if (kind === "triage" && issue.type === "pr")
        throw new Error("PR 请使用变更预检，不执行 Issue 分诊");
      if (issue.state === "closed") throw new Error("已关闭记录不可派发任务");
      if ((kind === "fix" || kind === "docs") && !this.nativeRunner)
        throw new Error(
          "修复与文档编辑需要在 Harness 中运行；工作区会自动准备",
        );
      const blocker = stageBlocker(
        issue,
        kind,
        options.sourceJobId ? this.job(options.sourceJobId) : undefined,
      );
      if (blocker) throw new Error(blocker);
      if (
        kind === "triage" &&
        issue.informationRequests?.some((r) => r.state === "asked")
      )
        throw new Error(
          "补充信息尚未收到新回复，请先核对或结束已有追问，避免重复分诊。",
        );
      return { issue, repo };
    });
    if (options.sourceJobId) {
      const source = this.job(options.sourceJobId);
      if (
        ids.length !== 1 ||
        source.issueId !== ids[0] ||
        (source.caseId &&
          source.caseId !== candidates[0].issue.processing?.id) ||
        !source.result ||
        ![
          "completed",
          "awaiting_review",
          "approved",
          ...(options.resumeInput ? ["waiting_input"] : []),
        ].includes(source.status)
      )
        throw new Error("交接来源必须是同一事项的已完成产物");
      if (
        source.revision !==
          revision(candidates[0].issue, candidates[0].repo, source.kind) &&
        !(
          source.kind === "review" &&
          ["review", "fix", "investigate", "ci"].includes(kind)
        )
      )
        throw new Error("来源产物已过期，请先重新分析");
    }
    if (kind === "validate")
      options = {
        ...options,
        instructions: validationInstructions(
          options.instructions,
          options.sourceJobId ? this.job(options.sourceJobId).kind : undefined,
        ),
      };
    const created: string[] = [],
      reused: string[] = [];
    this.store.transaction(() => {
      for (const { issue, repo } of candidates) {
        const rev = revision(issue, repo, kind);
        const prior = this.store
          .issueJobs(issue.id, kind, rev)
          .find(
            (j) =>
              (!j.caseId || j.caseId === issue.processing?.id) &&
              j.sourceJobId === options.sourceJobId &&
              (j.instructions ?? "") === (options.instructions ?? "") &&
              ![
                "failed",
                "cancelled",
                "rejected",
                "waiting_input",
                "waiting_environment",
              ].includes(j.status),
          );
        if (
          prior &&
          (!options.forceNew || ["queued", "running"].includes(prior.status))
        ) {
          if (options.goal && !prior.goal)
            this.saveJob({
              ...prior,
              goal: options.goal,
              goalId: options.goalId ?? prior.id,
            });
          reused.push(prior.id);
          this.store.audit(
            "job.deduplicated",
            `重复派发复用已有任务 #${issue.number}`,
            prior.id,
          );
          continue;
        }
        const now = new Date().toISOString();
        const handoff = this.store
          .jobs()
          .filter(
            (j) =>
              j.issueId === issue.id &&
              (!j.caseId || j.caseId === issue.processing?.id) &&
              j.result &&
              (j.revision === revision(issue, repo, j.kind) ||
                j.kind === "review" ||
                j.id === options.sourceJobId),
          )
          .slice(-8)
          .map((j) => ({
            stale: j.revision !== revision(issue, repo, j.kind),
            id: j.id,
            kind: j.kind,
            revision: j.revision,
            artifact: j.artifact,
            result: j.artifact ? undefined : j.result,
            feedback: j.reviewNote,
            followups: j.findingFollowups,
            findings: j.findingDecisions,
          }));
        if (
          options.sourceJobId &&
          !handoff.some((item) => item.id === options.sourceJobId)
        ) {
          const source = this.job(options.sourceJobId);
          if (handoff.length >= 8) handoff.shift();
          handoff.unshift({
            stale: source.revision !== revision(issue, repo, source.kind),
            id: source.id,
            kind: source.kind,
            revision: source.revision,
            artifact: source.artifact,
            result: source.artifact ? undefined : source.result,
            feedback: source.reviewNote,
            followups: source.findingFollowups,
            findings: source.findingDecisions,
          });
        }
        const id = randomUUID();
        const job: Job = {
          goal: options.goal,
          goalId: options.goal ? (options.goalId ?? id) : undefined,
          handoff,
          sourceJobId: options.sourceJobId,
          instructions: options.instructions?.slice(0, 8000),
          id,
          caseId: this.store.processing.current(issue.id)?.id,
          repoId: repo.id,
          issueId: issue.id,
          kind,
          status: "queued",
          revision: rev,
          baseSha: repo.headSha,
          issueSnapshot: structuredClone(issue),
          attempt:
            1 +
            Math.max(
              0,
              ...this.store
                .jobs()
                .filter(
                  (j) =>
                    j.issueId === issue.id &&
                    j.kind === kind &&
                    j.revision === rev,
                )
                .map((j) => j.attempt),
            ),
          createdAt: now,
          updatedAt: now,
        };
        this.store.put("jobs", job);
        this.store.audit(
          "job.queued",
          `${kind} · ${repo.fullName}#${issue.number}`,
          job.id,
        );
        created.push(job.id);
      }
    });
    if (this.autoStart) this.pump();
    return { created, reused };
  }
  cancel(id: string): void {
    const job = this.job(id);
    if (
      !["queued", "running", "waiting_input", "waiting_environment"].includes(
        job.status,
      )
    )
      throw new Error("只能取消排队或执行中的任务");
    // A waiting reason describes only an active Agent/approval wait.  Keep the
    // session, worktree and raw output for inspection, but never let a stale
    // progress message describe a cancelled task.
    this.saveJob({
      ...job,
      status: "cancelled",
      waitingReason: undefined,
      finishedAt: new Date().toISOString(),
    });
    this.active.get(id)?.abort(new Error("维护者取消了任务"));
    this.store.audit(
      "job.cancelled",
      "由维护者取消；已生成的 worktree 保留供检查",
      id,
    );
  }
  rerun(id: string): { created: string[]; reused: string[] } {
    const job = this.job(id);
    if (["queued", "running"].includes(job.status) || this.active.has(id))
      throw new Error("任务仍在执行，请结束后重新运行");
    const result = this.hooks.enqueue([job.issueId], job.kind, {
      sourceJobId: job.sourceJobId,
      instructions: job.instructions,
      goal: job.goal,
      goalId: job.goalId,
      forceNew: true,
    });
    for (const created of result.created)
      this.store.audit(
        "job.rerun",
        `重新运行 ${job.id}，保留原始记录`,
        created,
      );
    return result;
  }
  retry(id: string): { created: string[]; reused: string[] } {
    const job = this.job(id);
    if (!["failed", "cancelled", "rejected"].includes(job.status))
      throw new Error("当前状态不能重试");
    if (this.active.has(id)) throw new Error("任务仍在停止，请稍后重试");
    const current = this.store.get<Issue>("issues", job.issueId)!;
    if (revision(current, this.repo(job.repoId), job.kind) !== job.revision)
      throw new Error("输入版本已变化，请从收件箱重新派发");
    if (
      this.nativeRunner &&
      job.status === "failed" &&
      job.formatRecovery &&
      job.rawOutput &&
      !job.result &&
      (job.worktree || job.analysisPath)
    ) {
      const now = new Date().toISOString();
      const recovered: Job = {
        ...job,
        id: randomUUID(),
        formatOnly: true,
        status: "queued",
        attempt: job.attempt + 1,
        createdAt: now,
        updatedAt: now,
        startedAt: undefined,
        finishedAt: undefined,
        error: undefined,
        waitingReason: undefined,
        sessionId: undefined,
        publications: undefined,
      };
      this.store.put("jobs", recovered);
      this.store.audit(
        "job.format_retry",
        `仅整理 ${job.id} 的已保存输出，不重新实施`,
        recovered.id,
      );
      if (this.autoStart) this.pump();
      return { created: [recovered.id], reused: [] };
    }
    return this.hooks.enqueue([job.issueId], job.kind, {
      sourceJobId: job.sourceJobId,
      instructions: job.instructions,
      goal: job.goal,
      goalId: job.goalId,
    });
  }
  resume(id: string): { created: string[]; reused: string[] } {
    const job = this.job(id),
      state = this.store.processing.current(job.issueId);
    if (job.status === "waiting_environment") {
      if (!state || (job.caseId && job.caseId !== state.id))
        throw new Error("处理周期已变化，请重新派发");
      const waits = state.waits.filter(
        (w) => w.type === "environment_ready" && w.requestedByRunId === id,
      );
      if (!waits.length || waits.some((w) => w.state !== "satisfied"))
        throw new Error("请先准备仓库环境");
      return this.hooks.enqueue([job.issueId], job.kind, {
        sourceJobId: job.sourceJobId,
        forceNew: true,
        instructions: job.instructions,
        goal: job.goal,
        goalId: job.goalId,
      });
    }
    if (
      job.status !== "waiting_input" ||
      !state ||
      (job.caseId && job.caseId !== state.id)
    )
      throw new Error("此运行不在等待输入状态");
    if (this.active.has(id)) throw new Error("原运行仍在停止，请稍后继续");
    const waits = state.waits.filter(
      (w) => w.type === "user_input" && w.requestedByRunId === id,
    );
    if (!waits.length || waits.some((w) => w.state !== "satisfied"))
      throw new Error("请先回答此运行的所有输入请求");
    const ids = new Set(waits.map((w) => w.id));
    const responses = this.store.processing
      .inputs(state.id)
      .filter((input) => ids.has(input.waitId));
    return this.hooks.enqueue([job.issueId], job.kind, {
      sourceJobId: id,
      resumeInput: true,
      instructions:
        (job.instructions ?? "") +
        "\nMaintainer supplied input (use only within accepted scope):\n" +
        JSON.stringify(responses.map((r) => r.values)),
      goal: job.goal,
      goalId: job.goalId,
    });
  }
  async review(
    id: string,
    decision: "approve" | "reject",
    note: string,
  ): Promise<{ delivery?: DeliveryTarget; deliveryBlockedReason?: string }> {
    const job = this.job(id);
    if (!["awaiting_review", "completed"].includes(job.status))
      throw new Error("任务不在待审核状态");
    if (
      job.caseId &&
      job.caseId !== this.store.processing.current(job.issueId)?.id
    )
      throw new Error("处理周期已变化，旧结果不可批准");
    const original = JSON.stringify(job);
    if (decision === "approve") {
      if (job.artifact?.stage === "validate") {
        const checked = documentAcceptance(job.artifact, job);
        if (
          checked.stage === "validate" &&
          checked.blockers.length &&
          job.handoff?.some(
            (h) => h.id === job.sourceJobId && h.kind === "docs",
          )
        )
          throw new Error(checked.blockers.join("；"));
      }
      await assertReviewEvidence(job);
      const validation = validationAcceptance(
        job,
        this.store.jobs(),
        (candidate) => {
          const issue = this.store.get<Issue>("issues", candidate.issueId);
          const repo = this.store.get<Repo>("repos", candidate.repoId);
          return (
            !!issue &&
            !!repo &&
            candidate.revision === revision(issue, repo, candidate.kind)
          );
        },
      );
      if (!validation.allowed) throw new Error(validation.reason);
      if (job.deliveryReviewId) {
        const delivery = await resolveDelivery(
          this.store,
          this.repo(job.repoId),
          job.deliveryReviewId,
          this.github,
        );
        if (delivery.implementationJobId !== job.id)
          throw new Error("实施产物与批准的审查目标不一致");
      }
      if (job.prContext) {
        const live = await this.github.pullRequest(
          this.repo(job.repoId),
          job.issueSnapshot.number,
        );
        if (
          live.headSha !== job.prContext.headSha ||
          live.baseSha !== job.prContext.baseSha
        )
          throw new Error("PR head/base 已更新，请重新审查");
      }
      const current = this.store.get<Issue>("issues", job.issueId)!;
      if (revision(current, this.repo(job.repoId), job.kind) !== job.revision)
        throw new Error("输入已变化，旧结果不可批准；请重新派发任务");
      if (
        job.worktree &&
        (await collectPatch(job.worktree, job.baseSha)) !== (job.patch ?? "")
      )
        throw new Error("worktree 内容已变化，原差异已过期；请重新执行");
    }
    if (JSON.stringify(this.job(id)) !== original)
      throw new Error("审核期间产物状态或发现处置已变化，请重新查看后确认");
    this.saveJob({
      ...job,
      status: decision === "approve" ? "approved" : "rejected",
      reviewNote: note,
    });
    this.store.audit(
      `job.${decision}`,
      note ||
        (decision === "approve"
          ? "审核通过，仅记录本地决定；未推送代码或发布回复"
          : "退回，等待重新调查"),
      id,
    );
    if (
      decision === "approve" &&
      job.kind === "review" &&
      job.patch &&
      job.sourceJobId
    ) {
      try {
        const delivery = await resolveDelivery(
          this.store,
          this.repo(job.repoId),
          id,
          this.github,
        );
        this.saveJob({
          ...this.job(delivery.implementationJobId),
          deliveryReviewId: id,
        });
        this.store.audit(
          "job.delivery_prepared",
          "已定位同一补丁的实施产物，实施审批与远端发布仍单独确认",
          id,
        );
        return { delivery };
      } catch (error) {
        return {
          deliveryBlockedReason:
            error instanceof Error ? error.message : "无法核验实施交接",
        };
      }
    }
    return {};
  }
  finding(id: string, findingId: string, decision: FindingDecision): void {
    this.findings(id, [findingId], decision);
  }
  findings(id: string, findingIds: string[], decision: FindingDecision): void {
    const job = this.job(id);
    if (job.publications?.review?.status === "published")
      throw new Error("此审查已发布，新的处置请创建后续审查任务");
    const ids = [
      ...new Set(z.array(z.string()).min(1).max(40).parse(findingIds)),
    ];
    if (
      job.artifact?.stage !== "review" ||
      ids.some(
        (id) =>
          !job.artifact ||
          job.artifact.stage !== "review" ||
          !job.artifact.findings.some((f) => f.id === id),
      )
    )
      throw new Error("审查发现不存在");
    if (
      ["accepted", "resolved"].includes(decision) &&
      (job.evidenceGate?.allowed === false ||
        (!!job.worktree &&
          !!(job.sessionId || job.toolDiagnostics) &&
          job.evidenceGate?.allowed !== true))
    )
      throw new Error("审查证据不足，请重新派发补齐；当前仅可标记需证据或驳回");
    if (!["completed", "awaiting_review", "approved"].includes(job.status))
      throw new Error("当前审查尚不可处置");
    if (
      job.revision !==
      revision(
        this.store.get<Issue>("issues", job.issueId)!,
        this.repo(job.repoId),
        job.kind,
      )
    )
      throw new Error("审查版本已过期");
    this.saveJob({
      ...job,
      status: "awaiting_review",
      findingDecisions: {
        ...job.findingDecisions,
        ...Object.fromEntries(ids.map((id) => [id, decision])),
      },
    });
    this.store.audit("finding.decision", `${ids.join(", ")}: ${decision}`, id);
  }
  updateSettings(input: unknown): void {
    const settings = settingsSchema.parse(input);
    this.store.put("settings", { ...settings, id: "main" });
    this.store.audit("settings.updated", "更新并发、批量上限和模型配置");
    if (this.autoStart) this.pump();
  }
}
