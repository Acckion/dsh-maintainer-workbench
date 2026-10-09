import { z } from "zod";
import {
  ServiceBase,
  type Enqueue,
  type ServiceDependencies,
} from "../application/service.ts";
import { waitFor } from "../core/abort.ts";
import { prepareManagedCheckout, validateCheckout } from "../core/git.ts";
import { receiveReplies } from "../core/issue-flow.ts";
import { localRepositoryProfile } from "../core/repository-context.ts";
import { revision } from "../core/revision.ts";
import { type Issue, type Repo } from "../core/types.ts";
import { discoverWorkspace } from "../core/workspace-discovery.ts";
import { normalizeRepoName } from "../core/repo-name.ts";

export class RepositoryService extends ServiceBase {
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private preparationControllers = new Map<string, AbortController>();
  private preparations = new Map<string, Promise<void>>();
  private profiles = new Map<
    string,
    Promise<import("../core/types.ts").RepositoryProfile>
  >();
  private syncs = new Map<string, Promise<void>>();
  constructor(
    deps: ServiceDependencies,
    private hooks: {
      enqueue: Enqueue;
      syncRemote: (id: string) => Promise<void>;
      isClosed: () => boolean;
      synced: (repoId: string) => void;
    },
  ) {
    super(deps);
  }
  private get closed() {
    return this.hooks.isClosed();
  }
  private enqueue: Enqueue = (...args) => this.hooks.enqueue(...args);
  private syncRemote = (id: string) => this.hooks.syncRemote(id);
  start() {
    this.pollTimer = setInterval(() => void this.poll(), 60000);
    this.pollTimer.unref();
  }
  async close() {
    clearInterval(this.pollTimer);
    for (const c of this.preparationControllers.values())
      c.abort(new Error("服务正在关闭"));
    await Promise.allSettled([
      ...this.syncs.values(),
      ...this.preparations.values(),
      ...this.profiles.values(),
    ]);
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
          this.hooks.synced(repo.id);
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
          !["answered", "deferred"].includes(i.processing?.phase ?? "") &&
          !["running", "paused", "waiting_author"].includes(i.orchestration?.run?.status ?? "") &&
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
  async syncMany(names: string[]) {
    const results: { fullName: string; repoId?: string; error?: string }[] = [];
    const seen = new Set<string>();
    const pending: { index: number; fullName: string }[] = [];
    let synced = 0;
    for (const raw of names) {
      const fullName = normalizeRepoName(raw);
      if (!fullName) {
        const key = `invalid:${raw.trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          fullName: raw.trim() || raw,
          error: "不是有效的 owner/repository 或 GitHub 仓库地址",
        });
        continue;
      }
      if (seen.has(fullName)) continue;
      seen.add(fullName);
      if (synced >= 20) {
        results.push({ fullName, error: "一次最多连接 20 个仓库，请分批" });
        continue;
      }
      synced += 1;
      pending.push({ index: results.length, fullName });
      results.push({ fullName });
    }
    for (const { index, fullName } of pending) {
      try {
        await this.sync(fullName);
        results[index] = {
          fullName,
          repoId: this.findRepoForRemote(fullName)?.id,
        };
      } catch (error) {
        results[index] = {
          fullName,
          error: error instanceof Error ? error.message : "同步失败",
        };
      }
    }
    if (!results.length)
      throw new Error(
        "请输入 1–20 个有效的 owner/repository 或 GitHub 仓库地址",
      );
    return { results };
  }
  private findRepoForRemote(fullName: string): Repo | undefined {
    const target = fullName.toLowerCase();
    return this.store
      .repos()
      .find((r) => (r.githubName ?? r.fullName).toLowerCase() === target);
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
    const configured =
      this.store
        .repos()
        .find(
          (r) =>
            (r.githubName ?? r.fullName).toLowerCase() === fullName.toLowerCase(),
        ) ??
      this.store
        .repos()
        .find((r) =>
          (r.remoteCandidates ?? []).some(
            (c) => c.toLowerCase() === fullName.toLowerCase(),
          ),
        );
    const { repo, issues } = await this.github.sync(
      fullName,
      configured?.policy?.syncLimit ?? this.store.settings().syncLimit ?? 1000,
    );
    const target = repo.fullName.toLowerCase();
    const prev =
      this.store
        .repos()
        .find(
          (r) =>
            r.discovered &&
            (r.githubName?.toLowerCase() === target ||
              (!r.githubName &&
                (r.remoteCandidates ?? []).some(
                  (c) => c.toLowerCase() === target,
                ))),
        ) ?? this.store.get<Repo>("repos", repo.id);
    if (prev?.discovered) {
      const remoteId = repo.id;
      Object.assign(repo, {
        id: prev.id,
        mode: "local",
        discovered: true,
        localKind: prev.localKind,
        workspacePaths: prev.workspacePaths,
        githubName: prev.githubName ?? repo.fullName,
        remoteCandidates: prev.remoteCandidates,
        localBranch: prev.localBranch,
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
        replies: import("../core/types.ts").InformationRequest["replies"];
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
        this.store.put("issues", {
          ...issue,
          informationRequests,
          orchestration: old?.orchestration,
          linkedPullRequests: old?.linkedPullRequests,
          remotePRs: old?.remotePRs,
          remoteWarning: old?.remoteWarning,
          actions: old?.actions,
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
    this.hooks.synced(repo.id);
    this.autoTriage(repo.id);
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
  async understand(repo: Repo, signal: AbortSignal) {
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
  updatePolicy(repoId: string, input: unknown): void {
    const policy = z
      .object({
        syncLimit: z.number().int().min(0).max(1000000).optional(),
        autoPreflight: z.boolean().optional(),
        autoReview: z.boolean().optional(),
        autoTriage: z.boolean(),
        syncIntervalMinutes: z.number().int().min(0).max(1440),
        timeoutMs: z.number().int().min(1000).max(1800000),
        maxTokens: z.number().int().min(500).max(32000),
      })
      .parse(input);
    this.store.put("repos", { ...this.repo(repoId), policy });
    this.store.audit("repo.policy", `${repoId}: 更新仓库策略`);
  }
}
