import { z } from "zod";
import type {
  InformationRequest,
  Issue,
  Repo,
  ReviewThread,
  ThreadSnapshot,
} from "../../core/types.ts";

import { GitHubResourceClient } from "./transport.ts";
export class DiscussionClient extends GitHubResourceClient {
  async informationReplies(
    repo: Repo,
    issue: Issue,
    since: string,
  ): Promise<{ replies: InformationRequest["replies"]; partial: boolean }> {
    const rows = z
      .array(
        z.object({
          id: z.number(),
          body: z.string().nullable(),
          created_at: z.string().datetime(),
          html_url: z.string().url(),
          user: z.object({ login: z.string() }).nullable(),
        }),
      )
      .parse(
        await this.request(
          `/repos/${repo.fullName}/issues/${issue.number}/comments?since=${encodeURIComponent(since)}&per_page=100`,
        ),
      );
    return {
      replies: rows.map((row) => ({
        id: row.id,
        body: (row.body ?? "").slice(0, 6000),
        author: row.user?.login ?? "deleted",
        createdAt: row.created_at,
        url: row.html_url,
      })),
      partial: rows.length === 100,
    };
  }
  async graphql(
    query: string,
    variables: Record<string, unknown>,
    beforeSend?: () => void,
  ): Promise<unknown> {
    const payload = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ message: z.string() })).optional(),
      })
      .parse(
        await this.request(
          "/graphql",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables }),
          },
          beforeSend,
        ),
      );
    if (payload.errors?.length || !payload.data)
      throw new Error(
        `GitHub 讨论串请求失败：${payload.errors?.map((error) => error.message).join("; ") ?? "没有可读取的数据"}`,
      );
    return payload.data;
  }
  async threads(repo: Repo, number: number): Promise<ThreadSnapshot> {
    const [owner, name] = repo.fullName.split("/");
    const data = await this.graphql(
      `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid reviewThreads(first:100){pageInfo{hasNextPage} nodes{id path line isResolved isOutdated viewerCanResolve viewerCanUnresolve comments(first:1){nodes{url body}}}}}}}`,
      { owner, name, number },
    );
    const thread = z.object({
      id: z.string(),
      path: z.string(),
      line: z.number().nullable(),
      isResolved: z.boolean(),
      isOutdated: z.boolean(),
      viewerCanResolve: z.boolean(),
      viewerCanUnresolve: z.boolean(),
      comments: z.object({
        nodes: z.array(z.object({ url: z.string().url(), body: z.string() })),
      }),
    });
    const pr = z
      .object({
        repository: z.object({
          pullRequest: z.object({
            headRefOid: z.string(),
            baseRefOid: z.string(),
            reviewThreads: z.object({
              pageInfo: z.object({ hasNextPage: z.boolean() }),
              nodes: z.array(thread),
            }),
          }),
        }),
      })
      .parse(data).repository.pullRequest;
    const threads: ReviewThread[] = pr.reviewThreads.nodes.map(
      ({ comments, ...item }) => ({
        ...item,
        url: comments.nodes[0]?.url ?? "",
        body: (comments.nodes[0]?.body ?? "").slice(0, 6000),
      }),
    );
    return {
      headSha: pr.headRefOid,
      baseSha: pr.baseRefOid,
      threads,
      partial: pr.reviewThreads.pageInfo.hasNextPage,
      syncedAt: new Date().toISOString(),
    };
  }
  async setThreadResolved(
    threadId: string,
    resolved: boolean,
    beforeSend?: () => void,
  ): Promise<void> {
    const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    const data = await this.graphql(
      `mutation($id:ID!){${mutation}(input:{threadId:$id}){thread{id isResolved}}}`,
      { id: threadId },
      beforeSend,
    );
    const result = z
      .record(
        z.object({
          thread: z.object({ id: z.string(), isResolved: z.boolean() }),
        }),
      )
      .parse(data)[mutation]?.thread;
    if (result?.id !== threadId || result.isResolved !== resolved)
      throw new Error("GitHub 未确认讨论串状态，请重新同步核对。");
  }
}
