import { z } from "zod";
import { prNumber, type RemotePR } from "../../core/remote-progress.ts";
import type { Issue, Repo } from "../../core/types.ts";

import { GitHubResourceClient } from "./transport.ts";
export class PullRequestClient extends GitHubResourceClient {
  async pullRequest(
    repo: Repo,
    number: number,
    signal?: AbortSignal,
    metadataOnly = false,
  ): Promise<import("../../core/types.ts").PRContext> {
    const pr = z
      .object({
        head: z.object({
          sha: z.string().regex(/^[a-f0-9]{40,64}$/),
          ref: z.string(),
          repo: z.object({ full_name: z.string() }).nullable(),
        }),
        base: z.object({
          sha: z.string().regex(/^[a-f0-9]{40,64}$/),
          ref: z.string(),
        }),
        draft: z.boolean(),
        merged: z.boolean(),
        mergeable: z.boolean().nullable(),
      })
      .parse(
        await this.request(
          `/repos/${repo.githubName ?? repo.fullName}/pulls/${number}`,
          { signal },
        ),
      );
    const warnings: string[] = [];
    const optional = async (path: string) => {
      try {
        return await this.request(path, { signal });
      } catch (e) {
        if (signal?.aborted) throw e;
        warnings.push(
          `无法读取 ${path}: ${e instanceof Error ? e.message : "未知错误"}`,
        );
        return null;
      }
    };
    const [checks, reviews, reviewComments, commitStatus] = await Promise.all([
      optional(
        `/repos/${repo.githubName ?? repo.fullName}/commits/${pr.head.sha}/check-runs?per_page=100`,
      ),
      optional(
        `/repos/${repo.githubName ?? repo.fullName}/pulls/${number}/reviews?per_page=100`,
      ),
      metadataOnly
        ? Promise.resolve(null)
        : optional(
            `/repos/${repo.githubName ?? repo.fullName}/pulls/${number}/comments?per_page=100`,
          ),
      optional(
        `/repos/${repo.githubName ?? repo.fullName}/commits/${pr.head.sha}/status`,
      ),
    ]);
    return {
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headRepo: pr.head.repo?.full_name ?? null,
      baseRef: pr.base.ref,
      draft: pr.draft,
      merged: pr.merged,
      mergeable: pr.mergeable,
      checks,
      reviews,
      reviewComments,
      commitStatus,
      warnings: [
        ...warnings,
        "检查和审查最多各 100 条；分支保护规则和未解决讨论未完整覆盖，不构成合并许可。",
      ],
    };
  }
  async context(
    repo: Repo,
    issue: Issue,
    signal: AbortSignal,
    metadataOnly = false,
    expected?: import("../../core/types.ts").PRContext,
  ): Promise<string> {
    const comments = await this.request(
      `/repos/${repo.githubName ?? repo.fullName}/issues/${issue.number}/comments?per_page=30`,
      { signal },
    );
    let extra: unknown = null;
    if (issue.type === "pr" && !metadataOnly) {
      const pr = z
        .object({
          head: z.object({ sha: z.string() }),
          base: z.object({ sha: z.string() }),
          changed_files: z.number(),
        })
        .parse(
          await this.request(`/repos/${repo.fullName}/pulls/${issue.number}`, {
            signal,
          }),
        );
      if (
        expected &&
        (pr.head.sha !== expected.headSha || pr.base.sha !== expected.baseSha)
      )
        throw new Error("PR 在上下文读取期间已更新，请同步后重试");
      const files = await this.request(
        `/repos/${repo.fullName}/pulls/${issue.number}/files?per_page=100`,
        { signal },
      );
      const after = z
        .object({
          head: z.object({ sha: z.string() }),
          base: z.object({ sha: z.string() }),
        })
        .parse(
          await this.request(`/repos/${repo.fullName}/pulls/${issue.number}`, {
            signal,
          }),
        );
      if (after.head.sha !== pr.head.sha || after.base.sha !== pr.base.sha)
        throw new Error("读取 diff 时 PR 已更新，请同步后重试");
      extra = {
        ...pr,
        files,
        coverage:
          pr.changed_files > 100
            ? "Only first 100 files; partial review"
            : "Up to 100 files; patches may be truncated by GitHub",
      };
    }
    const data = JSON.stringify({
      comments:
        metadataOnly && Array.isArray(comments)
          ? comments.map((c) => ({
              user: { login: c.user?.login },
              body: String(c.body ?? "").slice(0, 1200),
            }))
          : comments,
      pullRequest: extra,
    });
    return metadataOnly ? data : data.slice(0, 65000);
  }
  async remotePR(repo: Repo, url: string): Promise<RemotePR> {
    const number = prNumber(url, repo.fullName),
      [owner, name] = repo.fullName.split("/");
    const raw = await this.graphql(
      `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){url number headRefOid baseRefOid state isDraft reviewDecision mergeStateStatus mergedAt closingIssuesReferences(first:100){pageInfo{hasNextPage} nodes{url}} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}}`,
      { owner, name, number },
    );
    const pr = z
      .object({
        repository: z.object({
          pullRequest: z.object({
            url: z.string().url(),
            number: z.number(),
            headRefOid: z.string(),
            baseRefOid: z.string(),
            state: z.string(),
            isDraft: z.boolean(),
            reviewDecision: z.string().nullable(),
            mergeStateStatus: z.string(),
            mergedAt: z.string().nullable(),
            closingIssuesReferences: z.object({
              pageInfo: z.object({ hasNextPage: z.boolean() }),
              nodes: z.array(z.object({ url: z.string() })),
            }),
            commits: z.object({
              nodes: z.array(
                z.object({
                  commit: z.object({
                    statusCheckRollup: z
                      .object({
                        contexts: z.object({
                          pageInfo: z.object({ hasNextPage: z.boolean() }),
                          nodes: z.array(
                            z.object({
                              __typename: z.string(),
                              name: z.string().optional(),
                              status: z.string().optional(),
                              conclusion: z.string().nullable().optional(),
                              context: z.string().optional(),
                              state: z.string().optional(),
                            }),
                          ),
                        }),
                      })
                      .nullable(),
                  }),
                }),
              ),
            }),
          }),
        }),
      })
      .parse(raw).repository.pullRequest;
    if (pr.number !== number || prNumber(pr.url, repo.fullName) !== number)
      throw Error("GitHub 返回的 PR 目标不一致");
    const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
    return {
      url: pr.url,
      number,
      headSha: pr.headRefOid,
      baseSha: pr.baseRefOid,
      state: pr.state,
      draft: pr.isDraft,
      review: pr.reviewDecision,
      mergeState: pr.mergeStateStatus,
      mergedAt: pr.mergedAt,
      checks: (contexts?.nodes ?? []).map((c) => ({
        name: c.name ?? c.context ?? "unknown",
        status:
          c.status ?? (c.state === "PENDING" ? "IN_PROGRESS" : "COMPLETED"),
        conclusion: c.conclusion ?? c.state ?? null,
      })),
      closingIssues: pr.closingIssuesReferences.nodes.map((i) => i.url),
      partial:
        !contexts ||
        contexts.pageInfo.hasNextPage ||
        pr.closingIssuesReferences.pageInfo.hasNextPage,
      syncedAt: new Date().toISOString(),
    };
  }
}
