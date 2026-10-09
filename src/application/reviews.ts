import { createHash } from "node:crypto";
import { ServiceBase } from "../application/service.ts";
import { reviewFollowups } from "../core/finding-followup.ts";
import { revision } from "../core/revision.ts";
import { type Issue, type Job } from "../core/types.ts";
import { sourceFingerprint } from "../infrastructure/persistence/processing.ts";
const patchHash = (patch: string): string =>
  createHash("sha256").update(patch).digest("hex");

export class ReviewService extends ServiceBase {
  private get publishing() {
    return this.deps.publicationLocks;
  }
  followup(
    id: string,
    value: import("../core/types.ts").FindingFollowup,
  ): void {
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
    const issue = this.store.get<Issue>("issues", job.issueId)!;
    if (job.kind !== "review" || job.issueSnapshot.type !== "pr")
      throw new Error("只有 PR 审查可以同步讨论串");
    const snapshot = await this.github.threads(
      this.repo(job.repoId),
      job.issueSnapshot.number,
    );
    const current = this.store.get<Issue>("issues", job.issueId)!;
    if (
      current.processing?.id !== issue.processing?.id ||
      sourceFingerprint(current) !== sourceFingerprint(issue)
    )
      throw new Error("同步期间事项已变化，请重新读取讨论串");
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
    thread: import("../core/types.ts").ReviewThread,
    resolved: boolean,
    snapshot: import("../core/types.ts").ThreadSnapshot,
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
}
