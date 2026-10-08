import { githubRequest } from './github-request.ts';
import { resolveGitHubAuth } from './github-auth.ts';
import { contextPaths, repositoryProfile } from './repository-context.ts';
import { z } from 'zod';
import type { Issue, Repo } from './types.ts';
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const issueSchema = z.object({ number: z.number(), title: z.string(), body: z.string().nullable(), user: z.object({ login: z.string() }).nullable(), labels: z.array(z.union([z.string(), z.object({ name: z.string() })])), state: z.enum(['open', 'closed']), comments: z.number(), updated_at: z.string(), html_url: z.string().url(), pull_request: z.object({ url: z.string(), merged_at:z.string().nullable().optional() }).optional() });
export class GitHub {
  constructor(private token?: string, private fetcher: typeof fetch = fetch) {}
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const auth = await resolveGitHubAuth(this.token);
    const response = await githubRequest(this.fetcher, `https://api.github.com${path}`, { ...init, signal: init.signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'maintainer-workbench/0.1', ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}), ...init.headers } });
    return response.json();
  }
  async connection() {
    const auth = await resolveGitHubAuth(this.token);
    if (!auth.token) return { source: auth.source, authenticated: false };
    try {
      const user = z.object({ login: z.string() }).parse(await new GitHub(auth.token, this.fetcher).request('/user'));
      return { source: auth.source, authenticated: true, login: user.login };
    } catch (error) { return { source: auth.source, authenticated: false, error: error instanceof Error ? error.message : '连接验证失败', errorKind: error && typeof error === 'object' && 'kind' in error ? String(error.kind) : 'unknown' }; }
  }
  async sync(fullName: string): Promise<{ repo: Repo; issues: Issue[] }> {
    nameSchema.parse(fullName);
    const meta = z.object({ full_name: z.string(), description: z.string().nullable(), default_branch: z.string(), private: z.boolean().optional() }).parse(await this.request(`/repos/${fullName}`));
    const commit = z.object({ sha: z.string() }).parse(await this.request(`/repos/${fullName}/commits/${encodeURIComponent(meta.default_branch)}`));
    const issues: Issue[] = [];
    let truncated = false;
    for (let page = 1; page <= 10; page++) {
      const rows = z.array(issueSchema).parse(await this.request(`/repos/${fullName}/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`));
      for (const row of rows) issues.push({ id: `${meta.full_name}#${row.number}`, repoId: meta.full_name, number: row.number, type: row.pull_request ? 'pr' : 'issue', merged: row.pull_request?.merged_at ? true : row.pull_request?.merged_at === null ? false : undefined, title: row.title, body: row.body ?? '', author: row.user?.login ?? 'deleted', labels: row.labels.map(l => typeof l === 'string' ? l : l.name), state: row.state, comments: row.comments, updatedAt: row.updated_at, url: row.html_url });
      if (rows.length < 100) break;
      if (page === 10) truncated = true;
    }
    let prWarning = '';
    if (issues.some(i => i.type === 'pr' && i.state === 'open')) {
      try {
        for (let page = 1; page <= 10; page++) {
          const prs = z.array(z.object({ number: z.number(), head: z.object({ sha:z.string() }), base:z.object({ sha:z.string() }) })).parse(await this.request(`/repos/${fullName}/pulls?state=open&per_page=100&page=${page}`));
          for (const pr of prs) { const issue = issues.find(i => i.type === 'pr' && i.number === pr.number); if (issue) { issue.headSha = pr.head.sha; issue.prBaseSha = pr.base.sha; } }
          if (prs.length < 100) break;
        }
      } catch { prWarning = 'PR 版本列表未完整获取；执行和发布前会再次固定远端版本。'; }
    }
    return { repo: { id: meta.full_name, fullName: meta.full_name, description: meta.description ?? '', private: meta.private, defaultBranch: meta.default_branch, headSha: commit.sha, localPath: '', mode: 'github', syncedAt: new Date().toISOString(), syncWarning: [truncated ? '只同步最近更新的 1000 条记录，较早的记录未覆盖。' : '', prWarning].filter(Boolean).join(' ') || null }, issues };
  }
  async profile(repo: Repo, signal?: AbortSignal) {
    try {
      const tree = z.object({ truncated: z.boolean().optional(), tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string().optional() })) }).parse(await this.request(`/repos/${repo.fullName}/git/trees/${repo.headSha}?recursive=1`, { signal }));
      const files = tree.tree.filter(f => f.type === 'blob').map(f => f.path);
      const warnings = tree.truncated ? ['GitHub tree is truncated; repository map is partial.'] : [];
      const sources: { path: string; content: string }[] = [];
      const paths = contextPaths(files).filter(p => tree.tree.some(f => f.path === p && f.mode !== '120000')).slice(0, 6);
      for (const path of paths) {
        try {
          const blob = z.object({ content: z.string(), encoding: z.literal('base64') }).parse(await this.request(`/repos/${repo.fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${repo.headSha}`, { signal }));
          const content = Buffer.from(blob.content, 'base64').toString('utf8'); sources.push({ path, content: content.slice(0, 6000) });
          if (content.length > 6000) warnings.push(`Excerpt truncated: ${path}`);
        } catch (e) { if (signal?.aborted) throw e; warnings.push(`Could not read ${path}`); }
      }
      warnings.push('Remote map includes at most 6 document excerpts. Additional source and tests have not been read or executed.');
      return repositoryProfile(repo.headSha, files, sources, warnings);
    } catch (e) { if (signal?.aborted) throw e; return repositoryProfile(repo.headSha, [], [], ['Repository map unavailable; do not assume source was inspected.']); }
  }
  async pullRequest(repo: Repo, number: number, signal?: AbortSignal): Promise<import('./types.ts').PRContext> {
    const pr = z.object({ head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/), ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }), base: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/), ref: z.string() }), draft: z.boolean(), merged: z.boolean(), mergeable: z.boolean().nullable() }).parse(await this.request(`/repos/${repo.fullName}/pulls/${number}`, { signal }));
    const warnings: string[] = [];
    const optional = async (path: string) => { try { return await this.request(path, { signal }); } catch (e) { if (signal?.aborted) throw e; warnings.push(`无法读取 ${path}: ${e instanceof Error ? e.message : '未知错误'}`); return null; } };
    const [checks, reviews, reviewComments, commitStatus] = await Promise.all([optional(`/repos/${repo.fullName}/commits/${pr.head.sha}/check-runs?per_page=100`), optional(`/repos/${repo.fullName}/pulls/${number}/reviews?per_page=100`), optional(`/repos/${repo.fullName}/pulls/${number}/comments?per_page=100`), optional(`/repos/${repo.fullName}/commits/${pr.head.sha}/status`)]);
    return { headSha: pr.head.sha, baseSha: pr.base.sha, headRef: pr.head.ref, headRepo: pr.head.repo?.full_name ?? null, baseRef: pr.base.ref, draft: pr.draft, merged: pr.merged, mergeable: pr.mergeable, checks, reviews, reviewComments, commitStatus, warnings: [...warnings, '检查和审查最多各 100 条；分支保护规则和未解决讨论未完整覆盖，不构成合并许可。'] };
  }
  async context(repo: Repo, issue: Issue, signal: AbortSignal, metadataOnly = false, expected?: import('./types.ts').PRContext): Promise<string> {
    const comments = await this.request(`/repos/${repo.githubName ?? repo.fullName}/issues/${issue.number}/comments?per_page=30`, { signal });
    let extra: unknown = null;
    if (issue.type === 'pr' && !metadataOnly) {
      const pr = z.object({ head: z.object({ sha: z.string() }), base: z.object({ sha: z.string() }), changed_files: z.number() }).parse(await this.request(`/repos/${repo.fullName}/pulls/${issue.number}`, { signal }));
      if (expected && (pr.head.sha !== expected.headSha || pr.base.sha !== expected.baseSha)) throw new Error('PR 在上下文读取期间已更新，请同步后重试');
      const files = await this.request(`/repos/${repo.fullName}/pulls/${issue.number}/files?per_page=100`, { signal });
      const after = z.object({ head:z.object({sha:z.string()}), base:z.object({sha:z.string()}) }).parse(await this.request(`/repos/${repo.fullName}/pulls/${issue.number}`, {signal}));
      if (after.head.sha !== pr.head.sha || after.base.sha !== pr.base.sha) throw new Error('读取 diff 时 PR 已更新，请同步后重试');
      extra = { ...pr, files, coverage: pr.changed_files > 100 ? 'Only first 100 files; partial review' : 'Up to 100 files; patches may be truncated by GitHub' };
    }
    const data = JSON.stringify({ comments:metadataOnly && Array.isArray(comments) ? comments.map(c=>({user:{login:c.user?.login},body:String(c.body ?? '').slice(0,1200)})) : comments, pullRequest: extra });
    return metadataOnly ? data : data.slice(0,65000);
  }
}
