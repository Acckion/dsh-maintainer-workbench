import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ProcessingService } from "../application/processing.ts";
import {
  ServiceBase,
  type ServiceDependencies,
} from "../application/service.ts";
import { waitFor } from "../core/abort.ts";
import { asAnalysis, lightweight } from "../core/artifacts.ts";
import { documentAcceptance } from "../core/document-acceptance.ts";
import { ArtifactFormatError } from "../core/execution-errors.ts";
import { saveExecutionLog } from "../core/execution-evidence.ts";
import { reconcileTestExecutions } from "../core/execution-links.ts";
import { reviewFollowups } from "../core/finding-followup.ts";
import {
  collectPatch,
  fetchPullRequestRevision,
  git,
  validateCheckout,
} from "../core/git.ts";
import { modelRunner } from "../core/intelligence.ts";
import { retrieveRelated } from "../core/retrieval.ts";
import { reviewRequiredSources } from "../core/review-context.ts";
import {
  reviewEvidenceGate,
  verifiedReviewCoverage,
} from "../core/review-evidence.ts";
import { revision } from "../core/revision.ts";
import {
  type Issue,
  type Job,
  type JobKind,
  type Repo,
  type Runner,
} from "../core/types.ts";
import { stagePolicies } from "../workflow/stages.ts";
import { EnvironmentUnavailable } from "./environment-error.ts";
const patchHash = (patch: string): string =>
  createHash("sha256").update(patch).digest("hex");
const readOnlyCode = (kind: JobKind): boolean =>
  stagePolicies[kind].preserveSource && !stagePolicies[kind].metadataOnly;

export class StageWorker extends ServiceBase {
  constructor(
    deps: ServiceDependencies,
    private hooks: {
      completed?: (job: Job) => void;
      prepareRepository: (id: string) => Promise<void>;
      understand: (
        repo: Repo,
        signal: AbortSignal,
      ) => Promise<import("../core/types.ts").RepositoryProfile>;
    },
  ) {
    super(deps);
  }
  private prepareRepository = (id: string) => this.hooks.prepareRepository(id);
  private understand = (repo: Repo, signal: AbortSignal) =>
    this.hooks.understand(repo, signal);
  async execute(initial: Job, controller: AbortController): Promise<void> {
    let job = {
      ...initial,
      status: "running" as const,
      startedAt: new Date().toISOString(),
    } as Job;
    this.saveJob(job);
    const defaults = this.store.settings();
    const policy = this.repo(job.repoId).policy;
    const settings = {
      ...defaults,
      timeoutMs: policy?.timeoutMs ?? defaults.timeoutMs,
      maxTokens: lightweight(job.kind)
        ? Math.min(
            policy?.maxTokens ?? defaults.maxTokens,
            defaults.triageMaxTokens ?? 1800,
          )
        : (policy?.maxTokens ?? defaults.maxTokens),
    };
    const timer = setTimeout(
      () => controller.abort(new Error("任务超出配置的执行时间")),
      lightweight(job.kind)
        ? Math.min(settings.timeoutMs, 120000)
        : settings.timeoutMs,
    );
    const progress = (
      message: string,
      sessionId?: string,
      waitingReason?: string,
    ) => {
      if (controller.signal.aborted) return;
      this.store.audit("job.progress", message, job.id);
      if (waitingReason !== undefined) {
        job.waitingReason = waitingReason;
        this.saveJob({ ...this.job(job.id), waitingReason });
      }
      if (sessionId) {
        job.sessionId = sessionId;
        this.saveJob({ ...this.job(job.id), sessionId });
      }
    };
    let inputPatchHash: string | undefined;
    try {
      let repo = this.repo(job.repoId);
      const currentCase = this.store.processing.current(job.issueId);
      if (job.caseId && job.caseId !== currentCase?.id)
        throw new Error("处理周期已变化，旧任务不能继续执行");
      if (
        job.revision !==
        revision(this.store.get<Issue>("issues", job.issueId)!, repo, job.kind)
      )
        throw new Error("排队期间输入版本已变化，请重新派发");
      const related = retrieveRelated(
        job.issueSnapshot,
        this.store
          .issues()
          .filter(
            (i) =>
              i.repoId === repo.id &&
              i.id !== job.issueId &&
              i.state === "open",
          ),
      );
      let output: Awaited<ReturnType<Runner>>;
      const directAudit =
        repo.mode === "local" &&
        job.issueSnapshot.organizeMode === "audit" &&
        job.kind === "investigate";
      if (directAudit) {
        job = { ...job, analysisPath: repo.localPath };
        this.saveJob(job);
      }
      if (
        this.nativeRunner &&
        !job.formatOnly &&
        !repo.localPath &&
        !lightweight(job.kind)
      ) {
        progress("自动准备仓库克隆；首次运行可能需要一些时间");
        try {
          await waitFor(this.prepareRepository(repo.id), controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          throw new EnvironmentUnavailable(error);
        }
        controller.signal.throwIfAborted();
        repo = this.repo(repo.id);
      }
      if (job.issueSnapshot.type === "pr") {
        progress("固定 PR head/base，并读取可见 CI 与审查状态");
        const livePR = await this.github.pullRequest(
          repo,
          job.issueSnapshot.number,
          controller.signal,
          lightweight(job.kind),
        );
        if (
          job.formatOnly &&
          (!job.prContext ||
            livePR.headSha !== job.prContext.headSha ||
            livePR.baseSha !== job.prContext.baseSha)
        )
          throw new Error(
            "PR head/base 已变化，不能整理旧版本产物；请重新同步并派发",
          );
        job.prContext = livePR;
        if (job.prContext.merged) throw new Error("PR 已合并，请重新同步");
        if (
          job.issueSnapshot.headSha &&
          job.issueSnapshot.headSha !== job.prContext.headSha
        )
          throw new Error("PR 已更新，请先同步仓库再派发");
        job.baseSha = job.prContext.headSha;
        if (!job.formatOnly && !lightweight(job.kind) && repo.localPath) {
          await fetchPullRequestRevision(
            repo,
            job.issueSnapshot.number,
            job.prContext,
            controller.signal,
          );
        }
        this.saveJob(job);
      }
      if (
        this.nativeRunner &&
        !job.formatOnly &&
        !lightweight(job.kind) &&
        repo.localPath &&
        !directAudit &&
        job.issueSnapshot.type !== "pr"
      ) {
        await validateCheckout(repo.localPath, repo);
        try {
          await git(
            repo.localPath,
            ["cat-file", "-e", `${job.baseSha}^{commit}`],
            false,
            controller.signal,
          );
        } catch {
          if (repo.mode === "local")
            throw new Error("本地提交已不可用，请重新检测工作区");
          await git(
            repo.localPath,
            ["fetch", "origin", job.baseSha],
            true,
            controller.signal,
            120000,
          );
        }
      }
      progress(
        lightweight(job.kind)
          ? "使用缓存仓库摘要；轻量任务不创建代码工作区"
          : "读取仓库结构、开发约定、构建配置与测试入口",
      );
      repo = { ...repo, headSha: job.baseSha };
      if (lightweight(job.kind) && repo.profile)
        repo.profile = {
          ...repo.profile,
          sources: [],
          warnings: [
            ...repo.profile.warnings,
            "轻量分诊仅使用缓存结构摘要，未读取源代码",
          ],
        };
      if (!job.formatOnly && !lightweight(job.kind) && !directAudit)
        repo.profile = await this.understand(repo, controller.signal);
      if (
        this.nativeRunner &&
        !job.formatOnly &&
        repo.localPath &&
        !lightweight(job.kind) &&
        !directAudit
      ) {
        const worktree = await this.deps.workspaces.prepare(repo, job);
        job = { ...job, worktree: worktree.path, branch: worktree.branch };
        controller.signal.throwIfAborted();
        this.saveJob(job);
        progress(`已创建独立分支 ${worktree.branch}`);
      }
      controller.signal.throwIfAborted();
      if (this.nativeRunner && !job.worktree && !job.analysisPath) {
        const analysisPath = join(this.dataDir, "analysis", job.id);
        await mkdir(analysisPath, { recursive: true });
        controller.signal.throwIfAborted();
        job = { ...job, analysisPath };
        this.saveJob(job);
      }
      if (!job.formatOnly && job.sourceJobId && job.worktree) {
        const source = this.job(job.sourceJobId);
        if (
          source.revision === job.revision &&
          source.patch &&
          ["fix", "docs", "validate", "review"].includes(job.kind) &&
          ["fix", "docs", "review", "validate"].includes(source.kind)
        ) {
          if (source.baseSha !== job.baseSha || !source.worktree)
            throw new Error("交接补丁或基础版本已变化");
          const patch = await this.deps.workspaces.patchFor(source);
          if (!patch) throw new Error("交接来源缺少可验证的冻结补丁");
          const { writeFile } = await import("node:fs/promises");
          const patchFile = join(this.dataDir, "analysis", `${job.id}.patch`);
          await mkdir(join(this.dataDir, "analysis"), { recursive: true });
          await writeFile(patchFile, patch);
          await git(job.worktree, ["apply", "--index", patchFile]);
          await this.deps.workspaces.verifyTree(job, source.id);
          progress("已将来源补丁应用到新的隔离工作区");
        }
      }
      const readOnlyStage =
        readOnlyCode(job.kind) ||
        (job.issueSnapshot.organizeMode === "audit" &&
          job.kind === "investigate");
      if (job.formatOnly) {
        await this.deps.workspaces.acquireFormatRecovery(job);
        const checkpoint = job.formatRecovery;
        if (!checkpoint || checkpoint.baseSha !== job.baseSha)
          throw new Error("缺少可信的输出整理检查点；请重新派发");
        const currentPatch = job.worktree
          ? await collectPatch(job.worktree, job.baseSha)
          : "";
        if (
          patchHash(currentPatch) !== checkpoint.patchHash ||
          (job.worktree &&
            (await git(job.worktree, ["rev-parse", "HEAD"])) !== job.baseSha)
        )
          throw new Error(
            "工作区在输出失败后已变化，不能整理旧产物；请重新派发",
          );
      }
      inputPatchHash = patchHash(
        job.worktree && readOnlyStage
          ? await collectPatch(job.worktree, job.baseSha)
          : "",
      );
      if (
        job.kind === "ci" &&
        job.issueSnapshot.type === "pr" &&
        !job.formatOnly
      ) {
        try {
          const snapshot = await this.github.actions(
              repo,
              job.prContext!.headSha,
              controller.signal,
            ),
            logs: import("../core/remote-progress.ts").ActionsLog[] = [];
          for (const item of snapshot.jobs
            .filter(
              (j) => j.conclusion === "failure" || j.conclusion === "timed_out",
            )
            .slice(0, 3)) {
            try {
              const log = await this.github.actionLog(
                repo,
                snapshot,
                item.id,
                controller.signal,
              );
              logs.push({
                ...log,
                text: log.text.slice(-16000),
                truncated: log.truncated || log.text.length > 16000,
              });
            } catch (e) {
              if (controller.signal.aborted) throw e;
              snapshot.warnings.push(
                `job ${item.id} 日志读取失败：${e instanceof Error ? e.message : "未知错误"}`,
              );
            }
          }
          job = { ...job, ciEvidence: { snapshot, logs } };
          this.saveJob(job);
        } catch (e) {
          if (controller.signal.aborted) throw e;
          job = {
            ...job,
            ciEvidence: {
              snapshot: {
                headSha: job.prContext!.headSha,
                syncedAt: new Date().toISOString(),
                jobs: [],
                warnings: [e instanceof Error ? e.message : "Actions 读取失败"],
              },
              logs: [],
            },
          };
          this.saveJob(job);
        }
      }
      if (
        this.nativeRunner &&
        job.kind === "review" &&
        job.worktree &&
        !job.formatOnly
      ) {
        job = {
          ...job,
          reviewRequiredSources: await reviewRequiredSources(job),
        };
        this.saveJob(job);
      }
      const runner = this.nativeRunner ?? modelRunner;
      output = await runner({
        repo,
        issue: job.issueSnapshot,
        related,
        job,
        settings,
        signal: controller.signal,
        progress,
        recordDiagnostics: (diagnostics) => {
          job = { ...job, toolDiagnostics: diagnostics };
          this.saveJob({ ...this.job(job.id), toolDiagnostics: diagnostics });
        },
        recordExecution: (record, raw) => {
          saveExecutionLog(this.dataDir, job.id, record.id, raw);
          const records = [
            ...(this.job(job.id).executionRecords ?? []).filter(
              (item) => item.id !== record.id,
            ),
            record,
          ];
          job = { ...job, executionRecords: records };
          this.saveJob({ ...this.job(job.id), executionRecords: records });
        },
        recordOutput: (text) => {
          if (controller.signal.aborted) return;
          job = { ...job, rawOutput: text.slice(0, 200000) };
          this.saveJob({ ...this.job(job.id), rawOutput: job.rawOutput });
        },
      });
      controller.signal.throwIfAborted();
      const patch = job.worktree
        ? await collectPatch(job.worktree, job.baseSha)
        : "";
      controller.signal.throwIfAborted();
      if (
        job.formatOnly &&
        (patchHash(patch) !== job.formatRecovery!.patchHash ||
          (job.worktree &&
            (await git(job.worktree, ["rev-parse", "HEAD"])) !== job.baseSha))
      )
        throw new Error(
          "工作区在结果整理期间已变化，不能接受旧产物；请重新派发",
        );
      controller.signal.throwIfAborted();
      if (readOnlyStage && patchHash(patch) !== inputPatchHash)
        throw new Error(
          "分析或验证修改了代码；差异保留在工作区，不能作为已完成产物交付",
        );
      const inputRequest = output.inputRequest ?? output.artifact?.inputRequest;
      if (inputRequest) {
        const currentIssue = this.store.get<Issue>("issues", job.issueId)!;
        if (
          job.revision !==
            revision(currentIssue, this.repo(job.repoId), job.kind) ||
          (job.caseId && job.caseId !== currentIssue.processing?.id)
        )
          throw new Error("输入版本已变化，不能提交旧运行的输入请求");
        await this.deps.workspaces.freeze(job, patch);
        controller.signal.throwIfAborted();
        this.store.transaction(() => {
          const latestIssue = this.store.get<Issue>("issues", job.issueId)!;
          if (
            job.revision !==
              revision(latestIssue, this.repo(job.repoId), job.kind) ||
            (job.caseId && job.caseId !== latestIssue.processing?.id)
          )
            throw new Error("输入版本已变化，不能提交旧运行的输入请求");
          this.saveJob({
            ...this.job(job.id),
            ...output,
            patch,
            patchSha256: patchHash(patch),
            status: "waiting_input",
            waitingReason: undefined,
            finishedAt: new Date().toISOString(),
          });
          new ProcessingService(this.store).requestInput(
            job.issueId,
            inputRequest,
            job.id,
          );
        });
        return;
      }
      if (
        (job.kind === "fix" || job.kind === "docs") &&
        !patch &&
        !job.issueSnapshot.origin &&
        !job.instructions?.startsWith("Repository documentation maintenance.")
      )
        throw new Error(
          "Agent 未产生可审核的代码差异。该任务不能作为已完成的修复交付。",
        );
      if (output.artifact) {
        output.artifact = reconcileTestExecutions(output.artifact, {
          ...job,
          patchSha256: patchHash(patch),
        });
        output.artifact = documentAcceptance(output.artifact, {
          ...job,
          patchSha256: patchHash(patch),
        });
        if (output.artifact.stage === "validate")
          output.result = asAnalysis(output.artifact);
        if ("tests" in output.artifact)
          output.result = { ...output.result, tests: output.artifact.tests };
      }
      if (output.artifact?.stage === "review") {
        job.evidenceGate = await reviewEvidenceGate(
          { ...job, patchSha256: patchHash(patch) },
          output.artifact,
        );
        output.artifact = verifiedReviewCoverage(
          job,
          output.artifact,
          job.evidenceGate.allowed,
        );
        output.result = asAnalysis(output.artifact);
        if (!job.evidenceGate.allowed && output.artifact.stage === "review") {
          output.artifact = {
            ...output.artifact,
            verdict: "incomplete",
            blockers: [
              ...new Set([
                ...output.artifact.blockers,
                ...job.evidenceGate.reasons,
              ]),
            ].slice(0, 30),
          };
          output.result = asAnalysis(output.artifact);
        }
      }
      if (output.artifact?.stage === "review")
        job.findingFollowups = reviewFollowups(
          job,
          output.artifact.followups ?? [],
        );
      await this.deps.workspaces.freeze(job, patch);
      controller.signal.throwIfAborted();
      this.store.transaction(() => {
        const currentIssue = this.store.get<Issue>("issues", job.issueId)!;
        if (job.kind === "triage")
          this.store.saveTriage(
            job.issueId,
            job.revision,
            job.id,
            output.result,
          );
        if (
          job.kind === "triage" &&
          (!job.caseId || job.caseId === currentIssue.processing?.id) &&
          revision(currentIssue, this.repo(job.repoId), job.kind) ===
            job.revision
        )
          this.store.put("issues", {
            ...currentIssue,
            analysis: output.result,
            analysisRevision: job.revision,
          });
        this.saveJob({
          ...job,
          ...output,
          patch,
          patchSha256: patchHash(patch),
          formatRecovery: undefined,
          waitingReason: undefined,
          status:
            ((job.issueSnapshot.origin ||
              job.instructions?.startsWith(
                "Repository documentation maintenance.",
              )) &&
              !patch) ||
            lightweight(job.kind) ||
            ["investigate", "validate", "ci"].includes(job.kind)
              ? "completed"
              : "awaiting_review",
          finishedAt: new Date().toISOString(),
        });
      });
    } catch (error) {
      const current = this.job(job.id);
      let formatRecovery: Job["formatRecovery"];
      if (
        error instanceof ArtifactFormatError &&
        current.status !== "cancelled" &&
        current.rawOutput &&
        !controller.signal.aborted
      ) {
        try {
          const patch = current.worktree
            ? await collectPatch(current.worktree, current.baseSha)
            : "";
          const digest = patchHash(patch);
          if (
            current.formatOnly &&
            (!current.formatRecovery ||
              current.formatRecovery.baseSha !== current.baseSha ||
              digest !== current.formatRecovery.patchHash)
          )
            throw new Error(
              "工作区在结果整理期间已变化，不能整理旧产物；请重新派发",
            );
          if (readOnlyCode(current.kind) && digest !== inputPatchHash)
            throw new Error(
              "分析或验证修改了代码；差异保留在工作区，不能作为已完成产物交付",
            );
          if (
            current.worktree &&
            (await git(current.worktree, ["rev-parse", "HEAD"])) !==
              current.baseSha
          )
            throw new Error("工作区 HEAD 已变化，不能仅整理输出；请重新派发");
          if (["fix", "docs"].includes(current.kind) && !patch)
            throw new Error("Agent 未产生可审核的代码差异，请重新派发");
          formatRecovery = { baseSha: current.baseSha, patchHash: digest };
        } catch (integrityError) {
          error = integrityError;
        }
      }
      const latest = this.job(job.id);
      if (latest.status !== "cancelled")
        this.saveJob({
          ...latest,
          status:
            error instanceof EnvironmentUnavailable
              ? "waiting_environment"
              : "failed",
          formatRecovery: controller.signal.aborted
            ? undefined
            : formatRecovery,
          waitingReason: undefined,
          error: controller.signal.aborted
            ? String(controller.signal.reason?.message ?? "已中断")
            : error instanceof Error
              ? error.message
              : String(error),
          finishedAt: new Date().toISOString(),
        });
      this.store.audit(
        "job.stopped",
        this.job(job.id).error ?? "已取消",
        job.id,
      );
      if (error instanceof EnvironmentUnavailable && !controller.signal.aborted)
        this.store.processing.dispatch(
          job.issueId,
          {
            type: "environment.observed",
            ready: false,
            reason: this.job(job.id).error ?? "仓库环境尚未就绪",
          },
          "system",
          `environment:${job.id}`,
        );
    } finally {
      clearTimeout(timer);
      this.deps.workspaces.release(job);
      this.hooks.completed?.(this.job(job.id));
    }
  }
}
