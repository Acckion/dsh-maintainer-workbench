import { z } from 'zod';
import type { GitHub } from './github.ts';
import type { Issue, Repo } from './types.ts';

export const detailSections = ['summary', 'activity', 'files', 'commits', 'checks'] as const;
export type DetailSection = typeof detailSections[number];
export interface DetailRow {
  id: string; kind: string; author: string; at: string; body: string; url?: string;
  title?: string; path?: string; previousPath?: string; patch?: string; sha?: string;
  additions?: number; deletions?: number; status?: string; line?: number;
}
export interface ItemDetail {
  section: DetailSection; page: number; fetchedAt: string; rows: DetailRow[];
  more: boolean; warnings: string[]; revision?: string;
  summary?: {
    title: string; body: string; author: string; state: string; createdAt: string; updatedAt: string;
    labels: string[]; assignees: string[]; url: string; draft?: boolean; merged?: boolean;
    headRef?: string; baseRef?: string; headSha?: string; baseSha?: string;
    additions?: number; deletions?: number; changedFiles?: number; mergeable?: boolean | null;
  };
}
const actor = z.object({ login: z.string() }).nullable().optional();
const rowSchema = z.object({ id: z.union([z.string(), z.number()]).nullish(), node_id: z.string().nullish(), event: z.string().optional(), user: actor, actor,
  created_at: z.string().optional(), submitted_at: z.string().nullable().optional(), body: z.string().nullable().optional(), html_url: z.string().optional(),
  commit_id: z.string().nullable().optional(), state: z.string().optional(), label: z.object({ name: z.string() }).optional(),
  path: z.string().optional(), line: z.number().nullable().optional(), original_line: z.number().nullable().optional(), diff_hunk: z.string().optional(),
  sha: z.string().optional(), author: z.object({ name: z.string().optional(), date: z.string().optional() }).nullable().optional(), committer: z.object({ date: z.string().optional() }).nullable().optional(),
  source: z.object({ issue: z.object({ title: z.string(), number: z.number(), html_url: z.string() }).optional() }).optional(),
  assignee: actor, milestone: z.object({ title: z.string() }).nullable().optional(), rename: z.object({ from: z.string(), to: z.string() }).optional(),
});
const issueSchema = z.object({ title: z.string(), body: z.string().nullable(), state: z.string(), user: actor, created_at: z.string(), updated_at: z.string(), html_url: z.string(), labels: z.array(z.object({ name: z.string() })), assignees: z.array(z.object({ login: z.string() })).optional() });
const prSchema = z.object({ head: z.object({ sha: z.string(), ref: z.string(), label: z.string().optional() }), base: z.object({ sha: z.string(), ref: z.string() }), draft: z.boolean(), merged: z.boolean(), mergeable: z.boolean().nullable(), additions: z.number(), deletions: z.number(), changed_files: z.number() });

/** Read-only GitHub browsing. It never queues an Agent or changes remote state. */
export async function githubDetail(github: Pick<GitHub, 'request'>, repo: Repo, issue: Issue, section: DetailSection, page = 1): Promise<ItemDetail> {
  const name = repo.githubName ?? repo.fullName;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || issue.origin || repo.mode === 'local' && !repo.githubName) throw new Error('此事项没有对应的 GitHub 记录，可查看本地说明和 Agent 流程。');
  if (!Number.isInteger(page) || page < 1 || page > 30) throw new Error('无效的详情页码');
  if (issue.type !== 'pr' && ['files', 'commits', 'checks'].includes(section)) throw new Error('此页签仅适用于 Pull Request');
  const prefix = `/repos/${name}`;
  const result: ItemDetail = { section, page, fetchedAt: new Date().toISOString(), rows: [], more: false, warnings: [] };
  const getPR = async () => prSchema.parse(await github.request(`${prefix}/pulls/${issue.number}`));
  if (section === 'summary') {
    const info = issueSchema.parse(await github.request(`${prefix}/issues/${issue.number}`));
    result.summary = { title: info.title, body: info.body ?? '', author: info.user?.login ?? 'deleted', state: info.state, createdAt: info.created_at, updatedAt: info.updated_at, url: info.html_url, labels: info.labels.map(l => l.name), assignees: info.assignees?.map(a => a.login) ?? [] };
    if (issue.type === 'pr') {
      const pr = await getPR(); result.revision = pr.head.sha;
      Object.assign(result.summary, { headRef: pr.head.label ?? pr.head.ref, baseRef: pr.base.ref, headSha: pr.head.sha, baseSha: pr.base.sha, draft: pr.draft, merged: pr.merged, mergeable: pr.mergeable, additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changed_files });
    }
    return result;
  }
  const query = `per_page=100&page=${page}`;
  if (section === 'activity') {
    const rows = z.array(rowSchema).parse(await github.request(`${prefix}/issues/${issue.number}/timeline?${query}`));
    result.more = rows.length === 100;
    result.rows = rows.map((r, index) => ({ id: `timeline-${r.node_id ?? r.id ?? `${page}-${index}`}`, kind: r.event ?? 'event', author: r.user?.login ?? r.actor?.login ?? r.author?.name ?? 'GitHub', at: r.created_at ?? r.submitted_at ?? r.committer?.date ?? r.author?.date ?? '', body: r.body ?? r.label?.name ?? r.assignee?.login ?? r.milestone?.title ?? (r.source?.issue ? `#${r.source.issue.number} ${r.source.issue.title}` : undefined) ?? (r.rename ? `${r.rename.from} → ${r.rename.to}` : ''), url: r.html_url ?? r.source?.issue?.html_url, sha: r.commit_id ?? r.sha, status: r.state }));
    if (issue.type === 'pr') {
      try {
        const comments = z.array(rowSchema).parse(await github.request(`${prefix}/pulls/${issue.number}/comments?${query}`));
        result.more ||= comments.length === 100;
        result.rows.push(...comments.map((r, index) => ({ id: `inline-${r.node_id ?? r.id ?? `${page}-${index}`}`, kind: 'inline_comment', author: r.user?.login ?? 'deleted', at: r.created_at ?? '', body: r.body ?? '', url: r.html_url, path: r.path, line: r.line ?? r.original_line ?? undefined, patch: r.diff_hunk })));
      } catch (error) { result.warnings.push(`逐行审查评论未获取：${error instanceof Error ? error.message : '请求失败'}`); }
    }
    result.rows.sort((a, b) => a.at.localeCompare(b.at));
  } else {
    const before = await getPR(); result.revision = before.head.sha;
    if (section === 'files') {
      const rows = z.array(z.object({ filename: z.string(), status: z.string(), additions: z.number(), deletions: z.number(), patch: z.string().optional(), previous_filename: z.string().optional(), blob_url: z.string().optional() })).parse(await github.request(`${prefix}/pulls/${issue.number}/files?${query}`));
      result.more = rows.length === 100 && page < 30;
      result.rows = rows.map(r => ({ id: r.filename, kind: 'file', author: '', at: '', body: '', path: r.filename, previousPath: r.previous_filename, patch: r.patch, additions: r.additions, deletions: r.deletions, status: r.status, url: r.blob_url }));
      if (before.changed_files > 3000) result.warnings.push('GitHub 文件列表最多提供 3000 个文件，当前 PR 未完整覆盖。');
      if (rows.some(r => !r.patch)) result.warnings.push('部分文件没有文本 patch（可能是二进制文件或 GitHub 未提供差异）。');
      result.warnings.push('文本 patch 可能被 GitHub 截断；此视图不保证包含完整文件内容。');
    } else if (section === 'commits') {
      const rows = z.array(z.object({ sha: z.string(), html_url: z.string(), author: actor, commit: z.object({ message: z.string(), author: z.object({ name: z.string(), date: z.string() }).nullable(), committer: z.object({ date: z.string() }).nullable() }) })).parse(await github.request(`${prefix}/pulls/${issue.number}/commits?${query}`));
      result.more = rows.length === 100 && page < 3;
      result.rows = rows.map(r => ({ id: r.sha, kind: 'commit', sha: r.sha, author: r.author?.login ?? r.commit.author?.name ?? 'unknown', at: r.commit.author?.date ?? r.commit.committer?.date ?? '', body: r.commit.message, url: r.html_url }));
      if (page === 3 || rows.length === 100) result.warnings.push('GitHub PR 提交接口最多提供 250 个提交；超出部分请在 GitHub 查看。');
    } else {
      const checks = z.object({ total_count: z.number(), check_runs: z.array(z.object({ id: z.number(), name: z.string(), status: z.string(), conclusion: z.string().nullable(), html_url: z.string().nullable(), started_at: z.string().nullable(), output: z.object({ title: z.string().nullable(), summary: z.string().nullable() }).optional() })) });
      try {
        const data = checks.parse(await github.request(`${prefix}/commits/${before.head.sha}/check-runs?${query}`));
        result.more = data.total_count > page * 100;
        result.rows = data.check_runs.map(c => ({ id: `check-${c.id}`, kind: 'check', author: 'GitHub Checks', at: c.started_at ?? '', title: c.name, status: c.conclusion ?? c.status, body: [c.output?.title, c.output?.summary].filter(Boolean).join('\n\n'), url: c.html_url ?? undefined }));
      } catch (error) { result.warnings.push(`检查状态未知：${error instanceof Error ? error.message : '请求失败'}`); }
      try {
        const statuses = z.array(z.object({ id: z.number(), context: z.string(), state: z.string(), description: z.string().nullable(), created_at: z.string(), target_url: z.string().nullable() })).parse(await github.request(`${prefix}/commits/${before.head.sha}/statuses?${query}`));
        result.more ||= statuses.length === 100;
        result.rows.push(...statuses.map(c => ({ id: `status-${c.id}`, kind: 'status', author: 'Commit status', at: c.created_at, title: c.context, status: c.state, body: c.description ?? '', url: c.target_url ?? undefined })));
      } catch (error) { result.warnings.push(`Commit status 未获取：${error instanceof Error ? error.message : '请求失败'}`); }
      result.warnings.push('检查记录不等于合并许可；分支保护规则和未解决讨论未完整覆盖。');
    }
    const after = await getPR();
    if (after.head.sha !== before.head.sha || after.base.sha !== before.base.sha) throw new Error('读取期间 PR 已更新，本页结果已丢弃。请刷新后重试。');
  }
  if (result.more && page === 30) { result.more = false; result.warnings.push('已达到详情分页上限，剩余内容请在 GitHub 查看。'); }
  return result;
}
