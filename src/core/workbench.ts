import packageInfo from "../../package.json" with { type: "json" };
import { IssueService } from "../application/issues.ts";
import { ProcessingService } from "../application/processing.ts";
import { PublicationService } from "../application/publication.ts";
import { RepositoryService } from "../application/repositories.ts";
import { ReviewService } from "../application/reviews.ts";
import type { EnqueueOptions, ServiceDependencies } from "../application/service.ts";
import { TaskService } from "../application/tasks.ts";
import { TrackingService } from "../application/tracking.ts";
import { WorkspaceService } from "../application/workspaces.ts";
import { Scheduler } from "../execution/scheduler.ts";
import { StageWorker } from "../execution/stage-worker.ts";
import { WorkspaceManager } from "../infrastructure/git/workspace-manager.ts";
import { availableActions } from "../workflow/actions.ts";
import type { FindingDecision } from "./artifacts.ts";
import type { DetailSection } from "./github-details.ts";
import { GitHub } from "./github.ts";
import { Orchestration } from "./orchestration.ts";
import type { OrganizeMode } from "./organize.ts";
import type { PublishAction } from "./publish.ts";
import { revision } from "./revision.ts";
import { Store } from "./store.ts";
import type { GlobalSettingsSnapshot, HostModelCatalog, HostStatus, Issue, Job, JobKind, Runner, Snapshot } from "./types.ts";
import { settingsSchema } from "../application/tasks.ts";
import { assertCatalogChoice } from "./models.ts";
export { revision } from "./revision.ts";
/** Compatibility facade. Business rules live in the composed services. */
export class Workbench {
  private repositories: RepositoryService;
  private tracking: TrackingService;
  private issuesService: IssueService;
  private tasks: TaskService;
  private reviews: ReviewService;
  private publication: PublicationService;
  private worker: StageWorker;
  private scheduler: Scheduler;
  readonly processing: ProcessingService;
  readonly workspaces: WorkspaceService;
  readonly orchestration: Orchestration;
  constructor(
    public store: Store,
    private dataDir: string,
    private nativeRunner?: Runner,
    private github = new GitHub(),
    private autoStart = true,
    private hostStatus?: () => HostStatus,
    private hostModels?: () => Promise<HostModelCatalog>,
  ) {
    this.processing = new ProcessingService(store);
    this.orchestration = new Orchestration(this);
    const deps: ServiceDependencies = {
      store,
      dataDir,
      nativeRunner,
      github,
      autoStart,
      hostStatus,
      publicationLocks: new Set(),
      workspaces: new WorkspaceManager(store, dataDir),
    };
    this.workspaces = new WorkspaceService(deps);
    this.scheduler = new Scheduler(deps, {
      enqueue: (...args) => this.tasks.enqueue(...args),
      execute: async (job, controller) => {
        await this.worker.execute(job, controller);
        if (!this.scheduler.closed)
          this.orchestration.completed(this.store.get<Job>("jobs", job.id)!);
      },
    });
    this.tracking = new TrackingService(deps);
    this.repositories = new RepositoryService(deps, {
      enqueue: (...args) => this.tasks.enqueue(...args),
      syncRemote: (id) => this.tracking.syncRemote(id),
      isClosed: () => this.scheduler.closed,
      synced: (id) => this.orchestration.synced(id),
    });
    this.tasks = new TaskService(deps, {
      active: this.scheduler.active,
      pump: () => this.scheduler.pump(),
      enqueue: (...args) => this.enqueue(...args),
    });
    this.issuesService = new IssueService(deps, (...args) =>
      this.tasks.enqueue(...args),
    );
    this.reviews = new ReviewService(deps);
    this.publication = new PublicationService(deps);
    this.publication.recoverFollowups();
    this.worker = new StageWorker(deps, {
      prepareRepository: (id) => this.prepareRepository(id),
      understand: (repo, signal) => this.repositories.understand(repo, signal),
    });
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
      queueMicrotask(() => {
        this.orchestration.reconcile();
        this.pump();
      });
      this.repositories.start();
    }
  }
  discover(paths: string[]) {
    return this.repositories.discover(paths);
  }
  poll() {
    return this.repositories.poll();
  }
  syncMany(names: string[]) {
    return this.repositories.syncMany(names);
  }
  sync(fullName: string) {
    return this.repositories.sync(fullName);
  }
  bindPath(repoId: string, localPath: string) {
    return this.repositories.bindPath(repoId, localPath);
  }
  async prepareRepository(repoId: string) {
    await this.repositories.prepareRepository(repoId);
    this.processing.environmentReady(repoId);
  }
  updatePolicy(repoId: string, input: unknown) {
    return this.repositories.updatePolicy(repoId, input);
  }
  syncRemote(issueId: string) {
    return this.tracking.syncRemote(issueId);
  }
  syncActions(issueId: string, targetNumber?: number) {
    return this.tracking.syncActions(issueId, targetNumber);
  }
  actionsLog(issueId: string, jobId: number) {
    return this.tracking.actionsLog(issueId, jobId);
  }
  itemDetail(id: string, section: DetailSection, page = 1) {
    return this.tracking.itemDetail(id, section, page);
  }
  githubConnection() {
    return this.tracking.githubConnection();
  }
  organize(
    repoId: string,
    mode: OrganizeMode,
    issueId?: string,
    instructions = "",
  ) {
    return this.issuesService.organize(repoId, mode, issueId, instructions);
  }
  decide(issueId: string, stage: string, reason: string) {
    return this.issuesService.decide(issueId, stage, reason);
  }
  savePlan(issueId: string, value: unknown) {
    return this.issuesService.savePlan(issueId, value);
  }
  askInformation(
    issueId: string,
    questions: string[],
    waitingFor: string,
    askedAt?: string,
  ) {
    return this.issuesService.askInformation(
      issueId,
      questions,
      waitingFor,
      askedAt,
    );
  }
  finishInformation(
    issueId: string,
    requestId: string,
    state: "fulfilled" | "dismissed",
  ) {
    return this.issuesService.finishInformation(issueId, requestId, state);
  }
  enqueue(
    issueIds: string[],
    kind: JobKind,
    options: EnqueueOptions = {},
  ) {
    return this.tasks.enqueue(issueIds, kind, options);
  }
  cancel(id: string) {
    this.tasks.cancel(id);
    this.orchestration.completed(this.store.get<Job>("jobs", id)!);
  }
  rerun(id: string) {
    return this.tasks.rerun(id);
  }
  retry(id: string) {
    const result = this.tasks.retry(id);
    this.orchestration.replacement(id, result);
    return result;
  }
  resume(id: string) {
    const job = this.store.get<Job>("jobs", id)!;

    const result = this.tasks.resume(id);
    this.orchestration.replacement(id, result);
    return result;
  }
  async review(id: string, decision: "approve" | "reject", note: string) {
    const result = await this.tasks.review(id, decision, note);
    this.orchestration.reviewDecision(this.store.get<Job>("jobs", id)!, decision);
    return result;
  }
  finding(id: string, findingId: string, decision: FindingDecision) {
    return this.tasks.finding(id, findingId, decision);
  }
  findings(id: string, findingIds: string[], decision: FindingDecision) {
    return this.tasks.findings(id, findingIds, decision);
  }
  updateSettings(input: unknown, expectedRevision?: string) {
    return this.tasks.updateSettings(input, expectedRevision);
  }
  followup(id: string, value: import("./types.ts").FindingFollowup) {
    return this.reviews.followup(id, value);
  }
  syncThreads(id: string) {
    return this.reviews.syncThreads(id);
  }
  linkThread(id: string, findingId: string, threadId: string) {
    return this.reviews.linkThread(id, findingId, threadId);
  }
  previewThread(id: string, threadId: string, resolved: boolean) {
    return this.reviews.previewThread(id, threadId, resolved);
  }
  updateThread(id: string, threadId: string, resolved: boolean, stamp: string) {
    return this.reviews.updateThread(id, threadId, resolved, stamp);
  }
  executionOutput(id: string, recordId: string) {
    return this.publication.executionOutput(id, recordId);
  }
  previewPublish(id: string, action: PublishAction) {
    return this.publication.previewPublish(id, action);
  }
  async publish(id: string, action: PublishAction, expectedPreview?: string) {
    const urls = await this.publication.publish(id, action, expectedPreview);
    const job = this.store.get<Job>("jobs", id)!;
    const run = this.store.get<Issue>("issues", job.issueId)?.orchestration?.run;
    if (
      action === "review" &&
      job.artifact?.stage === "review" &&
      job.artifact.findings.length &&
      run?.id === job.workflowRunId &&
      run?.currentJobId === job.id &&
      run?.status === "review"
    ) this.orchestration.waitAuthor(id);
    return urls;
  }
  pump() {
    return this.scheduler.pump();
  }
  drain() {
    return this.scheduler.drain();
  }
  globalSettings(): GlobalSettingsSnapshot {
    const host = this.hostStatus?.();
    const settings = this.store.settings();
    const defaultModel = settings.nativeDefaultModel;
    const modelAvailable = defaultModel
      ? !!host?.providers?.some(p => p.id === defaultModel.provider)
      : !!host?.adapterRegistered;
    return {
      settings,
      revision: this.tasks.settingsRevision(),
      capabilities: {
        harness: !!this.nativeRunner,
        model: this.nativeRunner ? modelAvailable : !!(process.env.MAINTAINER_API_KEY || process.env.DEEPSEEK_API_KEY),
        github: !!process.env.GITHUB_TOKEN,
        modelName: defaultModel?.model ?? host?.model ?? settings.model,
        baseUrl: process.env.MAINTAINER_BASE_URL ?? "https://api.deepseek.com",
        running: this.scheduler.active.size,
        ...(host ? { host } : {}),
      },
    };
  }
  async models(): Promise<HostModelCatalog> {
    if (!this.hostModels) throw new Error("模型列表需在 Harness 原生环境中读取");
    const catalog = await this.hostModels();
    return { ...catalog, failures: catalog.failures.map(f => ({ ...f, message: "模型目录读取失败，请在 Harness 模型设置中检查后重试" })) };
  }
  async validateModelSettings(input: unknown): Promise<void> {
    const settings = settingsSchema.parse(input);
    if (!this.nativeRunner) return;
    const choices = [settings.nativeDefaultModel, ...Object.values(settings.stageModels ?? {})].filter((value): value is NonNullable<typeof value> => value !== undefined);
    if (!choices.length) return;
    const catalog = await this.models();
    for (const choice of choices) assertCatalogChoice(choice, catalog);
  }
  snapshot(): Snapshot {
    const global = this.globalSettings();
    const issues = this.store.issues(),
      repositories = this.store.repos();
    const items = new Map(issues.map((issue) => [issue.id, issue]));
    const repos = new Map(repositories.map((repo) => [repo.id, repo]));
    const jobs: Job[] = this.store
      .jobs()
      .reverse()
      .map((job) => {
        const issue = items.get(job.issueId),
          repo = repos.get(job.repoId);
        return {
          ...job,
          artifactState:
            issue &&
            repo &&
            job.revision === revision(issue, repo, job.kind) &&
            (!job.caseId || job.caseId === issue.processing?.id)
              ? "current"
              : "stale",
        };
      });
    const histories = new Map<string, Job[]>();
    for (const job of jobs)
      histories.set(job.issueId, [...(histories.get(job.issueId) ?? []), job]);
    return {
      repos: repositories.filter(
        (repo) =>
          repo.discoveryActive !== false ||
          histories.has(repo.id) ||
          issues.some((issue) => issue.repoId === repo.id) ||
          jobs.some((job) => job.repoId === repo.id),
      ),
      issues: issues.map((issue) => ({
        ...issue,
        orchestrationView: this.orchestration.view(issue),
        processingSuggestion: this.orchestration.view(issue),
        actionsAvailable: availableActions(
          issue,
          histories.get(issue.id)?.[0],
          histories.get(issue.id),
        ),
      })),
      jobs: jobs.map((job) => ({
        ...job,
        actionsAvailable: items.has(job.issueId)
          ? availableActions(
              items.get(job.issueId)!,
              job,
              histories.get(job.issueId),
            )
          : undefined,
      })),
      audit: this.store.audits(),
      settings: global.settings,
      capabilities: global.capabilities,
      version: packageInfo.version,
    };
  }
  saveJob(job: Job): void {
    this.store.put("jobs", { ...job, updatedAt: new Date().toISOString() });
  }
  async close(): Promise<void> {
    this.scheduler.stop();
    await Promise.allSettled([
      this.repositories.close(),
      this.tracking.close(),
    ]);
    await this.scheduler.drain();
    this.store.close();
  }
}
