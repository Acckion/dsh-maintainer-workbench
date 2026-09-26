import { resolveGitHubAuth } from './github-auth.ts';
import { z } from 'zod';
import type { Job, Repo } from './types.ts';
import type { Store } from './store.ts';
import { GitHub } from './github.ts';
import { collectPatch, git, validateCheckout } from './git.ts';
const urlSchema = z.object({ html_url: z.string().url() });
export type PublishAction = 'comment' | 'labels' | 'pr' | 'update_pr' | 'review';

/** Called only by an explicit publish action after local result approval. */
export async function publish(store: Store, job: Job, repo: Repo, action: PublishAction, github = new GitHub(), executeGit: typeof git = git): Promise<string[]> {
  if (job.status !== 'approved' || !job.result) throw new Error('请先审核并接受结果');
  if (!(await resolveGitHubAuth()).token) throw new Error('发布需要有效的 GitHub 登录或令牌（仓库写权限）');
  const prior = job.publications?.[action];
  if (prior?.status === 'published') return prior.urls;
  if (prior?.status === 'publishing') throw new Error('该操作正在发布，或上次发布被中断。请先核查 GitHub 发布结果，避免重复写入。');
  if (job.prContext) {
    const current = await github.pullRequest(repo, job.issueSnapshot.number);
    // Retry after a successful push may observe our own recorded commit.
    if ((current.headSha !== job.prContext.headSha && !(action === 'update_pr' && current.headSha === job.publishedCommit)) || current.baseSha !== job.prContext.baseSha) throw new Error('PR head/base 已变化，旧产物不可发布');
    if (current.merged) throw new Error('PR 已合并');
  }
  const live = z.object({ updated_at: z.string() }).parse(await github.request(`/repos/${repo.fullName}/issues/${job.issueSnapshot.number}`));
  const lastReceipt = Object.values(job.publications ?? {}).filter(r => r.status === 'published').sort((a,b) => b.at.localeCompare(a.at))[0];
  const assertFresh = () => { if (live.updated_at !== (lastReceipt?.remoteUpdatedAt ?? job.issueSnapshot.updatedAt)) throw new Error('GitHub Issue/PR 已更新，请重新同步并分析后发布'); };
  if (!prior) assertFresh();
  if (['pr', 'update_pr'].includes(action) && (!job.worktree || !job.branch || !job.patch)) throw new Error('没有可发布的工作区补丁');
  if (job.worktree && await collectPatch(job.worktree, job.baseSha) !== (job.patch ?? '')) throw new Error('已审核差异发生变化，请重新派发并审核');
  const set = (status: 'publishing' | 'published' | 'failed', urls: string[], error?: string, remoteUpdatedAt?: string) => {
    const current = store.get<Job>('jobs', job.id)!;
    store.put('jobs', { ...current, publications: { ...current.publications, [action]: { status, urls, error, remoteUpdatedAt, at: new Date().toISOString() } } });
    store.audit(`publish.${status}`, `${action}${error ? `：${error}` : ''}`, job.id);
  };
  set('publishing', []);
  try {
    let urls: string[] = [];
    const marker = `<!-- maintainer-workbench:${job.id}:${action} -->`;
    if (action === 'review') {
      if (!job.prContext || job.artifact?.stage !== 'review') throw new Error('只有 PR 审查产物可以发布审查');
      const findings = job.artifact.findings.filter(f => job.findingDecisions?.[f.id] === 'accepted');
      const body = `${job.artifact.summary}\n\n覆盖范围：${job.artifact.coverage}\n\n${findings.map(f => `- ${f.severity} ${f.path}${f.line ? ':' + f.line : ''}: ${f.title}\n  ${f.trigger}\n  ${f.evidence}\n  ${f.recommendation}`).join('\n')}\n\n${marker}`;
      let existing: { html_url: string } | undefined;
      for (let page = 1; ; page++) {
        const rows = z.array(z.object({ body: z.string().nullable(), html_url: z.string().url() })).parse(await github.request(`/repos/${repo.fullName}/pulls/${job.issueSnapshot.number}/reviews?per_page=100&page=${page}`));
        existing = rows.find(r => r.body?.includes(marker)); if (existing || rows.length < 100) break;
      }
      if (!existing) assertFresh();
      const response = existing ?? urlSchema.parse(await github.request(`/repos/${repo.fullName}/pulls/${job.issueSnapshot.number}/reviews`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, event: 'COMMENT', commit_id: job.prContext.headSha }) }));
      urls = [response.html_url];
    } else if (action === 'comment') {
      // Search every comment page before POST, so ambiguous network retries do not duplicate a comment.
      let existing: { html_url: string } | undefined;
      for (let page = 1; ; page++) {
        const rows = z.array(z.object({ body: z.string(), html_url: z.string().url() })).parse(await github.request(`/repos/${repo.fullName}/issues/${job.issueSnapshot.number}/comments?per_page=100&page=${page}`));
        existing = rows.find(r => r.body.includes(marker)); if (existing || rows.length < 100) break;
      }
      if (!existing) assertFresh();
      const result = existing ?? urlSchema.parse(await github.request(`/repos/${repo.fullName}/issues/${job.issueSnapshot.number}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: `${job.result.responseDraft}\n\n${marker}` }) }));
      urls = [result.html_url];
    } else if (action === 'labels') {
      assertFresh();
      if (!job.result.labels.length) throw new Error('没有建议标签');
      await github.request(`/repos/${repo.fullName}/issues/${job.issueSnapshot.number}/labels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: job.result.labels }) });
      urls = [job.issueSnapshot.url];
    } else {
      if (action !== 'update_pr' || !job.publishedCommit) assertFresh();
      if (action === 'pr' && job.issueSnapshot.type === 'pr') throw new Error('现有 PR 请使用更新原 PR，或下载补丁');
      if (!['fix','docs'].includes(job.kind)) throw new Error('只有实施或文档产物可发布代码，实验补丁不能发布');
      if (action === 'update_pr' && (!job.prContext || job.prContext.headRepo !== repo.fullName)) throw new Error('跨仓库 fork 不自动推送，请下载补丁交给原作者');
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
      await executeGit(worktree, ['push', `https://github.com/${repo.fullName}.git`, `HEAD:refs/heads/${action === 'update_pr' ? job.prContext!.headRef : job.branch}`], true);
      if (action === 'update_pr') {
        const remote = await github.pullRequest(repo, job.issueSnapshot.number);
        const saved = store.get<Job>('jobs', job.id)!;
        if (remote.headSha !== saved.publishedCommit) throw new Error('推送后 head 未确认，请核查后重试');
        urls = [job.issueSnapshot.url];
        const confirmed = z.object({updated_at:z.string()}).parse(await github.request(`/repos/${repo.fullName}/issues/${job.issueSnapshot.number}`));
    set('published', urls, undefined, confirmed.updated_at);
        return urls;
      }
      const [owner] = repo.fullName.split('/');
      const existing = z.array(urlSchema).parse(await github.request(`/repos/${repo.fullName}/pulls?state=all&head=${encodeURIComponent(`${owner}:${job.branch}`)}`));
      const pr = existing[0] ?? urlSchema.parse(await github.request(`/repos/${repo.fullName}/pulls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `${job.kind === 'docs' ? 'docs' : 'fix'}: ${job.issueSnapshot.title.slice(0, 180)}`, head: job.branch, base: repo.defaultBranch, draft: true, body: `Refs #${job.issueSnapshot.number}\n\n${job.result.summary}\n\n### Validation\n${job.result.tests.map(t => `- ${t.status}: \`${t.command}\`\n  ${t.output}`).join('\n')}\n\nReviewed task: ${job.id}\nBase: ${job.baseSha}\n\n${marker}` }) }));
      urls = [pr.html_url];
    }
    const confirmed = z.object({updated_at:z.string()}).parse(await github.request(`/repos/${repo.fullName}/issues/${job.issueSnapshot.number}`));
    set('published', urls, undefined, confirmed.updated_at);
    if (action === 'pr') { const issue = store.get<import('./types.ts').Issue>('issues', job.issueId); if (issue) store.put('issues', { ...issue, linkedPullRequests: [...new Set([...(issue.linkedPullRequests ?? []), ...urls])], workflow: {stage:'track',reason:'草稿 PR 已创建，等待审查及远端合并；事项尚未解决',updatedAt:new Date().toISOString()} }); }
    return urls;
  } catch (error) { const message = error instanceof Error ? error.message : String(error); set('failed', [], message); throw error; }
}
