import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { collectPatch, git } from "../core/git.ts";
import type { Repo } from "../core/types.ts";
import type { WorkspaceRecord } from "../domain/workspaces.ts";
import { repositoryLocks } from "../infrastructure/git/locks.ts";
import { inspectTree } from "../infrastructure/git/inspection.ts";
import { fingerprint } from "../workflow/remote-state.ts";
import { ServiceBase } from "./service.ts";

export interface WorkspaceInspection {
  record: WorkspaceRecord;
  headSha?: string;
  patchHash?: string;
  bytes?: number;
  cleanupReasons: string[];
  recoveryReasons: string[];
  stamp: string;
  preservedPatch: boolean;
  removalCompleted?: boolean;
}
/** Explicit lifecycle operations. Cleanup keeps branch refs, snapshots and all execution evidence. */
export class WorkspaceService extends ServiceBase {
  list() {
    return this.deps.workspaces.records();
  }
  private context(id: string) {
    const record = this.list().find((w) => w.id === id);
    if (!record) throw new Error("工作区不存在");
    return {
      record,
      job: this.job(record.ownerRunId),
      repo: this.repo(record.repositoryId),
    };
  }
  private async owned(record: WorkspaceRecord, repo: Repo): Promise<void> {
    const root = await realpath(join(this.dataDir, "worktrees"));
    const path = await realpath(record.path);
    if (path !== resolve(root, record.id) || basename(path) !== record.id)
      throw new Error("工作区路径不在本项目管理范围");
    if (
      (await git(path, ["symbolic-ref", "--short", "HEAD"])) !==
        record.branch ||
      !record.branch.startsWith("maintainer/")
    )
      throw new Error("工作区分支与所有权记录不一致");
    const common = await git(path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const expected = await git(repo.localPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if ((await realpath(common)) !== (await realpath(expected)))
      throw new Error("工作区不属于登记的仓库");
  }
  async inspect(id: string): Promise<WorkspaceInspection> {
    const { record, job, repo } = this.context(id),
      cleanupReasons: string[] = [],
      recoveryReasons: string[] = [];
    const snapshot = this.deps.workspaces.snapshot(job.id);
    let headSha: string | undefined,
      patchHash: string | undefined,
      bytes: number | undefined;
    let removalCompleted = false;
    if (record.status === "removed") cleanupReasons.push("工作区已清理");
    if (record.status !== "retained")
      cleanupReasons.push(
        "工作区尚未释放；中断工作区需先确认原会话停止并恢复所有权",
      );
    if (record.status !== "interrupted")
      recoveryReasons.push("只有中断工作区需要恢复所有权");
    const live = this.store
      .jobs()
      .filter((j) => ["queued", "running"].includes(j.status));
    if (
      live.some(
        (j) =>
          j.id === job.id ||
          j.worktree === record.path ||
          (j.formatOnly && j.sourceJobId === job.id),
      )
    ) {
      cleanupReasons.push("存在使用此目录的活动任务");
      recoveryReasons.push("存在使用此目录的活动任务");
    }
    const closed =
      this.store.processing.cases(job.issueId).find((c) => c.id === job.caseId)
        ?.phase === "closed";
    const delivered = ["pr", "update_pr"].some(
      (action) =>
        job.publications?.[action as "pr" | "update_pr"]?.status ===
        "published",
    );
    if (
      !closed &&
      (!["failed", "cancelled", "rejected", "completed"].includes(job.status) ||
        (job.status === "completed" && job.goal && !job.goalPauseReason)) &&
      !delivered
    )
      cleanupReasons.push("产物仍等待输入、审核或交付，保留工作区");
    if (job.formatRecovery && !closed)
      cleanupReasons.push("输出格式恢复仍需要此目录");
    if (["in_use", "preparing", "ready", "cleaning"].includes(record.status)) {
      cleanupReasons.push("执行器持有写入所有权");
      recoveryReasons.push("执行器持有写入所有权");
    } else if (record.status !== "removed") {
      try {
        if (record.status === "interrupted" && record.cleanupStartedAt) {
          const missing = await lstat(record.path).then(
            () => false,
            (error) => {
              if (error.code === "ENOENT") return true;
              throw error;
            },
          );
          if (missing) {
            const root = await realpath(join(this.dataDir, "worktrees"));
            if (
              resolve(record.path) !==
                resolve(this.dataDir, "worktrees", record.id) ||
              basename(record.path) !== record.id ||
              !root
            )
              throw new Error("清理记录路径不在本项目管理范围");
            const registered = await git(repo.localPath, [
              "worktree",
              "list",
              "--porcelain",
            ]);
            if (registered.split("\n").includes(`worktree ${record.path}`))
              throw new Error("目录已缺失，但 Git 仍登记工作区，请先核对仓库");
            removalCompleted = true;
          }
        }
        if (!removalCompleted) {
          await this.owned(record, repo);
          headSha = await git(record.path, ["rev-parse", "HEAD"]);
          const { patch, treeHash } = await inspectTree(
            record.path,
            job.baseSha,
          );
          patchHash = createHash("sha256").update(patch).digest("hex");
          bytes = Buffer.byteLength(patch);
          if (headSha !== job.baseSha && headSha !== job.publishedCommit)
            throw new Error("工作区 HEAD 未绑定原任务或已发布提交");
          if (
            patch !== (job.patch ?? "") &&
            !(job.formatRecovery && patchHash === job.formatRecovery.patchHash)
          )
            throw new Error(
              "工作区存在尚未保存的额外变更，请先保留或核对这些变更",
            );
          if (snapshot) {
            await this.deps.workspaces.patchFor(job);
            if (treeHash !== snapshot.resultTreeHash)
              throw new Error("目录内容与冻结快照不一致");
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        cleanupReasons.push(reason);
        recoveryReasons.push(reason);
      }
    }
    const stamp = fingerprint({
      record,
      headSha,
      patchHash,
      cleanupReasons,
      recoveryReasons,
      job,
      case: this.store.processing.current(job.issueId),
    });
    return {
      record,
      headSha,
      patchHash,
      bytes,
      cleanupReasons: [...new Set(cleanupReasons)],
      recoveryReasons: [...new Set(recoveryReasons)],
      stamp,
      preservedPatch: !!snapshot,
      removalCompleted,
    };
  }
  async recover(
    id: string,
    stamp: string,
    confirmedStopped: boolean,
  ): Promise<void> {
    if (!confirmedStopped)
      throw new Error("请先确认原 Harness 会话及进程已经停止");
    const { repo } = this.context(id);
    await repositoryLocks.run(await realpath(repo.localPath), async () => {
      const preview = await this.inspect(id);
      if (preview.stamp !== stamp)
        throw new Error("工作区或任务已变化，请重新检查");
      if (preview.recoveryReasons.length)
        throw new Error(preview.recoveryReasons.join("；"));
      this.deps.workspaces.setStatus(
        id,
        preview.removalCompleted ? "removed" : "retained",
      );
      this.store.audit(
        "workspace.recovered",
        `${id}：维护者确认原会话停止；未重新执行或修改代码`,
        preview.record.ownerRunId,
      );
    });
  }
  async cleanup(id: string, stamp: string): Promise<void> {
    const { repo } = this.context(id);
    await repositoryLocks.run(await realpath(repo.localPath), async () => {
      const preview = await this.inspect(id);
      if (preview.stamp !== stamp)
        throw new Error("工作区或任务已变化，请重新预览");
      if (preview.cleanupReasons.length)
        throw new Error(preview.cleanupReasons.join("；"));
      const job = this.job(preview.record.ownerRunId),
        patch = await collectPatch(preview.record.path, job.baseSha);
      if (
        createHash("sha256").update(patch).digest("hex") !== preview.patchHash
      )
        throw new Error("清理前补丁已变化，请重新预览");
      if (patch && !preview.preservedPatch)
        await this.deps.workspaces.freeze(
          { ...job, worktree: preview.record.path },
          patch,
        );
      this.deps.workspaces.setStatus(id, "cleaning");
      try {
        await this.owned(preview.record, repo);
        await git(repo.localPath, [
          "worktree",
          "remove",
          "--force",
          preview.record.path,
        ]);
        this.deps.workspaces.setStatus(id, "removed");
        this.store.audit(
          "workspace.cleaned",
          `${id}：目录已清理，分支、补丁快照及执行证据保留`,
          job.id,
        );
      } catch (error) {
        // A crash/failure during removal is ambiguous; never claim the directory is reusable.
        this.deps.workspaces.setStatus(id, "interrupted");
        throw error;
      }
    });
  }
}
