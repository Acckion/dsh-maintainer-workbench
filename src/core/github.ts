import { z } from "zod";
import { resolveGitHubAuth } from "./github-auth.ts";
import { githubRequest } from "./github-request.ts";
import { type ActionsSnapshot } from "./remote-progress.ts";
import type { Issue, Repo } from "./types.ts";

import { ActionsClient } from "../infrastructure/github/actions.ts";
import { DiscussionClient } from "../infrastructure/github/discussions.ts";
import { PullRequestClient } from "../infrastructure/github/pull-requests.ts";
import { RepositoryClient } from "../infrastructure/github/repository.ts";
import type { GitHubTransport } from "../infrastructure/github/transport.ts";
export class GitHub {
  private repositories: RepositoryClient;
  private pulls: PullRequestClient;
  private checks: ActionsClient;
  private discussions: DiscussionClient;
  constructor(
    private token?: string,
    private fetcher: typeof fetch = fetch,
  ) {
    const transport: GitHubTransport = {
      token,
      fetcher,
      request: (...args) => this.request(...args),
      graphql: (...args) => this.graphql(...args),
    };
    this.repositories = new RepositoryClient(transport);
    this.pulls = new PullRequestClient(transport);
    this.checks = new ActionsClient(transport);
    this.discussions = new DiscussionClient(transport);
  }
  async request(
    path: string,
    init: RequestInit = {},
    beforeSend?: () => void,
  ): Promise<unknown> {
    const auth = await resolveGitHubAuth(this.token);
    const response = await githubRequest(
      this.fetcher,
      `https://api.github.com${path}`,
      {
        ...init,
        signal: init.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "maintainer-workbench/0.1",
          ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
          ...init.headers,
        },
      },
      beforeSend,
    );
    return response.json();
  }
  async connection() {
    const auth = await resolveGitHubAuth(this.token);
    if (!auth.token) return { source: auth.source, authenticated: false };
    try {
      const user = z
        .object({ login: z.string() })
        .parse(await new GitHub(auth.token, this.fetcher).request("/user"));
      return { source: auth.source, authenticated: true, login: user.login };
    } catch (error) {
      return {
        source: auth.source,
        authenticated: false,
        error: error instanceof Error ? error.message : "连接验证失败",
        errorKind:
          error && typeof error === "object" && "kind" in error
            ? String(error.kind)
            : "unknown",
      };
    }
  }
  sync(fullName: string, limit = 1000) {
    return this.repositories.sync(fullName, limit);
  }
  profile(repo: Repo, signal?: AbortSignal) {
    return this.repositories.profile(repo, signal);
  }
  pullRequest(
    repo: Repo,
    number: number,
    signal?: AbortSignal,
    metadataOnly = false,
  ) {
    return this.pulls.pullRequest(repo, number, signal, metadataOnly);
  }
  context(
    repo: Repo,
    issue: Issue,
    signal: AbortSignal,
    metadataOnly = false,
    expected?: import("./types.ts").PRContext,
  ) {
    return this.pulls.context(repo, issue, signal, metadataOnly, expected);
  }
  remotePR(repo: Repo, url: string) {
    return this.pulls.remotePR(repo, url);
  }
  actions(repo: Repo, headSha: string, signal?: AbortSignal) {
    return this.checks.actions(repo, headSha, signal);
  }
  actionLog(
    repo: Repo,
    snapshot: ActionsSnapshot,
    jobId: number,
    signal?: AbortSignal,
  ) {
    return this.checks.actionLog(repo, snapshot, jobId, signal);
  }
  informationReplies(repo: Repo, issue: Issue, since: string) {
    return this.discussions.informationReplies(repo, issue, since);
  }
  graphql(
    query: string,
    variables: Record<string, unknown>,
    beforeSend?: () => void,
  ) {
    return this.discussions.graphql(query, variables, beforeSend);
  }
  threads(repo: Repo, number: number) {
    return this.discussions.threads(repo, number);
  }
  setThreadResolved(
    threadId: string,
    resolved: boolean,
    beforeSend?: () => void,
  ) {
    return this.discussions.setThreadResolved(threadId, resolved, beforeSend);
  }
}
