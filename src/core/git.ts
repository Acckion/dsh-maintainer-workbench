import { resolveGitHubAuth } from './github-auth.ts';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { mkdir, realpath, rename, rm, mkdtemp } from 'node:fs/promises';
import type { Job, Repo } from './types.ts';
const exec = promisify(execFile);
export async function git(cwd: string, args: string[], authenticate = false, signal?: AbortSignal, timeout = 30000, preserveOutput = false): Promise<string> { const auth = authenticate ? await resolveGitHubAuth() : undefined; const output = (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, timeout, signal, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(auth?.token ? { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + auth.token).toString('base64'), GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '' } : {}) } })).stdout; return preserveOutput ? output : output.trimEnd(); }
export async function validateCheckout(path: string, repo: Repo): Promise<string> {
  const canonical = await realpath(path);
  const root = await git(canonical, ['rev-parse', '--show-toplevel']);
  if (await realpath(root) !== canonical) throw new Error('请选择 Git 仓库根目录');
  if (repo.mode === 'local') return canonical;
  const origin = await git(canonical, ['remote', 'get-url', 'origin']);
  const normalized = origin.replace(/\.git$/, '').replace(/\/$/, '');
  if (![ `https://github.com/${repo.fullName}`, `git@github.com:${repo.fullName}`, `ssh://git@github.com/${repo.fullName}` ].some(s => s.toLowerCase() === normalized.toLowerCase())) throw new Error('本地 origin 与所选 GitHub 仓库不匹配');
  return canonical;
}
export async function prepareWorktree(repo: Repo, job: Job, dataDir: string): Promise<{ path: string; branch: string }> {
  if (!repo.localPath) throw new Error('请先在仓库设置中绑定本地 Git 克隆，以便在独立 worktree 中执行');
  await validateCheckout(repo.localPath, repo);
  await git(repo.localPath, ['cat-file', '-e', `${job.baseSha}^{commit}`]).catch(() => { throw new Error('本地仓库缺少同步时的提交。请先 git fetch，然后重新派发任务。'); });
  const parent = resolve(dataDir, 'worktrees');
  await mkdir(parent, { recursive: true });
  const branch = `maintainer/${job.kind}-${job.issueSnapshot.number}-${job.id.slice(0, 8)}`;
  const path = join(parent, job.id);
  await git(repo.localPath, ['worktree', 'add', '-b', branch, path, job.baseSha]);
  return { path, branch };
}
export async function collectPatch(path: string, base = 'HEAD'): Promise<string> {
  // Only the plugin-owned worktree index is changed. Untracked new files are included.
  await git(path, ['add', '--all']);
  const patch = await git(path, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', base, '--'], false, undefined, 30000, true);
  // Binary blocks need their closing blank line; trimming can silently drop the last file.
  // Retain the existing text-only representation so historical approvals stay comparable.
  return patch.includes('GIT binary patch\n') ? patch : patch.trimEnd();
}

/** Plugin-owned clone, used only when no user checkout is bound. Clone never executes repository scripts. */
export async function prepareManagedCheckout(repo: Repo, dataDir: string, signal?: AbortSignal, executeGit: typeof git = git): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo.fullName) || !/^[a-f0-9]{40,64}$/.test(repo.headSha)) throw new Error('仓库名称或提交编号无效');
  const parent = resolve(dataDir, 'repositories'); await mkdir(parent, { recursive: true });
  const path = join(parent, createHash('sha256').update(repo.fullName.toLowerCase()).digest('hex').slice(0, 20));
  try { await realpath(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const temporary = await mkdtemp(join(parent, '.clone-'));
    try {
      await executeGit(parent, ['clone', '--no-checkout', '--', `https://github.com/${repo.fullName}.git`, temporary], true, signal, 240000);
      await rename(temporary, path);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  await validateCheckout(path, repo);
  try { await executeGit(path, ['cat-file', '-e', `${repo.headSha}^{commit}`], false, signal); }
  catch { await executeGit(path, ['fetch', 'origin', repo.headSha], true, signal, 120000); }
  return path;
}

/** Fetch GitHub's PR head ref, including forks, then require the exact API snapshot. */
export async function fetchPullRequestRevision(repo: Repo, number: number, pr: import('./types.ts').PRContext, signal?: AbortSignal, executeGit: typeof git = git): Promise<void> {
  if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40,64}$/.test(pr.headSha) || !/^[a-f0-9]{40,64}$/.test(pr.baseSha)) throw new Error('PR 版本信息无效');
  await executeGit(repo.localPath, ['fetch', 'origin', `refs/pull/${number}/head`], true, signal);
  const fetched = await executeGit(repo.localPath, ['rev-parse', 'FETCH_HEAD']);
  if (fetched !== pr.headSha) throw new Error('PR 在准备过程中已更新，请重新派发');
  await executeGit(repo.localPath, ['fetch', 'origin', pr.baseSha], true, signal);
}
