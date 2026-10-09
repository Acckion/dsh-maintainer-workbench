import {
  ServiceBase,
  type Enqueue,
  type ServiceDependencies,
} from "../application/service.ts";
import { revision } from "../core/revision.ts";
import { type Issue, type Job, type Repo } from "../core/types.ts";
import { nextGoalStep } from "../workflow/continuation.ts";

export class Scheduler extends ServiceBase {
  readonly active = new Map<string, AbortController>();
  private completions = new Set<Promise<void>>();
  private lastRepo = "";
  private advancingGoals = false;
  closed = false;
  constructor(
    deps: ServiceDependencies,
    private hooks: {
      enqueue: Enqueue;
      execute: (job: Job, controller: AbortController) => Promise<void>;
    },
  ) {
    super(deps);
  }
  private enqueue: Enqueue = (...args) => this.hooks.enqueue(...args);
  private execute = (job: Job, controller: AbortController) =>
    this.hooks.execute(job, controller);
  stop() {
    this.closed = true;
    for (const c of this.active.values()) c.abort(new Error("服务正在关闭"));
  }
  private advanceGoals(): void {
    if (this.advancingGoals) return;
    this.advancingGoals = true;
    try {
      const jobs = this.store.jobs();
      for (const job of jobs) {
        if (
          !job.goal ||
          job.goalPauseReason ||
          jobs.some((child) => child.sourceJobId === job.id)
        )
          continue;
        const issue = this.store.get<Issue>("issues", job.issueId);
        if (!issue) continue;
        const repo = this.store.get<Repo>("repos", job.repoId);
        const currentJob = {
          ...job,
          artifactState:
            repo &&
            job.revision === revision(issue, repo, job.kind) &&
            (!job.caseId || job.caseId === issue.processing?.id)
              ? "current"
              : "stale",
        };
        const continuation = nextGoalStep(currentJob, issue);
        if (continuation.pause)
          this.saveJob({ ...job, goalPauseReason: continuation.pause });
        if (continuation.next) {
          try {
            this.enqueue([job.issueId], continuation.next, {
              sourceJobId: job.id,
              instructions: job.instructions,
              goal: job.goal,
              goalId: job.goalId,
            });
          } catch (error) {
            this.saveJob({
              ...job,
              goalPauseReason:
                error instanceof Error ? error.message : "需要确认后才能继续",
            });
          }
        }
      }
    } finally {
      this.advancingGoals = false;
    }
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
  async drain(): Promise<void> {
    while (this.completions.size)
      await Promise.allSettled([...this.completions]);
  }
}
