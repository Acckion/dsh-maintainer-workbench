import { ServiceBase } from "../application/service.ts";
import { readExecutionLog } from "../core/execution-evidence.ts";
import {
  previewPublication,
  publish,
  type PublishAction,
} from "../core/publish.ts";
import { IssueService } from "./issues.ts";

export class PublicationService extends ServiceBase {
  recoverFollowups(): void {
    for (const job of this.store.jobs()) this.recordFollowup(job);
  }
  private recordFollowup(job: import("../core/types.ts").Job): void {
    const receipt = job.publications?.comment,
      issue = this.store.get<import("../core/types.ts").Issue>(
        "issues",
        job.issueId,
      );
    if (
      receipt?.status !== "published" ||
      receipt.followupRecordedAt ||
      job.artifact?.stage !== "triage" ||
      job.artifact.route !== "needs_info" ||
      !job.artifact.missingInfo.length ||
      !issue ||
      issue.state !== "open" ||
      (job.caseId && job.caseId !== issue.processing?.id)
    )
      return;
    const id = `published:${job.id}`;
    try {
      this.store.transaction(() => {
        const reply =
          receipt.publishedReply ?? this.store.draft(issue.id).reply;
        const edited =
          typeof reply === "string" &&
          reply.trim() !== (job.result?.responseDraft ?? "").trim();
        if (edited)
          this.store.audit(
            "publication.followup_requires_confirmation",
            "已发布编辑后的回复；请核对实际追问并在 Plan 登记，未按旧报告自动创建等待",
            job.id,
          );
        if (!edited && !issue.informationRequests?.some((r) => r.id === id))
          new IssueService(this.deps).askInformation(
            issue.id,
            job.artifact!.stage === "triage" ? job.artifact!.missingInfo : [],
            job.issueSnapshot.author,
            receipt.startedAt ?? receipt.at,
            { id },
          );
        const current = this.job(job.id);
        this.saveJob({
          ...current,
          publications: {
            ...current.publications,
            comment: {
              ...current.publications!.comment!,
              followupRecordedAt: new Date().toISOString(),
            },
          },
        });
      });
    } catch (error) {
      this.store.audit(
        "publication.followup_blocked",
        error instanceof Error ? error.message : String(error),
        job.id,
      );
    }
  }

  private get publishing() {
    return this.deps.publicationLocks;
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
      const urls = await publish(
        this.store,
        job,
        this.repo(job.repoId),
        action,
        this.github,
        undefined,
        expectedPreview,
      );
      this.recordFollowup(this.job(id));
      return urls;
    } finally {
      this.publishing.delete(id);
      this.publishing.delete(target);
    }
  }
}
