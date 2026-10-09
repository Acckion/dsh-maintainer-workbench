import { z } from "zod";
import { resolveGitHubAuth } from "../../core/github-auth.ts";
import {
  type ActionsLog,
  type ActionsSnapshot,
} from "../../core/remote-progress.ts";
import type { Repo } from "../../core/types.ts";

import { GitHubResourceClient } from "./transport.ts";
export class ActionsClient extends GitHubResourceClient {
  async actions(
    repo: Repo,
    headSha: string,
    signal?: AbortSignal,
  ): Promise<ActionsSnapshot> {
    z.string()
      .regex(/^[a-f0-9]{40,64}$/)
      .parse(headSha);
    const root = `/repos/${repo.fullName}/actions`,
      warnings: string[] = [],
      jobs: ActionsSnapshot["jobs"] = [];
    const runs = z
      .object({
        total_count: z.number(),
        workflow_runs: z.array(
          z.object({
            id: z.number().int().positive(),
            head_sha: z.string(),
            run_attempt: z.number().int().positive(),
          }),
        ),
      })
      .parse(
        await this.request(`${root}/runs?head_sha=${headSha}&per_page=20`, {
          signal,
        }),
      );
    if (runs.total_count > 20)
      warnings.push("仅覆盖当前提交最近 20 个 workflow run");
    for (const run of runs.workflow_runs) {
      if (run.head_sha !== headSha) {
        warnings.push("忽略了其他提交的 run");
        continue;
      }
      if (run.run_attempt > 3)
        warnings.push(`run ${run.id} 仅覆盖最近 3 次执行`);
      for (
        let attempt = run.run_attempt;
        attempt >= Math.max(1, run.run_attempt - 2);
        attempt--
      ) {
        try {
          const list = z
            .object({
              total_count: z.number(),
              jobs: z.array(
                z.object({
                  id: z.number().int().positive(),
                  run_id: z.number(),
                  head_sha: z.string(),
                  name: z.string(),
                  html_url: z.string().url(),
                  status: z.string(),
                  conclusion: z.string().nullable(),
                  steps: z
                    .array(
                      z.object({
                        name: z.string(),
                        number: z.number(),
                        status: z.string(),
                        conclusion: z.string().nullable(),
                      }),
                    )
                    .optional(),
                }),
              ),
            })
            .parse(
              await this.request(
                `${root}/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`,
                { signal },
              ),
            );
          if (list.total_count > 100)
            warnings.push(`run ${run.id}/${attempt} 仅覆盖前 100 个 job`);
          for (const j of list.jobs)
            if (j.head_sha === headSha && j.run_id === run.id)
              jobs.push({
                id: j.id,
                runId: run.id,
                attempt,
                headSha,
                name: j.name,
                url: j.html_url,
                status: j.status,
                conclusion: j.conclusion,
                steps: j.steps ?? [],
              });
            else warnings.push("忽略了目标不一致的 job");
        } catch (e) {
          if (signal?.aborted) throw e;
          warnings.push(
            `run ${run.id}/${attempt} 读取失败：${e instanceof Error ? e.message : "未知错误"}`,
          );
        }
      }
    }
    return { headSha, syncedAt: new Date().toISOString(), jobs, warnings };
  }
  async actionLog(
    repo: Repo,
    snapshot: ActionsSnapshot,
    jobId: number,
    signal?: AbortSignal,
  ): Promise<ActionsLog> {
    const job = snapshot.jobs.find((j) => j.id === jobId);
    if (!job) throw Error("任务不在已同步的 Actions 范围");
    const actual = z
      .object({ id: z.number(), run_id: z.number(), head_sha: z.string() })
      .parse(
        await this.request(`/repos/${repo.fullName}/actions/jobs/${jobId}`, {
          signal,
        }),
      );
    if (
      actual.id !== job.id ||
      actual.run_id !== job.runId ||
      actual.head_sha !== snapshot.headSha
    )
      throw Error("Actions job 目标已变化");
    const auth = await resolveGitHubAuth(this.token);
    const response = await this.fetcher(
      `https://api.github.com/repos/${repo.fullName}/actions/jobs/${jobId}/logs`,
      {
        redirect: "manual",
        signal: signal ?? AbortSignal.timeout(30000),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
        },
      },
    );
    if (response.status !== 302)
      throw Error(
        `日志不可读取（HTTP ${response.status}），可能未生成、已过期或无权限`,
      );
    const target = new URL(response.headers.get("location") ?? "");
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      !/(^|\.)(githubusercontent\.com|blob\.core\.windows\.net|actions\.githubusercontent\.com)$/.test(
        target.hostname,
      )
    )
      throw Error("日志下载地址不受支持");
    // Signed log URL receives no GitHub credential and cannot redirect again.
    const log = await this.fetcher(target, {
      redirect: "error",
      signal: signal ?? AbortSignal.timeout(30000),
    });
    if (!log.ok || !log.body) throw Error(`日志下载失败（HTTP ${log.status}）`);
    const reader = log.body.getReader(),
      chunks: Uint8Array[] = [],
      limit = 512 * 1024;
    let size = 0,
      truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const available = limit - size;
        chunks.push(value.slice(0, available));
        size += Math.min(available, value.length);
        if (value.length > available || size === limit) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    return {
      jobId,
      runId: job.runId,
      attempt: job.attempt,
      headSha: snapshot.headSha,
      text: Buffer.concat(chunks).toString("utf8"),
      truncated,
      fetchedAt: new Date().toISOString(),
    };
  }
}
