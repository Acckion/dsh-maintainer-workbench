import { nextGoalStep } from "./goal-flow.ts";
import { documentAcceptance } from "./document-acceptance.ts";
import { validationInstructions } from "./validation-context.ts";
import { reviewRequiredSources } from "./review-context.ts";
import {
  assertReviewEvidence,
  reviewEvidenceGate,
  verifiedReviewCoverage,
} from "./review-evidence.ts";
import { prNumber } from "./remote-progress.ts";
import { lightweight, asAnalysis, type FindingDecision } from "./artifacts.ts";
import { githubDetail, type DetailSection } from "./github-details.ts";
import { discoverWorkspace } from "./workspace-discovery.ts";
import {
  organizeActions,
  organizeModes,
  type OrganizeMode,
} from "./organize.ts";
import { localRepositoryProfile } from "./repository-context.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { previewPublication, publish, type PublishAction } from "./publish.ts";
import { retrieveRelated } from "./retrieval.ts";
import { Store } from "./store.ts";
import { GitHub } from "./github.ts";
import {
  collectPatch,
  applicationPatch,
  prepareWorktree,
  validateCheckout,
  prepareManagedCheckout,
  git,
  fetchPullRequestRevision,
} from "./git.ts";
import { modelRunner } from "./intelligence.ts";
import { ArtifactFormatError } from "./execution-errors.ts";
import { revision } from "./revision.ts";
import { validationState } from "./workflow-state.ts";
import { validationAcceptance } from "./validation-acceptance.ts";
import { resolveDelivery, type DeliveryTarget } from "./delivery.ts";
import {
  issuePlanSchema,
  planBlocker,
  receiveReplies,
  sameQuestions,
} from "./issue-flow.ts";
import { reviewFollowups } from "./finding-followup.ts";
import { readExecutionLog, saveExecutionLog } from "./execution-evidence.ts";
import { reconcileTestExecutions } from "./execution-links.ts";
import {
  kinds,
  type Issue,
  type Job,
  type JobKind,
  type Repo,
  type Runner,
  type Settings,
  type Snapshot,
  type HostStatus,
} from "./types.ts";
export { revision } from "./revision.ts";
const patchHash = (patch: string): string =>
  createHash("sha256").update(patch).digest("hex");
const readOnlyCode = (kind: JobKind): boolean =>
  ["review", "validate", "ci"].includes(kind);
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

export class Workbench {
  private active = new Map<string, AbortController>();
  private completions = new Set<Promise<void>>();
  private closed = false;
  private lastRepo = "";
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private publishing = new Set<string>();
  private preparationControllers = new Map<string, AbortController>();
  private preparations = new Map<string, Promise<void>>();
  private profiles = new Map<
    string,
    Promise<import("./types.ts").RepositoryProfile>
  >();
  private remoteSyncs = new Map<string, Promise<void>>();
  private syncs = new Map<string, Promise<void>>();
  constructor(
    public store: Store,
    private dataDir: string,
    private nativeRunner?: Runner,
    private github = new GitHub(),
    private autoStart = true,
    private hostStatus?: () => HostStatus,
  ) {
    for (const repo of store.repos())
      if (
        repo.syncWarning?.includes(
          "只同步最近更新的 1000 条记录，较早的记录未覆盖。",
        )
      )
        store.put("repos", {
          ...repo,
          syncLimited: true,
          syncWarning:
            repo.syncWarning
              .replace("只同步最近更新的 1000 条记录，较早的记录未覆盖。", "")
              .trim() || null,
        });
    for (const job of store.jobs())
      if (job.status === "running") {
        this.saveJob({
          ...job,
          status: "failed",
          waitingReason: undefined,
          error:
            "上次进程中断。为避免重复修改，未自动重新执行；请检查 worktree 后重试。",
          finishedAt: new Date().toISOString(),
        });
        store.audit("job.interrupted", "进程重启后恢复为待人工重试", job.id);
      }
    for (const job of store.jobs())
      if (job.publications) {
        let changed = false;
        for (const receipt of Object.values(job.publications))
          if (receipt.status === "publishing") {
            receipt.status = "failed";
            receipt.error =
              "上次发布过程被中断；重试时将先按任务标识核对远端结果";
            changed = true;
          }
        if (changed) {
          this.saveJob(job);
          store.audit("publish.interrupted", "恢复中断的发布记录", job.id);
        }
      }
    if (autoStart) {
      queueMicrotask(() => this.pump());
      this.pollTimer = setInterval(() => void this.poll(), 60000);
      this.pollTimer.unref();
    }
  }
  async discover(paths: string[]): Promise<void> {
    const seen = new Set<string>();
    for (const path of paths) {
      if (this.closed) return;
      try {
        const found = await discoverWorkspace(path, this.dataDir);
        if (!found || this.closed) continue;
        const old =
          this.store
            .repos()
            .find(
              (r) =>
                r.localPath === found.localPath ||
                (!r.discovered &&
                  found.githubName &&
                  r.fullName.toLowerCase() === found.githubName.toLowerCase()),
            ) ?? this.store.get<Repo>("repos", found.id);
        seen.add(old?.id ?? found.id);
        this.store.put("repos", {
          description: "Harness 自动发现的工作区",
          syncedAt: null,
          syncWarning: null,
          defaultBranch: "",
          ...old,
          ...found,
          id: old?.id ?? found.id,
          discoveryActive: true,
          workspacePaths: [
            ...new Set([
              ...(old?.workspacePaths ?? []),
              ...(found.workspacePaths ?? []),
            ]),
          ],
        });
      } catch {
        /* Removed or inaccessible host workspaces do not block other directories. */
      }
    }
    for (const repo of this.store.repos())
      if (repo.discovered && !seen.has(repo.id))
        this.store.put("repos", { ...repo, discoveryActive: false });
  }
  async poll(): Promise<void> {
    const settings = this.store.settings();
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      for (const repo of this.store.repos()) {
        if (this.closed) break;
        const interval =
          repo.policy?.syncIntervalMinutes ?? settings.syncIntervalMinutes;
        try {
          if (
            (repo.mode === "github" || repo.githubName) &&
            interval &&
            Date.now() - new Date(repo.syncedAt ?? 0).getTime() >=
              interval * 60000
          )
            await this.sync(repo.githubName ?? repo.fullName);
          this.autoTriage(repo.id);
        } catch (error) {
          if (!this.closed)
            this.store.audit(
              "automation.failed",
              `${repo.fullName}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
      }
    } finally {
      this.polling = false;
    }
  }
  private autoTriage(repoId: string): void {
    const settings = this.store.settings(),
      repo = this.repo(repoId);
    if (this.closed) return;
    const jobs = this.store.jobs();
    const pending = jobs.filter(
      (j) =>
        ["triage", "preflight"].includes(j.kind) &&
        ["queued", "running"].includes(j.status),
    ).length;
    const remaining = Math.max(0, settings.maxJobsPerBatch - pending);
    const candidates = this.store
      .issues()
      .filter((i) => {
        const kind = i.type === "pr" ? "preflight" : "triage";
        const enabled =
          i.type === "pr"
            ? (repo.policy?.autoPreflight ?? settings.autoPreflight)
            : (repo.policy?.autoTriage ?? settings.autoTriage);
        return (
          i.repoId === repoId &&
          enabled &&
          i.state === "open" &&
          !i.origin &&
          !i.linkedPullRequests?.length &&
          !["answered", "deferred"].includes(i.workflow?.stage ?? "") &&
          !i.informationRequests?.some((r) =>
            ["asked", "reply_received"].includes(r.state),
          ) &&
          !jobs.some(
            (j) =>
              j.issueId === i.id &&
              j.kind === kind &&
              j.revision === revision(i, repo, kind),
          )
        );
      })
      .slice(0, remaining);
    for (const kind of ["triage", "preflight"] as const) {
      const ids = candidates
        .filter((i) => (i.type === "pr" ? "preflight" : "triage") === kind)
        .map((i) => i.id);
      if (ids.length) this.enqueue(ids, kind);
    }
  }
  async itemDetail(id: string, section: DetailSection, page = 1) {
    const issue = this.store.get<Issue>("issues", id);
    if (!issue) throw new Error("事项不存在，请同步仓库后重试");
    return githubDetail(
      this.github,
      this.repo(issue.repoId),
      issue,
      section,
      page,
    );
  }
  githubConnection() {
    return this.github.connection();
  }
  snapshot(): Snapshot {
    const host = this.hostStatus?.();
    return {
      repos: this.store
        .repos()
        .filter(
          (r) =>
            r.discoveryActive !== false ||
            this.store.issues().some((i) => i.repoId === r.id) ||
            this.store.jobs().some((j) => j.repoId === r.id),
        ),
      issues: this.store.issues(),
      jobs: this.store
        .jobs()
        .reverse()
        .map((j) => ({
          ...j,
          artifactState:
            this.store.get<Issue>("issues", j.issueId) &&
            j.revision ===
              revision(
                this.store.get<Issue>("issues", j.issueId)!,
                this.repo(j.repoId),
                j.kind,
              )
              ? "current"
              : "stale",
        })),
      audit: this.store.audits(),
      settings: this.store.settings(),
      capabilities: {
        harness: !!this.nativeRunner,
        model: this.nativeRunner
          ? !!host?.adapterRegistered
          : !!(process.env.MAINTAINER_API_KEY || process.env.DEEPSEEK_API_KEY),
        github: !!process.env.GITHUB_TOKEN,
        modelName: host?.model ?? this.store.settings().model,
        baseUrl: process.env.MAINTAINER_BASE_URL ?? "https://api.deepseek.com",
        running: this.active.size,
        ...(host ? { host } : {}),
      },
      version: "0.2.0",
    };
  }
  saveJob(job: Job): void {
    this.store.put("jobs", { ...job, updatedAt: new Date().toISOString() });
  }
  async syncMany(names: string[]) {
    const unique = [
      ...new Set(
        names.map((n) =>
          n
            .trim()
            .replace(/^https:\/\/github\.com\//i, "")
            .replace(/\/$/, "")
            .replace(/\.git$/, "")
            .toLowerCase(),
        ),
      ),
    ];
    if (
      !unique.length ||
      unique.length > 20 ||
      unique.some(
        (n) => !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(n),
      )
    )
      throw new Error(
        "请输入 1–20 个有效的 owner/repository 或 GitHub 仓库地址",
      );
    const results: { fullName: string; repoId?: string; error?: string }[] = [];
    for (const fullName of unique) {
      try {
        await this.sync(fullName);
        results.push({
          fullName,
          repoId: this.store
            .repos()
            .find((r) => r.fullName.toLowerCase() === fullName)?.id,
        });
      } catch (error) {
        results.push({
          fullName,
          error: error instanceof Error ? error.message : "同步失败",
        });
      }
    }
    return { results };
  }
  async sync(fullName: string): Promise<void> {
    const key = fullName.toLowerCase();
    const existing = this.syncs.get(key);
    if (existing) return existing;
    const task = this.performSync(fullName).finally(() =>
      this.syncs.delete(key),
    );
    this.syncs.set(key, task);
    return task;
  }
  private async performSync(fullName: string): Promise<void> {
    const configured = this.store
      .repos()
      .find(
        (r) =>
          (r.githubName ?? r.fullName).toLowerCase() === fullName.toLowerCase(),
      );
    const { repo, issues } = await this.github.sync(
      fullName,
      configured?.policy?.syncLimit ?? this.store.settings().syncLimit ?? 1000,
    );
    const prev =
      this.store
        .repos()
        .find(
          (r) =>
            r.discovered &&
            r.githubName?.toLowerCase() === repo.fullName.toLowerCase(),
        ) ?? this.store.get<Repo>("repos", repo.id);
    if (prev?.discovered) {
      const remoteId = repo.id;
      Object.assign(repo, {
        id: prev.id,
        mode: "local",
        discovered: true,
        localKind: prev.localKind,
        workspacePaths: prev.workspacePaths,
        githubName: prev.githubName,
        remoteCandidates: prev.remoteCandidates,
        dirty: prev.dirty,
        headSha: prev.headSha,
      });
      for (const issue of issues) {
        issue.repoId = repo.id;
        issue.id = issue.id.replace(remoteId, repo.id);
      }
    }
    repo.localPath = prev?.localPath ?? "";
    repo.policy = prev?.policy;
    if (prev?.profile?.revision === repo.headSha) repo.profile = prev.profile;
    const replies = new Map<
      string,
      {
        replies: import("./types.ts").InformationRequest["replies"];
        partial: boolean;
      }
    >();
    const replyErrors = new Map<string, string>();
    for (const issue of issues) {
      const old = this.store.get<Issue>("issues", issue.id);
      const active =
        old?.informationRequests?.filter((r) =>
          ["asked", "reply_received"].includes(r.state),
        ) ?? [];
      if (
        !active.length ||
        (old?.comments === issue.comments &&
          old?.updatedAt === issue.updatedAt &&
          active.every((r) => r.checkedAt && !r.warning))
      )
        continue;
      try {
        replies.set(
          issue.id,
          await this.github.informationReplies(
            repo,
            issue,
            active.map((r) => r.askedAt).sort()[0],
          ),
        );
      } catch (error) {
        replyErrors.set(
          issue.id,
          error instanceof Error ? error.message : "回复读取失败",
        );
      }
    }
    this.store.transaction(() => {
      this.store.put("repos", repo);
      for (const issue of issues) {
        const old = this.store.get<Issue>("issues", issue.id);
        issue.plan = old?.plan;
        const cached = this.store.triage(issue.id, revision(issue, repo));
        if (cached) {
          issue.analysis = cached.analysis;
          issue.analysisRevision = revision(issue, repo);
        }
        if (old?.analysis && old.analysisRevision === revision(issue, repo)) {
          issue.analysis = old.analysis;
          issue.analysisRevision = old.analysisRevision;
        }
        const response = replies.get(issue.id);
        const informationRequests = old?.informationRequests?.map((request) =>
          response
            ? receiveReplies(request, response.replies, response.partial)
            : replyErrors.has(issue.id) &&
                ["asked", "reply_received"].includes(request.state)
              ? { ...request, warning: replyErrors.get(issue.id) }
              : request,
        );
        const changedReply = informationRequests?.some(
          (request) =>
            request.state === "reply_received" &&
            request.replies.length >
              (old?.informationRequests?.find((r) => r.id === request.id)
                ?.replies.length ?? 0),
        );
        const persistent =
          (old?.workflow?.stage === "track" &&
            !!old.linkedPullRequests?.length) ||
          informationRequests?.some((r) =>
            ["asked", "reply_received"].includes(r.state),
          ) ||
          ["answered", "deferred"].includes(old?.workflow?.stage ?? "");
        this.store.put("issues", {
          ...issue,
          informationRequests,
          linkedPullRequests: old?.linkedPullRequests,
          remotePRs: old?.remotePRs,
          remoteWarning: old?.remoteWarning,
          actions: old?.actions,
          workflow: changedReply
            ? {
                stage: "decision",
                reason:
                  "等待的用户有新回复，请核对补充内容后重新评估；未自动重新执行。",
                updatedAt: new Date().toISOString(),
              }
            : old?.workflow &&
                (persistent ||
                  revision(old, prev ?? repo) === revision(issue, repo))
              ? old.workflow
              : undefined,
        });
      }
      this.store.audit(
        "repo.sync",
        `${repo.fullName}：同步 ${issues.length} 条记录${repo.syncWarning ? "（部分覆盖）" : ""}`,
      );
    });
    const tracked = this.store
      .issues()
      .filter((i) => i.repoId === repo.id && i.linkedPullRequests?.length);
    for (const issue of tracked.slice(0, 20)) await this.syncRemote(issue.id);
    if (tracked.length > 20) {
      const current = this.repo(repo.id);
      this.store.put("repos", {
        ...current,
        syncWarning: [
          current.syncWarning,
          "本次自动跟踪仅覆盖前 20 个关联事项，其余请手动刷新",
        ]
          .filter(Boolean)
          .join("；"),
      });
      this.store.audit(
        "remote.partial",
        "本次自动跟踪仅覆盖前 20 个事项，其余可手动刷新",
      );
    }
    this.autoTriage(repo.id);
  }
  async syncRemote(issueId: string): Promise<void> {
    const existing = this.remoteSyncs.get(issueId);
    if (existing) return existing;
    const task = this.performRemoteSync(issueId).finally(() =>
      this.remoteSyncs.delete(issueId),
    );
    this.remoteSyncs.set(issueId, task);
    return task;
  }
  private async performRemoteSync(issueId: string): Promise<void> {
    const issue = this.store.get<Issue>("issues", issueId);
    if (!issue) throw Error("事项不存在");
    const repo = this.repo(issue.repoId),
      urls =
        issue.type === "pr" ? [issue.url] : (issue.linkedPullRequests ?? []);
    const snapshots: import("./remote-progress.ts").RemotePR[] = [];
    for (const url of urls.slice(0, 10)) {
      try {
        snapshots.push(await this.github.remotePR(repo, url));
      } catch (e) {
        const old = issue.remotePRs?.find((p) => p.url === url);
        snapshots.push({
          ...old,
          url,
          number: old?.number ?? 0,
          headSha: old?.headSha ?? "",
          baseSha: old?.baseSha ?? "",
          state: old?.state ?? "UNKNOWN",
          draft: old?.draft ?? false,
          review: old?.review ?? null,
          mergeState: old?.mergeState ?? "UNKNOWN",
          mergedAt: old?.mergedAt ?? null,
          checks: old?.checks ?? [],
          closingIssues: old?.closingIssues ?? [],
          partial: true,
          syncedAt: old?.syncedAt ?? "",
          error: e instanceof Error ? e.message : "读取失败",
        });
      }
    }
    let state = issue.state,
      warning = urls.length > 10 ? "仅同步前 10 个关联 PR" : undefined;
    try {
      const remote = z
        .object({ number: z.number(), state: z.enum(["open", "closed"]) })
        .parse(
          await this.github.request(
            `/repos/${repo.fullName}/issues/${issue.number}`,
          ),
        );
      if (remote.number !== issue.number) throw Error("事项目标不一致");
      state = remote.state;
    } catch (e) {
      warning = [
        warning,
        `Issue 状态读取失败：${e instanceof Error ? e.message : "未知错误"}`,
      ]
        .filter(Boolean)
        .join("；");
    }
    const current = this.store.get<Issue>("issues", issueId)!;
    const allowed =
      current.type === "pr"
        ? [current.url]
        : (current.linkedPullRequests ?? []);
    this.store.put("issues", {
      ...current,
      state,
      remotePRs: snapshots.filter((p) => allowed.includes(p.url)),
      remoteWarning: warning,
    });
    this.store.audit(
      "remote.synced",
      `${issueId}：只读同步 ${snapshots.length} 个 PR`,
    );
  }
  async syncActions(issueId: string, targetNumber?: number): Promise<void> {
    const issue = this.store.get<Issue>("issues", issueId);
    if (!issue) throw Error("事项不存在");
    const repo = this.repo(issue.repoId),
      number = targetNumber ?? (issue.type === "pr" ? issue.number : 0);
    if (
      !number ||
      (!(issue.type === "pr" && issue.number === number) &&
        !issue.linkedPullRequests?.some(
          (url) => prNumber(url, repo.fullName) === number,
        ))
    )
      throw Error("PR 不属于当前事项关联范围");
    const pr = await this.github.pullRequest(repo, number);
    const actions = await this.github.actions(repo, pr.headSha);
    actions.prNumber = number;
    const after = await this.github.pullRequest(repo, number);
    if (after.headSha !== pr.headSha || after.baseSha !== pr.baseSha)
      throw Error("PR 已更新，请重新同步 Actions");
    this.store.put("issues", {
      ...this.store.get<Issue>("issues", issueId)!,
      actions,
    });
  }
  async actionsLog(issueId: string, jobId: number) {
    const issue = this.store.get<Issue>("issues", issueId);
    if (!issue?.actions) throw Error("请先同步 Actions");
    return this.github.actionLog(this.repo(issue.repoId), issue.actions, jobId);
  }
  async bindPath(repoId: string, localPath: string): Promise<void> {
    const repo = this.repo(repoId);
    const path = await validateCheckout(localPath, repo);
    this.store.put("repos", { ...repo, localPath: path });
    this.store.audit("repo.bind", `${repo.fullName} 已绑定本地工作区`);
  }
  async prepareRepository(repoId: string): Promise<void> {
    const existing = this.preparations.get(repoId);
    if (existing) return existing;
    const repo = this.repo(repoId);
    if (!this.nativeRunner || repo.mode !== "github")
      throw new Error("自动工作区需要 Harness 和真实 GitHub 仓库");
    if (repo.localPath) return;
    const controller = new AbortController();
    this.preparationControllers.set(repoId, controller);
    const task = prepareManagedCheckout(repo, this.dataDir, controller.signal)
      .then((localPath) => {
        this.store.put("repos", { ...this.repo(repoId), localPath });
        this.store.audit(
          "repo.prepared",
          `${repo.fullName} 已自动准备独立本地克隆`,
        );
      })
      .finally(() => {
        this.preparations.delete(repoId);
        this.preparationControllers.delete(repoId);
      });
    this.preparations.set(repoId, task);
    return task;
  }
  private async understand(repo: Repo, signal: AbortSignal) {
    if (
      repo.profile?.revision === repo.headSha &&
      repo.profile.sources.length &&
      (!repo.localPath ||
        !repo.profile.warnings.some((w) => w.startsWith("Remote")))
    )
      return repo.profile;
    const key = `${repo.id}:${repo.headSha}:${!!repo.localPath}`;
    let task = this.profiles.get(key);
    if (!task) {
      task = (
        repo.localPath
          ? localRepositoryProfile(repo.localPath, repo.headSha)
          : this.github.profile(repo, AbortSignal.timeout(30000))
      ).finally(() => this.profiles.delete(key));
      this.profiles.set(key, task);
    }
    const profile = await waitFor(task, signal);
    signal.throwIfAborted();
    const current = this.repo(repo.id);
    if (current.headSha === repo.headSha)
      this.store.put("repos", { ...current, profile });
    return profile;
  }
  private repo(id: string): Repo {
    const repo = this.store.get<Repo>("repos", id);
    if (!repo) throw new Error("仓库不存在");
    return repo;
  }
  private job(id: string): Job {
    const job = this.store.get<Job>("jobs", id);
    if (!job) throw new Error("任务不存在");
    return job;
  }
  organize(
    repoId: string,
    mode: OrganizeMode,
    issueId?: string,
    instructions = "",
  ) {
    z.enum(organizeModes).parse(mode);
    const repo = this.repo(repoId),
      action = organizeActions[mode];
    if (
      (repo.localKind === "folder" ||
        (repo.mode === "local" && !repo.headSha)) &&
      mode !== "audit"
    )
      throw new Error(
        "已发现此目录，但当前整理执行需要至少一个 Git 提交；不会自动初始化或提交你的文件",
      );
    if (repo.mode === "local" && repo.dirty && mode !== "audit")
      throw new Error(
        "当前目录有未提交修改。本版隔离任务读取 HEAD，请先提交；不会悄悄忽略或覆盖这些修改",
      );
    if (!this.nativeRunner) throw new Error("仓库整理需要 Harness 原生执行器");
    let id = issueId;
    if (id) {
      const issue = this.store.get<Issue>("issues", id);
      if (
        !issue ||
        issue.repoId !== repoId ||
        issue.type !== "pr" ||
        mode !== "docs"
      )
        throw new Error("PR 整理仅支持同一仓库的文档同步");
    } else {
      id = `${repo.id}:organize:${mode}`;
      if (!this.store.get<Issue>("issues", id))
        this.store.put("issues", {
          id,
          repoId,
          origin: "repository",
          organizeMode: mode,
          number: 0,
          type: "issue",
          title: action.title,
          body: action.description,
          author: "维护者",
          labels: [],
          state: "open",
          comments: 0,
          updatedAt: new Date().toISOString(),
          url: repo.githubName
            ? `https://github.com/${repo.githubName}`
            : repo.mode === "github"
              ? `https://github.com/${repo.fullName}`
              : "",
        });
    }
    return this.enqueue([id], action.kind, {
      instructions: action.instructions + "\nMaintainer scope: " + instructions,
    });
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
      const blocker = planBlocker(issue, kind);
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
        !source.result ||
        !["completed", "awaiting_review", "approved"].includes(source.status)
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
              j.sourceJobId === options.sourceJobId &&
              (j.instructions ?? "") === (options.instructions ?? "") &&
              !["failed", "cancelled", "rejected"].includes(j.status),
          );
        if (
          prior &&
          (!options.forceNew || ["queued", "running"].includes(prior.status))
        ) {
          if (options.goal && !prior.goal) this.saveJob({...prior,goal:options.goal,goalId:options.goalId ?? prior.id});
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
          goalId: options.goal ? options.goalId ?? id : undefined,
          handoff,
          sourceJobId: options.sourceJobId,
          instructions: options.instructions?.slice(0, 8000),
          id,
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
    if (!["queued", "running"].includes(job.status))
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
    const result = this.enqueue([job.issueId], job.kind, {
      sourceJobId: job.sourceJobId,
      instructions: job.instructions,
      goal: job.goal, goalId: job.goalId,
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
    return this.enqueue([job.issueId], job.kind, {
      sourceJobId: job.sourceJobId,
      instructions: job.instructions,
      goal: job.goal, goalId: job.goalId,
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
  decide(issueId: string, stage: string, reason: string): void {
    const issue = this.store.get<Issue>("issues", issueId);
    if (!issue) throw new Error("事项不存在");
    if (
      !["accepted", "needs_info", "deferred", "decision", "answered"].includes(
        stage,
      )
    )
      throw new Error("无效的处理阶段");
    if (
      stage === "answered" &&
      ((issue.plan?.category ?? issue.analysis?.category) !== "question" ||
        !reason.trim())
    )
      throw new Error(
        "仅使用提问可记录答复并结束本地处理，请填写答复或已发布链接。",
      );
    this.store.put("issues", {
      ...issue,
      workflow: { stage, reason, updatedAt: new Date().toISOString() },
    });
    this.store.audit("item.decision", `${issueId}: ${stage} · ${reason}`);
  }
  savePlan(issueId: string, value: unknown): void {
    const issue = this.store.get<Issue>("issues", issueId);
    if (!issue || issue.type !== "issue" || issue.state !== "open")
      throw new Error("只能为开放 Issue 保存类型和验收计划");
    const plan = issuePlanSchema.parse(value);
    this.store.put("issues", {
      ...issue,
      plan,
      workflow: {
        stage:
          plan.decision === "accepted"
            ? "accepted"
            : plan.decision === "deferred"
              ? "deferred"
              : "decision",
        reason: plan.goal || "等待明确目标与验收条件",
        updatedAt: new Date().toISOString(),
      },
    });
    this.store.audit(
      "item.plan",
      `${issueId}: ${plan.category} · ${plan.decision}`,
    );
  }
  askInformation(
    issueId: string,
    questions: string[],
    waitingFor: string,
    askedAt?: string,
  ): { id: string; reused: boolean } {
    const issue = this.store.get<Issue>("issues", issueId);
    if (!issue || issue.type !== "issue" || issue.state !== "open")
      throw new Error("只能为开放 Issue 记录追问");
    const values = [
      ...new Set(
        z
          .array(z.string().trim().min(1).max(1000))
          .min(1)
          .max(20)
          .parse(questions),
      ),
    ];
    const login = z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/)
      .parse(waitingFor);
    const requests = issue.informationRequests ?? [];
    const previous = requests.find((request) =>
      sameQuestions(request, values, login),
    );
    if (previous) return { id: previous.id, reused: true };
    const pending = requests.filter(
      (r) =>
        ["asked", "reply_received"].includes(r.state) &&
        r.waitingFor.toLowerCase() === login.toLowerCase(),
    );
    const asked = new Set(
      pending.flatMap((r) =>
        r.questions.map((q) => q.trim().replace(/\s+/g, " ").toLowerCase()),
      ),
    );
    const fresh = values.filter(
      (q) => !asked.has(q.trim().replace(/\s+/g, " ").toLowerCase()),
    );
    if (!fresh.length) return { id: pending[0].id, reused: true };
    if (requests.length >= 100)
      throw new Error("追问记录已达到 100 条，请导出历史后整理事项。");
    const now = new Date().toISOString(),
      id = randomUUID();
    const time = askedAt ? z.string().datetime().parse(askedAt) : now;
    if (Date.parse(time) > Date.now() + 1000)
      throw new Error("实际提问时间不能在未来");
    this.store.put("issues", {
      ...issue,
      informationRequests: [
        ...requests,
        {
          id,
          questions: fresh,
          waitingFor: login,
          askedAt: time,
          baselineComments: issue.comments,
          state: "asked",
          source: "maintainer_record",
          replies: [],
        },
      ],
      workflow: {
        stage: "needs_info",
        reason: `等待 ${login} 补充 ${fresh.length} 项信息`,
        updatedAt: now,
      },
    });
    this.store.audit(
      "information.asked",
      `${issueId}: 已记录向 ${login} 提出的 ${fresh.length} 项追问；未发送外部消息`,
    );
    return { id, reused: false };
  }
  finishInformation(
    issueId: string,
    requestId: string,
    state: "fulfilled" | "dismissed",
  ): void {
    const issue = this.store.get<Issue>("issues", issueId);
    const request = issue?.informationRequests?.find((r) => r.id === requestId);
    if (
      !issue ||
      !request ||
      !["asked", "reply_received"].includes(request.state)
    )
      throw new Error("没有可核对的追问记录");
    const requests = issue.informationRequests!.map((r) =>
      r.id === requestId ? { ...r, state } : r,
    );
    this.store.put("issues", {
      ...issue,
      informationRequests: requests,
      workflow: {
        stage: requests.some((r) =>
          ["asked", "reply_received"].includes(r.state),
        )
          ? "needs_info"
          : "decision",
        reason: "追问已由维护者核对，请依据当前证据决定下一步。",
        updatedAt: new Date().toISOString(),
      },
    });
    this.store.audit(
      "information.finished",
      `${issueId}: ${requestId} · ${state}`,
    );
  }
  followup(id: string, value: import("./types.ts").FindingFollowup): void {
    const job = this.job(id);
    if (
      job.artifact?.stage !== "review" ||
      !["completed", "awaiting_review", "approved"].includes(job.status) ||
      job.publications?.review?.status === "published" ||
      job.revision !==
        revision(
          this.store.get<Issue>("issues", job.issueId)!,
          this.repo(job.repoId),
          job.kind,
        )
    )
      throw new Error("当前审查不可修改复核结论");
    const values = [
      ...(job.findingFollowups ?? []).filter(
        (item) =>
          item.sourceJobId !== value.sourceJobId ||
          item.findingId !== value.findingId,
      ),
      value,
    ];
    const followups = reviewFollowups(job, values);
    this.saveJob({
      ...job,
      findingFollowups: followups,
      status: "awaiting_review",
    });
    this.store.audit(
      "finding.followup",
      `${value.sourceJobId}/${value.findingId}: ${value.status} · ${value.evidence}`,
      id,
    );
  }
  async syncThreads(id: string): Promise<void> {
    const job = this.job(id);
    if (job.kind !== "review" || job.issueSnapshot.type !== "pr")
      throw new Error("只有 PR 审查可以同步讨论串");
    const snapshot = await this.github.threads(
      this.repo(job.repoId),
      job.issueSnapshot.number,
    );
    this.saveJob({ ...this.job(id), reviewThreads: snapshot });
    this.store.audit(
      "threads.synced",
      `只读同步 ${snapshot.threads.length} 条讨论串${snapshot.partial ? "（部分覆盖）" : ""}`,
      id,
    );
  }
  linkThread(id: string, findingId: string, threadId: string): void {
    const job = this.job(id);
    if (
      job.artifact?.stage !== "review" ||
      !job.artifact.findings.some((f) => f.id === findingId) ||
      !job.reviewThreads?.threads.some((t) => t.id === threadId)
    )
      throw new Error("发现或讨论串不存在，请先同步");
    if (
      job.revision !==
        revision(
          this.store.get<Issue>("issues", job.issueId)!,
          this.repo(job.repoId),
          job.kind,
        ) ||
      job.reviewThreads.headSha !== job.prContext?.headSha ||
      job.reviewThreads.baseSha !== job.prContext?.baseSha
    )
      throw new Error("请先审查并同步当前版本，再关联讨论串");
    const links = Object.fromEntries(
      Object.entries(job.findingThreadLinks ?? {}).filter(
        ([id, thread]) => id !== findingId && thread !== threadId,
      ),
    );
    this.saveJob({
      ...job,
      findingThreadLinks: { ...links, [findingId]: threadId },
    });
  }
  private threadBinding(
    job: Job,
    thread: import("./types.ts").ReviewThread,
    resolved: boolean,
    snapshot: import("./types.ts").ThreadSnapshot,
  ): string {
    return patchHash(
      JSON.stringify([
        job.id,
        job.revision,
        job.status,
        job.findingDecisions,
        job.findingFollowups,
        job.findingThreadLinks,
        snapshot.headSha,
        snapshot.baseSha,
        thread,
        resolved,
      ]),
    );
  }
  async previewThread(id: string, threadId: string, resolved: boolean) {
    const job = this.job(id),
      issue = this.store.get<Issue>("issues", job.issueId)!;
    if (
      job.kind !== "review" ||
      issue.type !== "pr" ||
      !job.prContext ||
      !["completed", "awaiting_review", "approved"].includes(job.status) ||
      job.revision !== revision(issue, this.repo(job.repoId), job.kind)
    )
      throw new Error("请对当前版本完成 PR 审查后再操作讨论串");
    const snapshot = await this.github.threads(
      this.repo(job.repoId),
      issue.number,
    );
    if (
      snapshot.headSha !== job.prContext.headSha ||
      snapshot.baseSha !== job.prContext.baseSha
    )
      throw new Error("PR 版本已变化，请重新审查");
    const current = this.job(id);
    if (
      current.revision !==
        revision(
          this.store.get<Issue>("issues", job.issueId)!,
          this.repo(job.repoId),
          job.kind,
        ) ||
      JSON.stringify(current) !== JSON.stringify(job)
    )
      throw new Error("核对期间审查已变化，请重新预览");
    const thread = snapshot.threads.find((thread) => thread.id === threadId);
    if (!thread) throw new Error("此讨论串不属于当前 PR 的可见范围");
    if (
      thread.isResolved !== resolved &&
      !(resolved ? thread.viewerCanResolve : thread.viewerCanUnresolve)
    )
      throw new Error("当前 GitHub 身份无权修改此讨论串");
    return {
      thread,
      headSha: snapshot.headSha,
      baseSha: snapshot.baseSha,
      resolved,
      stamp: this.threadBinding(current, thread, resolved, snapshot),
    };
  }
  async updateThread(
    id: string,
    threadId: string,
    resolved: boolean,
    stamp: string,
  ): Promise<void> {
    const key = `thread:${threadId}`;
    if (this.publishing.has(key)) throw new Error("讨论串正在更新，请等待");
    this.publishing.add(key);
    try {
      const preview = await this.previewThread(id, threadId, resolved);
      if (preview.stamp !== stamp)
        throw new Error("讨论串或审查已变化，请重新预览后确认");
      const assertCurrent = () => {
        const current = this.job(id),
          issue = this.store.get<Issue>("issues", current.issueId)!;
        if (
          current.revision !==
            revision(issue, this.repo(current.repoId), current.kind) ||
          current.prContext?.headSha !== preview.headSha ||
          current.prContext?.baseSha !== preview.baseSha ||
          this.threadBinding(current, preview.thread, resolved, {
            headSha: preview.headSha,
            baseSha: preview.baseSha,
            threads: [],
            partial: false,
            syncedAt: "",
          }) !== stamp
        )
          throw new Error("确认期间审查已变化，未修改远端讨论串");
      };
      assertCurrent();
      if (preview.thread.isResolved !== resolved)
        await this.github.setThreadResolved(threadId, resolved, assertCurrent);
      this.store.audit(
        "thread.updated",
        `${threadId}: ${resolved ? "resolved" : "unresolved"} · GitHub 已确认`,
        id,
      );
      await this.syncThreads(id);
    } finally {
      this.publishing.delete(key);
    }
  }
  executionOutput(id: string, recordId: string) {
    return readExecutionLog(this.dataDir, this.job(id), recordId);
  }
  async previewPublish(id: string, action: PublishAction) {
    const job = this.job(id);
    return previewPublication(
      this.store,
      job,
      this.repo(job.repoId),
      action,
      this.github,
    );
  }
  async publish(
    id: string,
    action: PublishAction,
    expectedPreview?: string,
  ): Promise<string[]> {
    if (this.publishing.has(id))
      throw new Error("此任务正在发布，请等待当前操作完成");
    const targetJob = this.job(id);
    const target = `${targetJob.repoId}:${targetJob.prContext?.headRef ?? targetJob.branch ?? targetJob.issueId}`;
    if (this.publishing.has(target))
      throw new Error("同一目标分支正在发布，请稍后重试");
    this.publishing.add(id);
    this.publishing.add(target);
    try {
      const job = this.job(id);
      return await publish(
        this.store,
        job,
        this.repo(job.repoId),
        action,
        this.github,
        undefined,
        expectedPreview,
      );
    } finally {
      this.publishing.delete(id);
      this.publishing.delete(target);
    }
  }
  updatePolicy(repoId: string, input: unknown): void {
    const policy = z
      .object({
        syncLimit: z.number().int().min(0).max(1000000).optional(),
        autoPreflight: z.boolean().optional(),
        autoTriage: z.boolean(),
        syncIntervalMinutes: z.number().int().min(0).max(1440),
        timeoutMs: z.number().int().min(1000).max(1800000),
        maxTokens: z.number().int().min(500).max(32000),
      })
      .parse(input);
    this.store.put("repos", { ...this.repo(repoId), policy });
    this.store.audit("repo.policy", `${repoId}: 更新仓库策略`);
  }
  updateSettings(input: unknown): void {
    const settings = settingsSchema.parse(input);
    this.store.put("settings", { ...settings, id: "main" });
    this.store.audit("settings.updated", "更新并发、批量上限和模型配置");
    if (this.autoStart) this.pump();
  }
  private advancingGoals = false;
  private advanceGoals(): void {
    if (this.advancingGoals) return;
    this.advancingGoals = true;
    try {
      const jobs = this.store.jobs();
      for (const job of jobs) {
        if (!job.goal || job.goalPauseReason || jobs.some(child => child.sourceJobId === job.id)) continue;
        const issue = this.store.get<Issue>("issues", job.issueId);
        if (!issue) continue;
        const continuation = nextGoalStep(job, issue);
        if (continuation.pause) this.saveJob({...job,goalPauseReason:continuation.pause});
        if (continuation.next) {
          try {
            this.enqueue([job.issueId], continuation.next, {sourceJobId:job.id, instructions:job.instructions,goal:job.goal,goalId:job.goalId});
          } catch (error) {
            this.saveJob({...job,goalPauseReason:error instanceof Error ? error.message : "需要确认后才能继续"});
          }
        }
      }
    } finally { this.advancingGoals = false; }
  }
  pump(): void {
    if (this.closed || this.advancingGoals) return;
    this.advanceGoals();
    const queued = this.store.jobs().filter((j) => j.status === "queued");
    const repos = [...new Set(queued.map((j) => j.repoId))];
    const pivot = repos.indexOf(this.lastRepo);
    if (pivot >= 0) repos.push(...repos.splice(0, pivot + 1));
    const ordered: Job[] = [];
    while (queued.length)
      for (const repo of repos) {
        const i = queued.findIndex((j) => j.repoId === repo);
        if (i >= 0) ordered.push(...queued.splice(i, 1));
      }
    for (const job of ordered) {
      if (
        this.store
          .jobs()
          .some((j) => this.active.has(j.id) && j.issueId === job.issueId)
      )
        continue;
      if (this.active.size >= this.store.settings().concurrency) break;
      this.lastRepo = job.repoId;
      const controller = new AbortController();
      this.active.set(job.id, controller);
      const completion = this.execute(job, controller).finally(() => {
        this.active.delete(job.id);
        this.completions.delete(completion);
        this.pump();
      });
      this.completions.add(completion);
    }
  }
  private async execute(
    initial: Job,
    controller: AbortController,
  ): Promise<void> {
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
        await waitFor(this.prepareRepository(repo.id), controller.signal);
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
        const worktree = await prepareWorktree(repo, job, this.dataDir);
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
          const patch = await applicationPatch(
            source.worktree,
            source.baseSha,
            source.patch,
          );
          const { writeFile } = await import("node:fs/promises");
          const patchFile = join(this.dataDir, "analysis", `${job.id}.patch`);
          await mkdir(join(this.dataDir, "analysis"), { recursive: true });
          await writeFile(patchFile, patch);
          await git(job.worktree, ["apply", "--index", patchFile]);
          progress("已将来源补丁应用到新的隔离工作区");
        }
      }
      const readOnlyStage =
        ["review", "validate", "ci"].includes(job.kind) ||
        (job.issueSnapshot.organizeMode === "audit" &&
          job.kind === "investigate");
      if (job.formatOnly) {
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
            logs: import("./remote-progress.ts").ActionsLog[] = [];
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
        const artifact = output.artifact;
        const validation = validationState(artifact);
        const waiting = currentIssue.informationRequests?.some(
            (r) => r.state === "asked",
          ),
          replies = currentIssue.informationRequests?.some(
            (r) => r.state === "reply_received",
          );
        const stage = replies
          ? "decision"
          : waiting
            ? "needs_info"
            : ["answered", "deferred"].includes(
                  currentIssue.workflow?.stage ?? "",
                )
              ? currentIssue.workflow!.stage
              : validation
                ? validation.state === "passed"
                  ? "validated"
                  : "blocked"
                : artifact?.stage === "triage"
                  ? artifact.route
                  : artifact?.stage === "preflight"
                    ? artifact.readiness
                    : job.kind === "fix" || job.kind === "docs"
                      ? "review"
                      : job.kind;
        if (
          revision(currentIssue, this.repo(job.repoId), job.kind) ===
          job.revision
        )
          this.store.put("issues", {
            ...this.store.get<Issue>("issues", job.issueId)!,
            workflow: {
              stage,
              reason:
                validation?.reason ??
                artifact?.summary ??
                output.result.summary,
              updatedAt: new Date().toISOString(),
            },
          });
        this.store.audit(
          "job.completed",
          `${output.engine} · 产物已保存，未发布远端`,
          job.id,
        );
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
          status: "failed",
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
    } finally {
      clearTimeout(timer);
    }
  }
  async drain(): Promise<void> {
    while (this.completions.size)
      await Promise.allSettled([...this.completions]);
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.pollTimer);
    for (const controller of this.preparationControllers.values())
      controller.abort(new Error("服务正在关闭"));
    for (const controller of this.active.values())
      controller.abort(new Error("服务正在关闭"));
    await Promise.allSettled([
      ...this.syncs.values(),
      ...this.preparations.values(),
      ...this.profiles.values(),
    ]);
    for (const controller of this.active.values())
      controller.abort(new Error("服务正在关闭"));
    await this.drain();
    this.store.close();
  }
}

function waitFor<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
