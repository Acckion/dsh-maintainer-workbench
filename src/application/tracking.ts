import { z } from "zod";
import { ServiceBase } from "../application/service.ts";
import { githubDetail, type DetailSection } from "../core/github-details.ts";
import { prNumber } from "../core/remote-progress.ts";
import { type Issue } from "../core/types.ts";
import { sourceFingerprint } from "../infrastructure/persistence/processing.ts";

export class TrackingService extends ServiceBase {
  private remoteSyncs = new Map<string, Promise<void>>();
  async close() {
    await Promise.allSettled([...this.remoteSyncs.values()]);
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
    const snapshots: import("../core/remote-progress.ts").RemotePR[] = [];
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
    if (
      current.processing?.id !== issue.processing?.id ||
      sourceFingerprint(current) !== sourceFingerprint(issue)
    )
      throw Error("同步期间事项已更新，请重新刷新远端状态");
    const allowed =
      current.type === "pr"
        ? [current.url]
        : (current.linkedPullRequests ?? []);
    const direct =
      current.type === "pr"
        ? snapshots.find((pr) => pr.url === current.url && !pr.error)
        : undefined;
    this.store.put("issues", {
      ...current,
      state,
      ...(direct
        ? {
            headSha: direct.headSha,
            prBaseSha: direct.baseSha,
            merged: !!direct.mergedAt,
          }
        : {}),
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
    actions.baseSha = pr.baseSha;
    const after = await this.github.pullRequest(repo, number);
    if (after.headSha !== pr.headSha || after.baseSha !== pr.baseSha)
      throw Error("PR 已更新，请重新同步 Actions");
    const current = this.store.get<Issue>("issues", issueId)!;
    if (
      current.processing?.id !== issue.processing?.id ||
      sourceFingerprint(current) !== sourceFingerprint(issue)
    )
      throw Error("同步期间事项已更新，请重新刷新 Actions");
    this.store.put("issues", {
      ...current,
      ...(current.type === "pr"
        ? { headSha: pr.headSha, prBaseSha: pr.baseSha, merged: pr.merged }
        : {}),
      actions,
    });
  }
  async actionsLog(issueId: string, jobId: number) {
    const issue = this.store.get<Issue>("issues", issueId);
    if (!issue?.actions) throw Error("请先同步 Actions");
    return this.github.actionLog(this.repo(issue.repoId), issue.actions, jobId);
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
}
