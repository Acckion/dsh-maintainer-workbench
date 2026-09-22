import { contextPaths, repositoryProfile } from './repository-context.ts';
import { z } from 'zod';
import type { Issue, Repo } from './types.ts';
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const issueSchema = z.object({ number: z.number(), title: z.string(), body: z.string().nullable(), user: z.object({ login: z.string() }).nullable(), labels: z.array(z.union([z.string(), z.object({ name: z.string() })])), state: z.enum(['open', 'closed']), comments: z.number(), updated_at: z.string(), html_url: z.string().url(), pull_request: z.object({ url: z.string() }).optional() });
export class GitHub {
  constructor(private token?: string, private fetcher: typeof fetch = fetch) {}
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetcher(`https://api.github.com${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(30000), headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'maintainer-workbench/0.1', ...((this.token ?? process.env.GITHUB_TOKEN) ? { Authorization: `Bearer ${this.token ?? process.env.GITHUB_TOKEN}` } : {}), ...init.headers } });
    if (!response.ok) throw new Error(`GitHub ${response.status}${response.status === 403 || response.status === 429 ? '：权限不足或 API 限流，请配置 GITHUB_TOKEN 后重试' : response.status === 404 ? '：仓库不存在，或令牌无读取权限' : '：请求失败'}`);
    return response.json();
  }
  async sync(fullName: string): Promise<{ repo: Repo; issues: Issue[] }> {
    nameSchema.parse(fullName);
    const meta = z.object({ full_name: z.string(), description: z.string().nullable(), default_branch: z.string() }).parse(await this.request(`/repos/${fullName}`));
    const commit = z.object({ sha: z.string() }).parse(await this.request(`/repos/${fullName}/commits/${encodeURIComponent(meta.default_branch)}`));
    const issues: Issue[] = [];
    let truncated = false;
    for (let page = 1; page <= 10; page++) {
      const rows = z.array(issueSchema).parse(await this.request(`/repos/${fullName}/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`));
      for (const row of rows) issues.push({ id: `${meta.full_name}#${row.number}`, repoId: meta.full_name, number: row.number, type: row.pull_request ? 'pr' : 'issue', title: row.title, body: row.body ?? '', author: row.user?.login ?? 'deleted', labels: row.labels.map(l => typeof l === 'string' ? l : l.name), state: row.state, comments: row.comments, updatedAt: row.updated_at, url: row.html_url });
      if (rows.length < 100) break;
      if (page === 10) truncated = true;
    }
    return { repo: { id: meta.full_name, fullName: meta.full_name, description: meta.description ?? '', defaultBranch: meta.default_branch, headSha: commit.sha, localPath: '', mode: 'github', syncedAt: new Date().toISOString(), syncWarning: truncated ? '只同步最近更新的 1000 条记录，较早的记录未覆盖。' : null }, issues };
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
  async context(repo: Repo, issue: Issue, signal: AbortSignal): Promise<string> {
    const comments = await this.request(`/repos/${repo.fullName}/issues/${issue.number}/comments?per_page=30`, { signal });
    let extra: unknown = null;
    if (issue.type === 'pr') {
      const pr = z.object({ head: z.object({ sha: z.string() }), base: z.object({ sha: z.string() }), changed_files: z.number() }).parse(await this.request(`/repos/${repo.fullName}/pulls/${issue.number}`, { signal }));
      const files = await this.request(`/repos/${repo.fullName}/pulls/${issue.number}/files?per_page=100`, { signal });
      extra = { ...pr, files, coverage: pr.changed_files > 100 ? 'Only first 100 files; partial review' : 'Up to 100 files; patches may be truncated by GitHub' };
    }
    return JSON.stringify({ comments, pullRequest: extra }).slice(0, 65000);
  }
}
