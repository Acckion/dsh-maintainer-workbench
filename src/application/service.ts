import type { GitHub } from "../core/github.ts";
import type { Store } from "../core/store.ts";
import type { HostStatus, Job, JobKind, Repo, Runner } from "../core/types.ts";
import type { WorkspaceManager } from "../infrastructure/git/workspace-manager.ts";
export interface EnqueueOptions {
  workflowRunId?: string;
  sourceJobId?: string;
  instructions?: string;
  forceNew?: boolean;
  goal?: "resolve";
  goalId?: string;
  resumeInput?: boolean;
}
export type Enqueue = (
  ids: string[],
  kind: JobKind,
  options?: EnqueueOptions,
) => { created: string[]; reused: string[] };
export interface ServiceDependencies {
  workspaces: WorkspaceManager;
  store: Store;
  dataDir: string;
  nativeRunner?: Runner;
  github: GitHub;
  autoStart: boolean;
  hostStatus?: () => HostStatus;
  publicationLocks: Set<string>;
}
export abstract class ServiceBase {
  constructor(protected deps: ServiceDependencies) {}
  protected get store() {
    return this.deps.store;
  }
  protected get dataDir() {
    return this.deps.dataDir;
  }
  protected get nativeRunner() {
    return this.deps.nativeRunner;
  }
  protected get github() {
    return this.deps.github;
  }
  protected get autoStart() {
    return this.deps.autoStart;
  }
  protected repo(id: string): Repo {
    const value = this.store.get<Repo>("repos", id);
    if (!value) throw new Error("仓库不存在");
    return value;
  }
  protected job(id: string): Job {
    const value = this.store.get<Job>("jobs", id);
    if (!value) throw new Error("任务不存在");
    return value;
  }
  protected saveJob(job: Job) {
    this.store.put("jobs", { ...job, updatedAt: new Date().toISOString() });
  }
}
