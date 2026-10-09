import { z } from "zod";
import {
  contextPaths,
  repositoryProfile,
} from "../../core/repository-context.ts";
import type { Issue, Repo } from "../../core/types.ts";
const nameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  state: z.enum(["open", "closed"]),
  comments: z.number(),
  updated_at: z.string(),
  html_url: z.string().url(),
  pull_request: z
    .object({ url: z.string(), merged_at: z.string().nullable().optional() })
    .optional(),
});

import { GitHubResourceClient } from "./transport.ts";
export class RepositoryClient extends GitHubResourceClient {
  async sync(
    fullName: string,
    limit = 1000,
  ): Promise<{ repo: Repo; issues: Issue[] }> {
    nameSchema.parse(fullName);
    z.number().int().min(0).max(1000000).parse(limit);
    const meta = z
      .object({
        full_name: z.string(),
        description: z.string().nullable(),
        default_branch: z.string(),
        private: z.boolean().optional(),
      })
      .parse(await this.request(`/repos/${fullName}`));
    const commit = z
      .object({ sha: z.string() })
      .parse(
        await this.request(
          `/repos/${fullName}/commits/${encodeURIComponent(meta.default_branch)}`,
        ),
      );
    const issues: Issue[] = [];
    let truncated = false;
    for (let page = 1; ; page++) {
      const rows = z
        .array(issueSchema)
        .parse(
          await this.request(
            `/repos/${fullName}/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
          ),
        );
      const remaining = limit
        ? Math.max(0, limit - issues.length)
        : rows.length;
      for (const row of rows.slice(0, remaining))
        issues.push({
          id: `${meta.full_name}#${row.number}`,
          repoId: meta.full_name,
          number: row.number,
          type: row.pull_request ? "pr" : "issue",
          merged: row.pull_request?.merged_at
            ? true
            : row.pull_request?.merged_at === null
              ? false
              : undefined,
          title: row.title,
          body: row.body ?? "",
          author: row.user?.login ?? "deleted",
          labels: row.labels.map((l) => (typeof l === "string" ? l : l.name)),
          state: row.state,
          comments: row.comments,
          updatedAt: row.updated_at,
          url: row.html_url,
        });
      if (limit && issues.length >= limit) {
        truncated = rows.length === 100 || rows.length > remaining;
        break;
      }
      if (rows.length < 100) break;
    }
    let prWarning = "";
    if (issues.some((i) => i.type === "pr" && i.state === "open")) {
      try {
        for (let page = 1; ; page++) {
          const prs = z
            .array(
              z.object({
                number: z.number(),
                head: z.object({ sha: z.string() }),
                base: z.object({ sha: z.string() }),
              }),
            )
            .parse(
              await this.request(
                `/repos/${fullName}/pulls?state=open&per_page=100&page=${page}`,
              ),
            );
          for (const pr of prs) {
            const issue = issues.find(
              (i) => i.type === "pr" && i.number === pr.number,
            );
            if (issue) {
              issue.headSha = pr.head.sha;
              issue.prBaseSha = pr.base.sha;
            }
          }
          if (
            prs.length < 100 ||
            issues
              .filter((i) => i.type === "pr" && i.state === "open")
              .every((i) => i.headSha)
          )
            break;
        }
      } catch {
        prWarning = "PR 版本列表未完整获取；执行和发布前会再次固定远端版本。";
      }
    }
    return {
      repo: {
        id: meta.full_name,
        fullName: meta.full_name,
        description: meta.description ?? "",
        private: meta.private,
        defaultBranch: meta.default_branch,
        headSha: commit.sha,
        localPath: "",
        mode: "github",
        syncedAt: new Date().toISOString(),
        syncLimited: truncated,
        syncWarning: prWarning || null,
      },
      issues,
    };
  }
  async profile(repo: Repo, signal?: AbortSignal) {
    try {
      const tree = z
        .object({
          truncated: z.boolean().optional(),
          tree: z.array(
            z.object({
              path: z.string(),
              type: z.string(),
              mode: z.string().optional(),
            }),
          ),
        })
        .parse(
          await this.request(
            `/repos/${repo.fullName}/git/trees/${repo.headSha}?recursive=1`,
            { signal },
          ),
        );
      const files = tree.tree
        .filter((f) => f.type === "blob")
        .map((f) => f.path);
      const warnings = tree.truncated
        ? ["GitHub tree is truncated; repository map is partial."]
        : [];
      const sources: { path: string; content: string }[] = [];
      const paths = contextPaths(files)
        .filter((p) =>
          tree.tree.some((f) => f.path === p && f.mode !== "120000"),
        )
        .slice(0, 6);
      for (const path of paths) {
        try {
          const blob = z
            .object({ content: z.string(), encoding: z.literal("base64") })
            .parse(
              await this.request(
                `/repos/${repo.fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${repo.headSha}`,
                { signal },
              ),
            );
          const content = Buffer.from(blob.content, "base64").toString("utf8");
          sources.push({ path, content: content.slice(0, 6000) });
          if (content.length > 6000)
            warnings.push(`Excerpt truncated: ${path}`);
        } catch (e) {
          if (signal?.aborted) throw e;
          warnings.push(`Could not read ${path}`);
        }
      }
      warnings.push(
        "Remote map includes at most 6 document excerpts. Additional source and tests have not been read or executed.",
      );
      return repositoryProfile(repo.headSha, files, sources, warnings);
    } catch (e) {
      if (signal?.aborted) throw e;
      return repositoryProfile(
        repo.headSha,
        [],
        [],
        ["Repository map unavailable; do not assume source was inspected."],
      );
    }
  }
}
