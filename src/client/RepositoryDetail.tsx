import { diffLines } from './diff-lines.ts';
import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, RefreshCw, X, Loader2, GitPullRequest, CircleDot } from 'lucide-react';
import type { Issue } from '../core/types.ts';
import type { DetailSection, ItemDetail, DetailRow } from '../core/github-details.ts';

const names: Record<DetailSection | 'agent', string> = { summary: 'Summary · 概览', activity: 'Activity · 活动', files: 'Files changed · 文件', commits: 'Commits · 提交', checks: 'Checks · 检查', agent: 'Agent · 处理流程' };
const events: Record<string, string> = { commented: '发表了评论', reviewed: '提交了审查', inline_comment: '发表了逐行评论', committed: '提交了代码', closed: '关闭了此事项', reopened: '重新打开了此事项', merged: '合并了 PR', labeled: '添加了标签', unlabeled: '移除了标签', assigned: '指派了负责人', unassigned: '移除了负责人', renamed: '修改了标题', milestoned: '设置了里程碑', demilestoned: '移除了里程碑', head_ref_force_pushed: '强制推送了分支', ready_for_review: '标记为可审查', convert_to_draft: '转为草稿', review_requested: '请求审查', review_dismissed: '撤销了审查', cross_referenced: '引用了此事项', referenced: '关联了提交', connected: '关联了事项', disconnected: '取消了关联' };
const statusNames: Record<string, string> = { success: '通过', failure: '失败', error: '错误', pending: '等待', queued: '排队中', in_progress: '进行中', completed: '已完成', cancelled: '已取消', skipped: '已跳过', neutral: '中性', timed_out: '超时', action_required: '需要处理', stale: '已过期', APPROVED: '已批准', CHANGES_REQUESTED: '请求修改', COMMENTED: '审查评论' };
const safeLink = (url?: string) => url && /^https?:\/\//i.test(url) ? url : undefined;
const when = (value: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '';
export function RepositoryMarkdown({ text }: { text: string }) {
  return <div className="mw-repository-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={safeLink(href)} target="_blank" rel="noreferrer">{children}</a>, img: ({ alt, src }) => <a href={safeLink(src)} target="_blank" rel="noreferrer">[图片：{alt || '在新窗口查看'}]</a> }}>{text || '未提供正文。'}</Markdown></div>;
}
function Diff({ patch }: { patch: string }) { return <pre className="mw-reader-diff">{diffLines(patch).map((line, index) => <div key={index} className={line.kind}><i className="mw-reader-line-number" aria-label={line.oldLine !== undefined ? `原文件第 ${line.oldLine} 行` : undefined}>{line.oldLine}</i><i className="mw-reader-line-number" aria-label={line.newLine !== undefined ? `新文件第 ${line.newLine} 行` : undefined}>{line.newLine}</i><span className="mw-reader-code">{line.text || ' '}</span></div>)}</pre>; }

export function RepositoryDetail({ issue, repository, hasGitHub, agentPanel, close, embedded = false, initialTab = 'summary' }: { issue: Issue; repository: string; hasGitHub: boolean; agentPanel: React.ReactNode; close: () => void; embedded?: boolean; initialTab?: DetailSection | 'agent' }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<DetailSection | 'agent'>(initialTab);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [cache, setCache] = useState<Partial<Record<DetailSection, ItemDetail>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (embedded) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal(); dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { dialog.current?.close(); previous?.focus(); };
  }, [embedded]);
  useEffect(() => {
    setError('');
    if (tab === 'agent' || !hasGitHub || (cache[tab]?.page ?? 0) >= page) { setLoading(false); return; }
    const controller = new AbortController(); setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/maintainer/api/item-detail?id=${encodeURIComponent(issue.id)}&section=${tab}&page=${page}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? '详情加载失败');
        if (controller.signal.aborted) return;
        const previous = cache[tab];
        if (page > 1 && previous?.revision && previous.revision !== data.revision) throw new Error('PR 已更新，不能将不同版本的数据拼在一起。请刷新详情。');
        const merged = new Map<string, DetailRow>();
        if (page > 1) previous?.rows.forEach(row => merged.set(row.id, row));
        (data as ItemDetail).rows.forEach(row => merged.set(row.id, row));
        const rows = [...merged.values()];
        if (tab === 'activity') rows.sort((a, b) => a.at.localeCompare(b.at));
        setCache(current => ({ ...current, [tab]: { ...data, rows, warnings: [...new Set([...(page > 1 ? previous?.warnings ?? [] : []), ...data.warnings])] } }));
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '详情加载失败，请重试'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [issue.id, tab, page, reload, hasGitHub]);
  const summary = cache.summary?.summary;
  const data = tab === 'agent' ? undefined : cache[tab];
  const tabs: (DetailSection | 'agent')[] = issue.type === 'pr' ? ['summary', 'activity', 'files', 'commits', 'checks', 'agent'] : ['summary', 'activity', 'agent'];
  const state = summary?.merged ?? issue.merged ? '已合并' : summary?.draft ? '草稿' : (summary?.state ?? issue.state) === 'closed' ? '已关闭' : '开放中';
  const refresh = () => { setCache({}); setPage(1); setReload(value => value + 1); };
  const content = <>
    <header className="mw-reader-header"><div className="mw-reader-breadcrumb">{repository} <span>/ {issue.type === 'pr' ? 'Pull request' : 'Issue'} #{issue.number}</span></div><button className="mw-reader-close" onClick={close} aria-label={embedded ? "关闭详情" : "关闭完整详情"}><X size={21} /></button>
      <h2>{summary?.title ?? issue.title} <span>#{issue.number}</span></h2>
      <div className="mw-reader-meta"><span className={`mw-reader-state ${state === '已合并' ? 'merged' : state === '已关闭' ? 'closed' : ''}`}>{issue.type === 'pr' ? <GitPullRequest size={15} /> : <CircleDot size={15} />}{state}</span><strong>{summary?.author ?? issue.author}</strong><span>{summary ? `创建于 ${when(summary.createdAt)}` : `同步于 ${when(issue.updatedAt)}`}</span>{summary?.headRef && <><code>{summary.headRef}</code><span>→</span><code>{summary.baseRef}</code></>}</div>
      <nav className="mw-reader-tabs" aria-label="仓库详情页签">{tabs.map(key => <button aria-current={tab === key ? 'page' : undefined} className={tab === key ? 'active' : ''} key={key} onClick={() => { setTab(key); setPage(1); }}>{names[key]}</button>)}</nav>
    </header>
    <div className="mw-reader-toolbar"><span>{tab === 'agent' ? '本地 Agent 任务与审核，与 GitHub 原始内容分开展示' : data ? `GitHub 原始内容 · 获取于 ${when(data.fetchedAt)}${data.revision ? ` · HEAD ${data.revision.slice(0, 12)}` : ''}` : hasGitHub ? '读取 GitHub 原始内容，不会启动 Agent' : '本地事项，没有对应的 GitHub 记录'}</span><div>{hasGitHub && tab !== 'agent' && <button className="mw-button" disabled={loading} onClick={refresh}><RefreshCw size={14} />刷新详情</button>}{safeLink(issue.url) && <a className="mw-button" href={safeLink(issue.url)} target="_blank" rel="noreferrer"><ExternalLink size={14} />在 GitHub 查看</a>}</div></div>
    <main className="mw-reader-content">
      {error && <div className="mw-callout red" role="alert"><div><strong>详情未完整加载</strong><p>{error}</p><button className="mw-text-button" onClick={refresh}>重新加载</button></div></div>}
      {data?.warnings.map(warning => <div className="mw-callout amber" key={warning}>{warning}</div>)}
      {tab === 'summary' && <div className="mw-reader-summary"><article><div className="mw-reader-card-header">{summary?.author ?? issue.author} · 正文 {!summary && <small>同步时的快照</small>}</div><RepositoryMarkdown text={summary?.body ?? issue.body} /></article><aside><h4>标签</h4><div className="mw-tags">{(summary?.labels ?? issue.labels).map(label => <span className="mw-tag" key={label}>{label}</span>)}</div>{!(summary?.labels ?? issue.labels).length && <p>暂无标签</p>}<h4>负责人</h4><p>{summary?.assignees.join(', ') || '未指定'}</p>{summary?.headSha && <><h4>变更范围</h4><p>{summary.changedFiles} 个文件 · <span className="mw-reader-add">+{summary.additions}</span> / <span className="mw-reader-del">−{summary.deletions}</span></p><h4>当前 HEAD</h4><code>{summary.headSha.slice(0, 12)}</code></>}</aside></div>}
      {tab === 'activity' && <div className="mw-reader-timeline">{data?.rows.map(row => <article key={row.id} className="mw-reader-event"><div className="mw-reader-event-dot" /><header><strong>{row.author}</strong> {events[row.kind] ?? row.kind}{row.status && <span className="mw-tag">{statusNames[row.status] ?? row.status}</span>}<time>{when(row.at)}</time>{safeLink(row.url) && <a href={safeLink(row.url)} target="_blank" rel="noreferrer">原始记录 ↗</a>}</header>{row.path && <code>{row.path}{row.line ? `:${row.line}` : ''}</code>}{row.sha && <code>{row.sha.slice(0, 12)}</code>}{row.body && <RepositoryMarkdown text={row.body} />}{row.patch && <details><summary>查看评论位置的代码</summary><Diff patch={row.patch} /></details>}</article>)}</div>}
      {tab === 'files' && <div className="mw-reader-files"><p>{data?.rows.length ?? 0} 个已加载文件 · + / − 为 GitHub 报告的行数</p>{data?.rows.map((row, index) => <details className="mw-reader-file" key={row.id} open={index === 0 ? true : undefined}><summary><span>{row.path}</span><span className="mw-reader-file-status">{row.status}{row.previousPath ? ` · 原路径 ${row.previousPath}` : ''}</span><b className="mw-reader-add">+{row.additions}</b><b className="mw-reader-del">−{row.deletions}</b></summary>{row.patch ? <Diff patch={row.patch} /> : <p>GitHub 未提供文本差异。{safeLink(row.url) && <a href={safeLink(row.url)} target="_blank" rel="noreferrer">查看文件 ↗</a>}</p>}</details>)}</div>}
      {tab === 'commits' && <div className="mw-reader-commits">{data?.rows.map(row => <article className="mw-reader-commit" key={row.id}><div><h4>{row.body.split('\n')[0]}</h4><span>{row.author} · {when(row.at)}</span>{row.body.includes('\n') && <details><summary>完整提交说明</summary><RepositoryMarkdown text={row.body} /></details>}</div><a href={safeLink(row.url)} target="_blank" rel="noreferrer"><code>{row.sha?.slice(0, 12)}</code></a></article>)}</div>}
      {tab === 'checks' && <div className="mw-reader-checks">{data?.rows.map(row => <article key={row.id} className="mw-reader-check"><header><span className={`mw-reader-check-status ${row.status === 'success' ? 'success' : ['failure', 'error', 'timed_out'].includes(row.status ?? '') ? 'failure' : ''}`}>{statusNames[row.status ?? ''] ?? row.status}</span><h4>{row.title}</h4><time>{when(row.at)}</time>{safeLink(row.url) && <a href={safeLink(row.url)} target="_blank" rel="noreferrer">查看日志 ↗</a>}</header>{row.body && <details><summary>检查详情</summary><RepositoryMarkdown text={row.body} /></details>}</article>)}</div>}
      {tab === 'agent' && <div className="mw-reader-agent">{agentPanel}</div>}
      {!hasGitHub && tab !== 'summary' && tab !== 'agent' && <p className="mw-reader-empty">当前只有本地事项。关联 GitHub 远端并同步后可查看讨论和活动。</p>}
      {data && !data.rows.length && !loading && tab !== 'summary' && <p className="mw-reader-empty">{tab === 'checks' ? '当前没有可显示的检查记录；不表示测试通过。' : '此页暂无记录。'}</p>}
      {loading && <p className="mw-reader-loading" role="status"><Loader2 className="mw-spin" size={17} />正在读取{names[tab]}…</p>}
      {data?.more && !loading && !error && <button className="mw-button" onClick={() => setPage(data.page + 1)}>加载更多（每页最多 100 条）</button>}
    </main>
  </>;
  return embedded ? <section className="mw-reader-embedded" aria-label={`${issue.type === 'pr' ? 'PR' : 'Issue'} #${issue.number} 详情`}>{content}</section> : <dialog className="mw-reader-dialog" aria-label={`${issue.type === 'pr' ? 'PR' : 'Issue'} #${issue.number} 完整详情`} ref={dialog} onCancel={event => { event.preventDefault(); close(); }}>{content}</dialog>;
}
