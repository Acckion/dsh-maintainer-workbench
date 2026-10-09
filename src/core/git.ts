import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { repositoryLocks } from "../infrastructure/git/locks.ts";
import { resolveGitHubAuth } from "./github-auth.ts";
import type { Job, Repo } from "./types.ts";
const exec = promisify(execFile);
export function gitFailure(error: unknown, operation: string, timeout: number): Error {
  const value = error as { name?: string; killed?: boolean; signal?: string; code?: string; stderr?: string; message?: string };
  if (value?.name === 'AbortError') return error as Error;
  const label = operation === 'clone' ? '仓库克隆' : operation === 'fetch' ? '仓库提交下载' : 'Git 操作';
  if (value?.killed && value.signal === 'SIGTERM') return new Error(`${label}超过 ${Math.round(timeout / 1000)} 秒，已停止。GitHub 连接可用并不代表源码下载已完成；请检查网络传输或绑定已有本地克隆后重试。`, {cause:error});
  const detail = (value?.stderr || value?.message || String(error))
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .trim().slice(-2000);
  return new Error(`${label}失败：${detail}`, {cause:error});
}
export async function git(
  cwd: string,
  args: string[],
  authenticate = false,
  signal?: AbortSignal,
  timeout = 30000,
  preserveOutput = false,
  indexPath?: string,
): Promise<string> {
  const auth = authenticate ? await resolveGitHubAuth() : undefined;
  let output: string;
  try { output = (
    await exec(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        timeout,
        signal,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}),
          ...(auth?.token
            ? {
                GIT_CONFIG_COUNT: "2",
                GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
                GIT_CONFIG_VALUE_0:
                  "AUTHORIZATION: basic " +
                  Buffer.from("x-access-token:" + auth.token).toString(
                    "base64",
                  ),
                GIT_CONFIG_KEY_1: "credential.helper",
                GIT_CONFIG_VALUE_1: "",
              }
            : {}),
        },
      },
    )
  ).stdout; } catch (error) { throw gitFailure(error, args[0] ?? '', timeout); }
  return preserveOutput ? output : output.trimEnd();
}
export async function validateCheckout(
  path: string,
  repo: Repo,
): Promise<string> {
  const canonical = await realpath(path);
  const root = await git(canonical, ["rev-parse", "--show-toplevel"]);
  if ((await realpath(root)) !== canonical)
    throw new Error("请选择 Git 仓库根目录");
  const remote =
    repo.githubName ?? (repo.mode === "github" ? repo.fullName : undefined);
  if (!remote) return canonical;
  const origin = await git(canonical, ["remote", "get-url", "origin"]);
  const normalized = origin.replace(/\.git$/, "").replace(/\/$/, "");
  if (
    ![
      `https://github.com/${remote}`,
      `git@github.com:${remote}`,
      `ssh://git@github.com/${remote}`,
    ].some((s) => s.toLowerCase() === normalized.toLowerCase())
  )
    throw new Error(`本地 origin 与所选 GitHub 仓库（${remote}）不匹配`);
  return canonical;
}
async function createWorktree(
  repo: Repo,
  job: Job,
  dataDir: string,
): Promise<{ path: string; branch: string }> {
  if (!repo.localPath)
    throw new Error(
      "请先在仓库设置中绑定本地 Git 克隆，以便在独立 worktree 中执行",
    );
  await validateCheckout(repo.localPath, repo);
  await git(repo.localPath, [
    "cat-file",
    "-e",
    `${job.baseSha}^{commit}`,
  ]).catch(() => {
    throw new Error(
      "本地仓库缺少同步时的提交。请先 git fetch，然后重新派发任务。",
    );
  });
  const parent = resolve(dataDir, "worktrees");
  await mkdir(parent, { recursive: true });
  const branch = `maintainer/${job.kind}-${job.issueSnapshot.number}-${job.id}`;
  const path = join(parent, job.id);
  await git(repo.localPath, [
    "worktree",
    "add",
    "-b",
    branch,
    path,
    job.baseSha,
  ]);
  return { path, branch };
}
export async function prepareWorktree(
  repo: Repo,
  job: Job,
  dataDir: string,
): Promise<{ path: string; branch: string }> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(job.id))
    throw new Error("无效的任务工作区标识");
  const root = await realpath(repo.localPath);
  return repositoryLocks.run(root, () => createWorktree(repo, job, dataDir));
}

export async function collectPatch(
  path: string,
  base = "HEAD",
  preserveWhitespace = false,
  indexPath?: string,
): Promise<string> {
  // Only the plugin-owned worktree index is changed. Untracked new files are included.
  await git(path, ["add", "--all"], false, undefined, 30000, false, indexPath);
  const patch = await git(
    path,
    [
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      base,
      "--",
    ],
    false,
    undefined,
    30000,
    true,
    indexPath,
  );
  // Binary blocks need their closing blank line; trimming can silently drop the last file.
  // Retain the existing text-only representation so historical approvals stay comparable.
  return preserveWhitespace || patch.includes("GIT binary patch\n")
    ? patch
    : patch.trimEnd();
}

/** Plugin-owned clone, used only when no user checkout is bound. Clone never executes repository scripts. */
export async function prepareManagedCheckout(
  repo: Repo,
  dataDir: string,
  signal?: AbortSignal,
  executeGit: typeof git = git,
): Promise<string> {
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo.fullName) ||
    !/^[a-f0-9]{40,64}$/.test(repo.headSha)
  )
    throw new Error("仓库名称或提交编号无效");
  const parent = resolve(dataDir, "repositories");
  await mkdir(parent, { recursive: true });
  const path = join(
    parent,
    createHash("sha256")
      .update(repo.fullName.toLowerCase())
      .digest("hex")
      .slice(0, 20),
  );
  try {
    await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const temporary = await mkdtemp(join(parent, ".clone-"));
    try {
      await executeGit(
        parent,
        [
          "clone",
          "--no-checkout",
          "--depth=64",
          "--single-branch",
          "--no-tags",
          "--",
          `https://github.com/${repo.fullName}.git`,
          temporary,
        ],
        true,
        signal,
        360000,
      );
      await rename(temporary, path);
    } catch (error) {
      throw new Error(
        gitFailureMessage(
          error,
          `克隆 GitHub 仓库 ${repo.fullName} 失败`,
          "克隆 GitHub 仓库超时（超过 6 分钟），请检查网络后重试",
        ),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  await validateCheckout(path, repo);
  try {
    await executeGit(
      path,
      ["cat-file", "-e", `${repo.headSha}^{commit}`],
      false,
      signal,
    );
  } catch {
    const shallow = (await executeGit(path, ['rev-parse', '--is-shallow-repository'])) === 'true';
    try {
      await executeGit(
        path,
        ["fetch", "--no-tags", ...(shallow ? ["--depth=64"] : []), "origin", repo.headSha],
        true,
        signal,
        120000,
      );
    } catch (error) {
      throw new Error(
        gitFailureMessage(
          error,
          `拉取 ${repo.fullName} 的提交 ${repo.headSha.slice(0, 7)} 失败`,
          "拉取提交超时（超过 2 分钟），请检查网络后重试",
        ),
      );
    }
  }
  return path;
}

function gitFailureMessage(
  error: unknown,
  fallback: string,
  timeoutMessage: string,
): string {
  const failure = error as {
    killed?: boolean;
    signal?: string | null;
    stderr?: string;
  };
  if (failure.killed || failure.signal) return timeoutMessage;
  const firstLine = (failure.stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0];
  return firstLine ? `${fallback}：${firstLine}` : fallback;
}

/** Fetch GitHub's PR head ref, including forks, then require the exact API snapshot. */
async function fetchRevision(
  repo: Repo,
  number: number,
  pr: import("./types.ts").PRContext,
  signal?: AbortSignal,
  executeGit: typeof git = git,
): Promise<void> {
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[a-f0-9]{40,64}$/.test(pr.headSha) ||
    !/^[a-f0-9]{40,64}$/.test(pr.baseSha)
  )
    throw new Error("PR 版本信息无效");
  const shallow = (await executeGit(repo.localPath, ['rev-parse', '--is-shallow-repository'])) === 'true';
  const options = shallow ? ['--no-tags', '--depth=64'] : [];
  await executeGit(
    repo.localPath,
    ["fetch", ...options, "origin", `refs/pull/${number}/head`],
    true,
    signal,
    120000,
  );
  const fetched = await executeGit(repo.localPath, ["rev-parse", "FETCH_HEAD"]);
  if (fetched !== pr.headSha)
    throw new Error("PR 在准备过程中已更新，请重新派发");
  await executeGit(
    repo.localPath,
    ["fetch", ...options, "origin", pr.baseSha],
    true,
    signal,
    120000,
  );
  // Shallow clones still contain full source blobs. Extend ancestry only when
  // needed for a trustworthy PR merge-base; never review an incomplete range.
  if (shallow) {
    for (const depth of [0, 256, 1024, 4096]) {
      if (depth) await executeGit(repo.localPath, ['fetch', '--no-tags', `--deepen=${depth}`, 'origin', pr.headSha, pr.baseSha], true, signal, 240000);
      try { await executeGit(repo.localPath, ['merge-base', pr.baseSha, pr.headSha], false, signal); return; }
      catch (error) { if (signal?.aborted) throw error; }
    }
    throw new Error('PR 的共同祖先尚未下载完整，已暂停审查。请绑定包含完整历史的本地克隆后重试，避免审查错误的变更范围。');
  }
}

export async function fetchPullRequestRevision(
  repo: Repo,
  number: number,
  pr: import("./types.ts").PRContext,
  signal?: AbortSignal,
  executeGit: typeof git = git,
): Promise<void> {
  const root = await realpath(repo.localPath).catch(() =>
    resolve(repo.localPath),
  );
  return repositoryLocks.run(root, () =>
    fetchRevision(repo, number, pr, signal, executeGit),
  );
}
