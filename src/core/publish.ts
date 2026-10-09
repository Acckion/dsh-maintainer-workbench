import { createHash } from "node:crypto";
import { z } from "zod";
import { lightweight } from "./artifacts.ts";
import {
  assertDeliveryCurrent,
  resolveDelivery,
  type DeliveryTarget,
} from "./delivery.ts";
import { collectPatch, git, validateCheckout } from "./git.ts";
import { resolveGitHubAuth } from "./github-auth.ts";
import { GitHub } from "./github.ts";
import { assertReviewEvidence } from "./review-evidence.ts";
import { revision } from "./revision.ts";
import type { Store } from "./store.ts";
import type { Issue, Job, Repo } from "./types.ts";
const urlSchema = z.object({ html_url: z.string().url() });
export type PublishAction =
  | "comment"
  | "labels"
  | "pr"
  | "update_pr"
  | "review";
const approvalStamp = (job: Job) =>
  JSON.stringify({
    ...job,
    publications: undefined,
    publishedCommit: undefined,
    artifactState: undefined,
  });
const previewStamp = (
  job: Job,
  action: PublishAction,
  mode: "publish" | "reconcile" = "publish",
) =>
  createHash("sha256")
    .update(JSON.stringify([approvalStamp(job), action, mode]))
    .digest("hex");

async function existingPublication(
  job: Job,
  repo: Repo,
  action: PublishAction,
  github: GitHub,
): Promise<string[] | undefined> {
  if (
    job.publications?.[action]?.status !== "failed" ||
    !["comment", "review"].includes(action)
  )
    return;
  const resource =
    action === "comment"
      ? `issues/${job.issueSnapshot.number}/comments`
      : `pulls/${job.issueSnapshot.number}/reviews`;
  const marker = `<!-- maintainer-workbench:${job.id}:${action} -->`;
  for (let page = 1; ; page++) {
    const rows = z
      .array(
        z.object({ body: z.string().nullable(), html_url: z.string().url() }),
      )
      .parse(
        await github.request(
          `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/${resource}?per_page=100&page=${page}`,
        ),
      );
    const existing = rows.find((row) => row.body?.includes(marker));
    if (existing) return [existing.html_url];
    if (rows.length < 100) return;
  }
}

function assertInputCurrent(store: Store, job: Job, repo: Repo): void {
  const currentIssue = store.get<Issue>("issues", job.issueId),
    currentRepo = store.get<Repo>("repos", job.repoId);
  if (
    !currentIssue ||
    !currentRepo ||
    currentIssue.repoId !== job.repoId ||
    (job.caseId && job.caseId !== currentIssue.processing?.id) ||
    currentIssue.number !== job.issueSnapshot.number ||
    currentRepo.fullName !== repo.fullName ||
    currentRepo.defaultBranch !== repo.defaultBranch ||
    job.revision !== revision(currentIssue, currentRepo, job.kind)
  )
    throw new Error("发布输入已变化，预览已失效；请重新同步、分析并审核");
}

/** Re-read the actual code and issue inputs for preview and every new external write. */
async function remoteInputs(
  store: Store,
  job: Job,
  repo: Repo,
  action: PublishAction,
  github: GitHub,
): Promise<string> {
  assertInputCurrent(store, job, repo);
  await assertReviewEvidence(job);
  if (job.prContext) {
    const current = await github.pullRequest(
      { ...repo, fullName: repo.githubName ?? repo.fullName },
      job.issueSnapshot.number,
    );
    if (
      (current.headSha !== job.prContext.headSha &&
        !(action === "update_pr" && current.headSha === job.publishedCommit)) ||
      current.baseSha !== job.prContext.baseSha
    )
      throw new Error("PR head/base 已变化，旧产物不可发布");
    if (
      current.headRef !== job.prContext.headRef ||
      current.headRepo !== job.prContext.headRepo ||
      current.baseRef !== job.prContext.baseRef
    )
      throw new Error("PR 目标分支已变化，旧产物不可发布");
    if (current.merged) throw new Error("PR 已合并");
  } else if (!lightweight(job.kind)) {
    const response = await github.request(
      job.issueSnapshot.origin === "repository"
        ? `/repos/${repo.githubName ?? repo.fullName}/branches/${encodeURIComponent(repo.defaultBranch)}`
        : `/repos/${repo.githubName ?? repo.fullName}/commits/${encodeURIComponent(repo.defaultBranch)}`,
    );
    const live =
      job.issueSnapshot.origin === "repository"
        ? z.object({ commit: z.object({ sha: z.string() }) }).parse(response)
            .commit
        : z.object({ sha: z.string() }).parse(response);
    if (live.sha !== job.baseSha)
      throw new Error("远端代码基线已变化，预览已失效；请同步后重新分析并审核");
  }
  if (job.issueSnapshot.origin === "repository") {
    assertInputCurrent(store, job, repo);
    return job.issueSnapshot.updatedAt;
  }
  const live = z
    .object({ updated_at: z.string() })
    .parse(
      await github.request(
        `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/issues/${job.issueSnapshot.number}`,
      ),
    );
  assertInputCurrent(store, job, repo);
  return live.updated_at;
}

function assertIssueFresh(job: Job, updatedAt: string): void {
  const receipt = Object.values(job.publications ?? {})
    .filter((r) => r.status === "published")
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (updatedAt !== (receipt?.remoteUpdatedAt ?? job.issueSnapshot.updatedAt))
    throw new Error(
      "GitHub Issue/PR 已更新，预览已失效；请重新同步并分析后发布",
    );
}

/** Read-only preview validation; this does not authorize or perform a publication. */
export async function previewPublication(
  store: Store,
  job: Job,
  repo: Repo,
  action: PublishAction,
  github = new GitHub(),
) {
  if (repo.mode === "local" && !repo.githubName)
    throw new Error("当前工作区未关联唯一 GitHub 远端，可以导出本地补丁");
  if (job.issueSnapshot.origin === "repository" && action !== "pr")
    throw new Error("仓库整理任务仅可发布补丁 PR");
  if (action === "comment" && !job.result?.responseDraft.trim())
    throw new Error("暂无需要发布的回复内容");
  if (job.status !== "approved" || !job.result)
    throw new Error("请先审核并接受结果");
  const stamp = previewStamp(job, action);
  const alreadyPublished = await existingPublication(job, repo, action, github);
  if (alreadyPublished)
    return {
      id: job.id,
      revision: job.revision,
      updatedAt: job.updatedAt,
      stamp: previewStamp(job, action, "reconcile"),
      alreadyPublished,
    };
  const updatedAt = await remoteInputs(store, job, repo, action, github);
  // A failed attempt may have written remotely before losing its response. Allow
  // the existing deduplication lookup; a genuinely new write still checks freshness.
  if (!job.publications?.[action]) assertIssueFresh(job, updatedAt);
  if (job.deliveryReviewId) {
    const delivery = await resolveDelivery(
      store,
      repo,
      job.deliveryReviewId,
      github,
      { allowPublishedHead: action === "update_pr" && !!job.publishedCommit },
    );
    if (delivery.implementationJobId !== job.id)
      throw new Error("实施产物与批准的审查目标不一致");
  }
  if (
    job.worktree &&
    (await collectPatch(job.worktree, job.baseSha)) !== (job.patch ?? "")
  )
    throw new Error("已审核差异发生变化，请重新派发并审核");
  assertInputCurrent(store, job, repo);
  const current = store.get<Job>("jobs", job.id);
  if (!current || previewStamp(current, action) !== stamp)
    throw new Error("审批或产物内容已变化，请重新打开预览");
  return {
    id: job.id,
    revision: job.revision,
    updatedAt: job.updatedAt,
    stamp,
  };
}

/** Called only by an explicit publish action after local result approval. */
export async function publish(
  store: Store,
  job: Job,
  repo: Repo,
  action: PublishAction,
  github = new GitHub(),
  executeGit: typeof git = git,
  expectedPreview?: string,
): Promise<string[]> {
  if (job.status !== "approved" || !job.result)
    throw new Error("请先审核并接受结果");
  if (repo.mode === "local" && !repo.githubName)
    throw new Error("当前工作区未关联唯一 GitHub 远端，可以导出本地补丁");
  if (action === "comment" && !job.result.responseDraft.trim())
    throw new Error("暂无需要发布的回复内容");
  if (job.issueSnapshot.origin === "repository" && action !== "pr")
    throw new Error("仓库整理任务仅可发布补丁 PR");
  const approvedContent = approvalStamp(job);
  if (!(await resolveGitHubAuth()).token)
    throw new Error("发布需要有效的 GitHub 登录或令牌（仓库写权限）");
  const prior = job.publications?.[action];
  if (prior?.status === "published") return prior.urls;
  if (prior?.status === "publishing")
    throw new Error(
      "该操作正在发布，或上次发布被中断。请先核查 GitHub 发布结果，避免重复写入。",
    );
  // Reconcile only a marker already present remotely. Stale inputs may recover a
  // lost receipt, but must never reach a new POST through this read-only path.
  const recovered = await existingPublication(job, repo, action, github);
  if (recovered) {
    const live = z
      .object({ updated_at: z.string() })
      .parse(
        await github.request(
          `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/issues/${job.issueSnapshot.number}`,
        ),
      );
    const current = store.get<Job>("jobs", job.id)!;
    store.put("jobs", {
      ...current,
      publications: {
        ...current.publications,
        [action]: {
          status: "published",
          urls: recovered,
          remoteUpdatedAt: live.updated_at,
          startedAt: prior?.startedAt ?? prior?.at,
          at: new Date().toISOString(),
        },
      },
    });
    store.audit(
      "publish.reconciled",
      `${action}：核对已存在的远端记录，未重复写入`,
      job.id,
    );
    return recovered;
  }
  const repositoryTask = job.issueSnapshot.origin === "repository";
  if (expectedPreview === previewStamp(job, action, "reconcile"))
    throw new Error(
      "此前找到的发布记录已不存在；本次仅核对回执，不会重新发送，请先在 GitHub 核查",
    );
  if (expectedPreview && expectedPreview !== previewStamp(job, action))
    throw new Error("审批或产物内容已变化，发布预览已失效；请重新打开预览");
  assertInputCurrent(store, job, repo);
  let delivery: DeliveryTarget | undefined;
  if (job.deliveryReviewId) {
    delivery = await resolveDelivery(
      store,
      repo,
      job.deliveryReviewId,
      github,
      { allowPublishedHead: action === "update_pr" && !!job.publishedCommit },
    );
    if (delivery.implementationJobId !== job.id)
      throw new Error("实施产物与批准的审查目标不一致");
  }
  const assertBinding = () => {
    const current = store.get<Job>("jobs", job.id);
    if (
      !current ||
      current.status !== "approved" ||
      approvalStamp(current) !== approvedContent
    )
      throw new Error("发布前审批或产物内容已变化，请重新确认");
    assertInputCurrent(store, job, repo);
    if (delivery) assertDeliveryCurrent(store, delivery);
  };
  const remoteWrite = async (path: string, init: RequestInit) => {
    assertBinding();
    assertIssueFresh(job, await remoteInputs(store, job, repo, action, github));
    assertBinding();
    return github.request(path, init);
  };
  const updatedAt = await remoteInputs(store, job, repo, action, github);
  const assertFresh = () => assertIssueFresh(job, updatedAt);
  if (!prior) assertFresh();
  if (
    ["pr", "update_pr"].includes(action) &&
    (!job.worktree || !job.branch || !job.patch)
  )
    throw new Error("没有可发布的工作区补丁");
  if (
    job.worktree &&
    (await collectPatch(job.worktree, job.baseSha)) !== (job.patch ?? "")
  )
    throw new Error("已审核差异发生变化，请重新派发并审核");
  const set = (
    status: "publishing" | "published" | "failed",
    urls: string[],
    error?: string,
    remoteUpdatedAt?: string,
  ) => {
    const current = store.get<Job>("jobs", job.id)!;
    store.put("jobs", {
      ...current,
      publications: {
        ...current.publications,
        [action]: {
          status,
          urls,
          error,
          remoteUpdatedAt,
          startedAt:
            status === "publishing"
              ? new Date().toISOString()
              : current.publications?.[action]?.startedAt,
          at: new Date().toISOString(),
        },
      },
    });
    store.audit(
      `publish.${status}`,
      `${action}${error ? `：${error}` : ""}`,
      job.id,
    );
  };
  set("publishing", []);
  try {
    let urls: string[] = [];
    const marker = `<!-- maintainer-workbench:${job.id}:${action} -->`;
    if (action === "review") {
      if (!job.prContext || job.artifact?.stage !== "review")
        throw new Error("只有 PR 审查产物可以发布审查");
      const findings = job.artifact.findings.filter(
        (f) => job.findingDecisions?.[f.id] === "accepted",
      );
      const body = `${job.artifact.summary}\n\n覆盖范围：${job.artifact.coverage}\n\n${findings.map((f) => `- ${f.severity} ${f.path}${f.line ? ":" + f.line : ""}: ${f.title}\n  ${f.trigger}\n  ${f.evidence}\n  ${f.recommendation}`).join("\n")}\n\n${marker}`;
      let existing: { html_url: string } | undefined;
      for (let page = 1; ; page++) {
        const rows = z
          .array(
            z.object({
              body: z.string().nullable(),
              html_url: z.string().url(),
            }),
          )
          .parse(
            await github.request(
              `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/pulls/${job.issueSnapshot.number}/reviews?per_page=100&page=${page}`,
            ),
          );
        existing = rows.find((r) => r.body?.includes(marker));
        if (existing || rows.length < 100) break;
      }
      if (!existing) assertFresh();
      const response =
        existing ??
        urlSchema.parse(
          await remoteWrite(
            `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/pulls/${job.issueSnapshot.number}/reviews`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                body,
                event: "COMMENT",
                commit_id: job.prContext.headSha,
              }),
            },
          ),
        );
      urls = [response.html_url];
    } else if (action === "comment") {
      // Search every comment page before POST, so ambiguous network retries do not duplicate a comment.
      let existing: { html_url: string } | undefined;
      for (let page = 1; ; page++) {
        const rows = z
          .array(z.object({ body: z.string(), html_url: z.string().url() }))
          .parse(
            await github.request(
              `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/issues/${job.issueSnapshot.number}/comments?per_page=100&page=${page}`,
            ),
          );
        existing = rows.find((r) => r.body.includes(marker));
        if (existing || rows.length < 100) break;
      }
      if (!existing) assertFresh();
      const result =
        existing ??
        urlSchema.parse(
          await remoteWrite(
            `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/issues/${job.issueSnapshot.number}/comments`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                body: `${job.result.responseDraft}\n\n${marker}`,
              }),
            },
          ),
        );
      urls = [result.html_url];
    } else if (action === "labels") {
      assertFresh();
      if (!job.result.labels.length) throw new Error("没有建议标签");
      await remoteWrite(
        `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/issues/${job.issueSnapshot.number}/labels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ labels: job.result.labels }),
        },
      );
      urls = [job.issueSnapshot.url];
    } else {
      if (action !== "update_pr" || !job.publishedCommit) assertFresh();
      if (action === "pr" && job.issueSnapshot.type === "pr")
        throw new Error("现有 PR 请使用更新原 PR，或下载补丁");
      if (!["fix", "docs"].includes(job.kind))
        throw new Error("只有实施或文档产物可发布代码，实验补丁不能发布");
      if (
        action === "update_pr" &&
        (!job.prContext ||
          job.prContext.headRepo !== (repo.githubName ?? repo.fullName))
      )
        throw new Error("跨仓库 fork 不自动推送，请下载补丁交给原作者");
      await validateCheckout(repo.localPath, repo);
      const worktree = job.worktree!;
      const head = await git(worktree, ["rev-parse", "HEAD"]);
      if (job.publishedCommit) {
        if (head !== job.publishedCommit)
          throw new Error("已提交工作区被改动，不能自动重试发布");
      } else {
        if (head !== job.baseSha)
          throw new Error("工作区 HEAD 已改变，不能提交未审核历史");
        if ((await collectPatch(worktree, job.baseSha)) !== job.patch)
          throw new Error("提交前差异已变化，请重新审核");
        assertBinding();
        const commit = await git(worktree, [
          "-c",
          "user.name=Maintainer Workbench",
          "-c",
          "user.email=maintainer-workbench@users.noreply.github.com",
          "commit",
          "--no-gpg-sign",
          "-m",
          `${job.kind}: ${job.issueSnapshot.title.slice(0, 180)}`,
        ]);
        store.audit("publish.commit", commit.split("\n")[0], job.id);
        const committedSha = await git(worktree, ["rev-parse", "HEAD"]);
        store.put("jobs", {
          ...store.get<Job>("jobs", job.id)!,
          publishedCommit: committedSha,
        });
      }
      if (job.prContext) {
        const current = await github.pullRequest(
          { ...repo, fullName: repo.githubName ?? repo.fullName },
          job.issueSnapshot.number,
        );
        const ownCommit = store.get<Job>("jobs", job.id)!.publishedCommit;
        if (
          current.merged ||
          (current.headSha !== job.prContext.headSha &&
            current.headSha !== ownCommit) ||
          current.baseSha !== job.prContext.baseSha ||
          current.headRef !== job.prContext.headRef ||
          current.headRepo !== job.prContext.headRepo ||
          current.baseRef !== job.prContext.baseRef
        )
          throw new Error("推送前 PR 版本或目标分支已变化");
        if (
          action === "update_pr" &&
          job.publishedCommit &&
          current.headSha === ownCommit
        ) {
          // A previous push may have succeeded before its confirmation was lost.
          // Confirm that exact saved commit read-only, even though the push itself
          // advanced GitHub's updated_at; do not push it again.
          const confirmed = z
            .object({ updated_at: z.string() })
            .parse(
              await github.request(
                `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/issues/${job.issueSnapshot.number}`,
              ),
            );
          assertBinding();
          const urls = [job.issueSnapshot.url];
          set("published", urls, undefined, confirmed.updated_at);
          return urls;
        }
      }
      if (
        (await collectPatch(worktree, job.baseSha)) !== job.patch ||
        (await git(worktree, ["rev-parse", "HEAD"])) !==
          store.get<Job>("jobs", job.id)!.publishedCommit
      )
        throw new Error("推送前工作区已变化");
      assertIssueFresh(
        job,
        await remoteInputs(
          store,
          store.get<Job>("jobs", job.id)!,
          repo,
          action,
          github,
        ),
      );
      assertBinding();
      await executeGit(
        worktree,
        [
          "push",
          `https://github.com/${repo.mode === "local" ? repo.githubName : repo.fullName}.git`,
          `HEAD:refs/heads/${action === "update_pr" ? job.prContext!.headRef : job.branch}`,
        ],
        true,
      );
      if (action === "update_pr") {
        const remote = await github.pullRequest(
          { ...repo, fullName: repo.githubName ?? repo.fullName },
          job.issueSnapshot.number,
        );
        const saved = store.get<Job>("jobs", job.id)!;
        if (remote.headSha !== saved.publishedCommit)
          throw new Error("推送后 head 未确认，请核查后重试");
        urls = [job.issueSnapshot.url];
        const confirmed = repositoryTask
          ? { updated_at: job.issueSnapshot.updatedAt }
          : z
              .object({ updated_at: z.string() })
              .parse(
                await github.request(
                  `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/issues/${job.issueSnapshot.number}`,
                ),
              );
        set("published", urls, undefined, confirmed.updated_at);
        return urls;
      }
      const [owner] = (repo.githubName ?? repo.fullName).split("/");
      const existing = z
        .array(urlSchema)
        .parse(
          await github.request(
            `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/pulls?state=all&head=${encodeURIComponent(`${owner}:${job.branch}`)}`,
          ),
        );
      const pr =
        existing[0] ??
        urlSchema.parse(
          await remoteWrite(
            `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/pulls`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: `${job.kind === "docs" ? "docs" : "fix"}: ${job.issueSnapshot.title.slice(0, 180)}`,
                head: job.branch,
                base: repo.defaultBranch,
                draft: true,
                body: `${repositoryTask ? "Repository maintenance" : `Refs #${job.issueSnapshot.number}`}\n\n${job.result.summary}\n\n### Validation\n${job.result.tests.map((t) => `- ${t.status}: \`${t.command}\`\n  ${t.output}`).join("\n")}\n\nReviewed task: ${job.id}\nBase: ${job.baseSha}\n\n${marker}`,
              }),
            },
          ),
        );
      urls = [pr.html_url];
    }
    const confirmed = repositoryTask
      ? { updated_at: job.issueSnapshot.updatedAt }
      : z
          .object({ updated_at: z.string() })
          .parse(
            await github.request(
              `/repos/${repo.mode === "local" ? repo.githubName : repo.fullName}/issues/${job.issueSnapshot.number}`,
            ),
          );
    set("published", urls, undefined, confirmed.updated_at);
    if (action === "pr") {
      const issue = store.get<import("./types.ts").Issue>(
        "issues",
        job.issueId,
      );
      if (issue)
        store.put("issues", {
          ...issue,
          linkedPullRequests: [
            ...new Set([...(issue.linkedPullRequests ?? []), ...urls]),
          ],
        });
    }
    return urls;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    set("failed", [], message);
    throw error;
  }
}
