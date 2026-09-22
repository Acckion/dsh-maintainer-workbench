import { z } from 'zod';
import type { Job, Repo } from './types.ts';
import type { Store } from './store.ts';
import { GitHub } from './github.ts';
import { collectPatch, git, validateCheckout } from './git.ts';
const urlSchema = z.object({ html_url: z.string().url() });
export type PublishAction = 'comment' | 'labels' | 'pr';

/** Called only by an explicit publish action after local result approval. */
export async function publish(store: Store, job: Job, repo: Repo, action: PublishAction, github = new GitHub(), executeGit: typeof git = git): Promise<string[]> {
  if (repo.mode === 'demo') throw new Error('演示任务不能发布到 GitHub');
  if (job.status !== 'approved' || !job.result) throw new Error('请先审核并接受结果');
  if (!process.env.GITHUB_TOKEN) throw new Error('发布需要服务端 GITHUB_TOKEN（仓库写权限）');
  const prior = job.publications?.[action];
  if (prior?.status === 'published') return prior.urls;
  if (prior?.status === 'publishing') throw new Error('该操作正在发布，或上次发布被中断。请先核查 GitHub 发布结果，避免重复写入。');
  const live = z.object({ updated_at: z.string() }).parse(await github.request(`/repos/${repo.fullName}/issues/${job.issueSnapshot.number}`));
  // Previous publishes by this task legitimately advance updated_at.
  if (!Object.keys(job.publications ?? {}).length && live.updated_at !== job.issueSnapshot.updatedAt) throw new Error('GitHub Issue/PR 已更新，请重新同步并分析后发布');
  if (action === 'pr' && (!job.worktree || !job.branch || !job.patch)) throw new Error('没有可发布的工作区补丁');
  if (job.worktree && await collectPatch(job.worktree, job.baseSha) !== (job.patch ?? '')) throw new Error('已审核差异发生变化，请重新派发并审核');
  const set = (status: 'publishing' | 'published' | 'failed', urls: string[], error?: string) => {
    const current = store.get<Job>('jobs', job.id)!;
    store.put('jobs', { ...current, publications: { ...current.publications, [action]: { status, urls, error, at: new Date().toISOString() } } });
    store.audit(`publish.${status}`, `${action}${error ? `：${error}` : ''}`, job.id);
  };
  set('publishing', []);
  try {
    let urls: string[] = [];
    const marker = `<!-- maintainer-workbench:${job.id}:${action} -->`;
    if (action === 'comment') {
      // Search every comment page before POST, so ambiguous network retries do not duplicate a comment.
      let existing: { html_url: string } | undefined;
      for (let page = 1; ; page++) {
        const rows = z.array(z.object({ body: z.string(), html_url: z.string().url() })).parse(await github.request(`/repos/${repo.fullName}/issues/${job.issueSnapshot.number}/comments?per_page=100&page=${page}`));
        existing = rows.find(r => r.body.includes(marker)); if (existing || rows.length < 100) break;
      }
      const result = existing ?? urlSchema.parse(await github.request(`/repos/${repo.fullName}/issues/${job.issueSnapshot.number}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: `${job.result.responseDraft}\n\n${marker}` }) }));
      urls = [result.html_url];
    } else if (action === 'labels') {
      if (!job.result.labels.length) throw new Error('没有建议标签');
      await github.request(`/repos/${repo.fullName}/issues/${job.issueSnapshot.number}/labels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: job.result.labels }) });
      urls = [job.issueSnapshot.url];
    } else {
      await validateCheckout(repo.localPath, repo);
      const worktree = job.worktree!;
      const head = await git(worktree, ['rev-parse', 'HEAD']);
      if (job.publishedCommit) {
        if (head !== job.publishedCommit) throw new Error('已提交工作区被改动，不能自动重试发布');
      } else {
        if (head !== job.baseSha) throw new Error('工作区 HEAD 已改变，不能提交未审核历史');
        const commit = await git(worktree, ['-c', 'user.name=Maintainer Workbench', '-c', 'user.email=maintainer-workbench@users.noreply.github.com', 'commit', '--no-gpg-sign', '-m', `${job.kind}: ${job.issueSnapshot.title.slice(0, 180)}`]);
        store.audit('publish.commit', commit.split('\n')[0], job.id);
        const committedSha = await git(worktree, ['rev-parse', 'HEAD']);
        store.put('jobs', { ...store.get<Job>('jobs', job.id)!, publishedCommit: committedSha });
      }
      await executeGit(worktree, ['push', `https://github.com/${repo.fullName}.git`, `HEAD:refs/heads/${job.branch}`], true);
      const [owner] = repo.fullName.split('/');
      const existing = z.array(urlSchema).parse(await github.request(`/repos/${repo.fullName}/pulls?state=all&head=${encodeURIComponent(`${owner}:${job.branch}`)}`));
      const pr = existing[0] ?? urlSchema.parse(await github.request(`/repos/${repo.fullName}/pulls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `${job.kind === 'docs' ? 'docs' : 'fix'}: ${job.issueSnapshot.title.slice(0, 180)}`, head: job.branch, base: repo.defaultBranch, draft: true, body: `Refs #${job.issueSnapshot.number}\n\n${job.result.summary}\n\n### Validation\n${job.result.tests.map(t => `- ${t.status}: \`${t.command}\`\n  ${t.output}`).join('\n')}\n\nReviewed task: ${job.id}\nBase: ${job.baseSha}\n\n${marker}` }) }));
      urls = [pr.html_url];
    }
    set('published', urls); return urls;
  } catch (error) { const message = error instanceof Error ? error.message : String(error); set('failed', [], message); throw error; }
}
