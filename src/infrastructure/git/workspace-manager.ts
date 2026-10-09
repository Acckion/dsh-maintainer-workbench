import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { collectPatch, git, prepareWorktree } from "../../core/git.ts";
import type { Store } from "../../core/store.ts";
import type { Job, Repo } from "../../core/types.ts";
import type {
  ChangeSnapshot,
  WorkspaceRecord,
} from "../../domain/workspaces.ts";

/** Workspaces belong to runs; immutable snapshots, rather than mutable directories, cross stages. */
export class WorkspaceManager {
  constructor(
    private store: Store,
    private dataDir: string,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS change_snapshots(id TEXT PRIMARY KEY, runId TEXT UNIQUE NOT NULL, data TEXT NOT NULL);`);
    // A host Agent may outlive the worker: do not silently reuse its write directory.
    for (const record of this.records())
      if (["in_use", "preparing", "ready", "cleaning"].includes(record.status))
        this.save({ ...record, status: "interrupted" });
    // Register known legacy task directories, without traversing or deleting foreign workspaces.
    for (const job of store.jobs()) {
      if (
        !job.worktree ||
        !job.branch?.startsWith("maintainer/") ||
        this.records().some((r) => resolve(r.path) === resolve(job.worktree!))
      )
        continue;
      const id = basename(job.worktree);
      if (
        !/^[a-zA-Z0-9_.-]+$/.test(id) ||
        resolve(job.worktree) !== resolve(dataDir, "worktrees", id)
      )
        continue;
      this.save({
        id,
        repositoryId: job.repoId,
        caseId: job.caseId,
        ownerRunId: job.id,
        path: resolve(job.worktree),
        branch: job.branch,
        checkoutSha: job.baseSha,
        purpose: job.kind,
        status: ["running", "queued"].includes(job.status)
          ? "interrupted"
          : "retained",
        updatedAt: new Date().toISOString(),
      });
    }
  }
  records(): WorkspaceRecord[] {
    return this.store.db
      .prepare("SELECT data FROM workspaces ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  setStatus(id: string, status: WorkspaceRecord["status"]): void {
    const record = this.records().find((w) => w.id === id);
    if (!record) throw new Error("工作区不存在");
    this.save({
      ...record,
      status,
      ...(status === "cleaning"
        ? { cleanupStartedAt: new Date().toISOString() }
        : {}),
    });
  }
  private save(record: WorkspaceRecord): void {
    const updated = { ...record, updatedAt: new Date().toISOString() };
    this.store.db
      .prepare(
        "INSERT INTO workspaces VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(record.id, record.path, JSON.stringify(updated));
  }
  async prepare(
    repo: Repo,
    job: Job,
  ): Promise<{ path: string; branch: string }> {
    if (!/^[a-zA-Z0-9_.-]+$/.test(job.id))
      throw new Error("无效的任务工作区标识");
    const record: WorkspaceRecord = {
      id: job.id,
      ownerRunId: job.id,
      repositoryId: repo.id,
      caseId: job.caseId,
      path: join(resolve(this.dataDir, "worktrees"), job.id),
      branch: `maintainer/${job.kind}-${job.issueSnapshot.number}-${job.id}`,
      checkoutSha: job.baseSha,
      purpose: job.kind,
      status: "preparing",
      updatedAt: new Date().toISOString(),
    };
    if (this.records().some((r) => r.id === record.id))
      throw new Error("工作区已存在，不能覆盖已有执行尝试");
    this.save(record);
    try {
      const workspace = await prepareWorktree(repo, job, this.dataDir);
      this.save({ ...record, ...workspace, status: "in_use" });
      return workspace;
    } catch (error) {
      this.save({ ...record, status: "interrupted" });
      throw error;
    }
  }
  async acquireFormatRecovery(job: Job): Promise<void> {
    if (!job.worktree) return;
    const canonical = await realpath(job.worktree);
    const record = this.records().find((r) => resolve(r.path) === canonical);
    if (!record) throw new Error("输出恢复工作区缺少所有权记录，请重新派发");
    if (record.status !== "retained")
      throw new Error("输出恢复工作区仍被占用或执行状态不明确");
    this.save({ ...record, ownerRunId: job.id, status: "in_use" });
  }
  release(job: Job): void {
    const record = this.records().find((r) => r.ownerRunId === job.id);
    if (record) this.save({ ...record, status: "retained" });
  }
  snapshot(runId: string): ChangeSnapshot | undefined {
    const row = this.store.db
      .prepare("SELECT data FROM change_snapshots WHERE runId=?")
      .get(runId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  async freeze(job: Job, patch: string): Promise<ChangeSnapshot | undefined> {
    if (!patch || !job.worktree) return;
    const patchHash = createHash("sha256").update(patch).digest("hex");
    const previous = this.snapshot(job.id);
    if (previous) {
      if (previous.patchHash !== patchHash) throw new Error("变更快照不可修改");
      return previous;
    }
    const fullPatch = await collectPatch(job.worktree, job.baseSha, true);
    const identity = fullPatch.includes("GIT binary patch\n")
      ? fullPatch
      : fullPatch.trimEnd();
    if (identity !== patch) throw new Error("冻结时补丁已变化");
    if ((await git(job.worktree, ["rev-parse", "HEAD"])) !== job.baseSha)
      throw new Error("冻结时工作区 HEAD 已变化");
    const directory = join(this.dataDir, "artifacts", job.id);
    await mkdir(directory, { recursive: true });
    const patchPath = join(directory, `${patchHash}.patch`),
      temporary = patchPath + ".tmp";
    await writeFile(temporary, fullPatch);
    await rename(temporary, patchPath);
    const snapshot: ChangeSnapshot = {
      id: `${job.id}:${patchHash}`,
      sourceRunId: job.id,
      caseId: job.caseId,
      repositoryId: job.repoId,
      workItemId: job.issueId,
      checkoutSha: job.baseSha,
      patchHash,
      resultTreeHash: await git(job.worktree, ["write-tree"]),
      patchPath,
      parentId: job.sourceJobId
        ? this.snapshot(job.sourceJobId)?.id
        : undefined,
      createdAt: new Date().toISOString(),
    };
    this.store.db
      .prepare("INSERT INTO change_snapshots VALUES(?,?,?)")
      .run(snapshot.id, job.id, JSON.stringify(snapshot));
    return snapshot;
  }
  async patchFor(job: Job): Promise<string | undefined> {
    let snapshot = this.snapshot(job.id);
    if (!snapshot && job.patch && job.worktree) {
      const owner = this.records().find(
        (r) => resolve(r.path) === resolve(job.worktree!),
      );
      if (!owner || owner.status !== "retained")
        throw new Error("旧补丁工作区尚未确认释放，请先核对并恢复工作区所有权");
      snapshot = await this.freeze(job, job.patch);
      this.store.audit(
        "snapshot.migrated",
        "旧补丁已核对并迁移为不可变快照",
        job.id,
      );
    }
    if (!snapshot) return;
    if (
      snapshot.checkoutSha !== job.baseSha ||
      snapshot.patchHash !==
        createHash("sha256")
          .update(job.patch ?? "")
          .digest("hex")
    )
      throw new Error("交接补丁与冻结快照不一致");
    const patch = await readFile(snapshot.patchPath, "utf8");
    const identity = patch.includes("GIT binary patch\n")
      ? patch
      : patch.trimEnd();
    if (
      createHash("sha256").update(identity).digest("hex") !== snapshot.patchHash
    )
      throw new Error("冻结补丁文件已变化");
    return patch;
  }
  async verifyTree(job: Job, sourceRunId: string): Promise<void> {
    const snapshot = this.snapshot(sourceRunId);
    if (
      snapshot &&
      job.worktree &&
      (await git(job.worktree, ["write-tree"])) !== snapshot.resultTreeHash
    )
      throw new Error("重建工作区与来源变更不是同一文件树");
  }
}
