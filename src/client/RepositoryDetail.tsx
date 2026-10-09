import {SummaryRecords} from './SummaryRecords.tsx';
import {useItemDraft} from './item-draft.ts';
import { diffLines } from './diff-lines.ts';
import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, RefreshCw, X, Loader2, GitPullRequest, CircleDot } from 'lucide-react';
import type { Issue } from '../core/types.ts';
import type { DetailSection, ItemDetail, DetailRow } from '../core/github-details.ts';

export type AgentTab='triage'|'execution'|'review'|'assistant'|'overview'|'plan'|'work';
type ReaderTab=DetailSection|'agent'|AgentTab;
const names:Record<ReaderTab,string>={summary:'Summary',activity:'Activity',files:'Diff',commits:'Commits',checks:'Checks',agent:'Review',triage:'Triage',execution:'Execution',review:'Review',assistant:'Overview',overview:'Overview',plan:'Plan',work:'Work'};
const isAgent=(tab:ReaderTab)=>['agent','triage','execution','review','assistant','overview','plan','work'].includes(tab);
const isChanges=(tab:ReaderTab)=>['files','commits','checks'].includes(tab);
const events: Record<string, string> = { commented: '发表了评论', reviewed: '提交了审查', inline_comment: '发表了逐行评论', committed: '提交了代码', closed: '关闭了此事项', reopened: '重新打开了此事项', merged: '合并了 PR', labeled: '添加了标签', unlabeled: '移除了标签', assigned: '指派了负责人', unassigned: '移除了负责人', renamed: '修改了标题', milestoned: '设置了里程碑', demilestoned: '移除了里程碑', head_ref_force_pushed: '强制推送了分支', ready_for_review: '标记为可审查', convert_to_draft: '转为草稿', review_requested: '请求审查', review_dismissed: '撤销了审查', cross_referenced: '引用了此事项', referenced: '关联了提交', connected: '关联了事项', disconnected: '取消了关联' };
const statusNames: Record<string, string> = { success: '通过', failure: '失败', error: '错误', pending: '等待', queued: '排队中', in_progress: '进行中', completed: '已完成', cancelled: '已取消', skipped: '已跳过', neutral: '中性', timed_out: '超时', action_required: '需要处理', stale: '已过期', APPROVED: '已批准', CHANGES_REQUESTED: '请求修改', COMMENTED: '审查评论' };
const safeLink = (url?: string) => url && /^https?:\/\//i.test(url) ? url : undefined;
const when = (value: string) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '';
export function RepositoryMarkdown({ text }: { text: string }) {
  return <div className="mw-repository-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={safeLink(href)} target="_blank" rel="noreferrer">{children}</a>, img: ({ alt, src }) => <a href={safeLink(src)} target="_blank" rel="noreferrer">[图片：{alt || '在新窗口查看'}]</a> }}>{text || '未提供正文。'}</Markdown></div>;
}
function Diff({ patch }: { patch: string }) { return <pre className="mw-reader-diff">{diffLines(patch).map((line, index) => <div key={index} className={line.kind} data-new-line={line.newLine}><i className="mw-reader-line-number" aria-label={line.oldLine !== undefined ? `原文件第 ${line.oldLine} 行` : undefined}>{line.oldLine}</i><i className="mw-reader-line-number" aria-label={line.newLine !== undefined ? `新文件第 ${line.newLine} 行` : undefined}>{line.newLine}</i><span className="mw-reader-code">{line.text || ' '}</span></div>)}</pre>; }

export function RepositoryDetail({ issue, repository, hasGitHub, agentPanel, renderAgentPanel, renderAgentActions, close, returnToList, embedded = false, initialTab = 'overview', requestedTab, localPatch, responseDraft, onPreviewReply }: { issue: Issue; repository: string; hasGitHub: boolean; agentPanel: React.ReactNode; renderAgentPanel?:(stage:AgentTab)=>React.ReactNode; renderAgentActions?:(stage:AgentTab)=>React.ReactNode; close: () => void; returnToList?: () => void; embedded?: boolean; initialTab?: ReaderTab; requestedTab?:{sequence:number;tab:ReaderTab;path?:string;line?:number}; localPatch?:{patch:string;label:string;revision:string}; responseDraft?:string;onPreviewReply?:()=>void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<ReaderTab>(initialTab === 'agent' ? 'review' : initialTab === 'execution' ? 'work' : initialTab === 'triage' || initialTab === 'assistant' ? 'overview' : initialTab);
  const {draft,ready,error:draftError,update}=useItemDraft(issue.id);
  const restored=useRef(false);
  useEffect(()=>{if(ready&&!restored.current){restored.current=true;if(draft.view && ['overview','plan','work','review','summary','activity','files'].includes(draft.view))setTab(draft.view as ReaderTab);}},[ready]);
  const selectTab=(key:ReaderTab)=>{restored.current=true;setTab(key);setPage(1);update({view:key});};
  useEffect(()=>{setCache({});setPage(1);},[issue.headSha,issue.updatedAt]);
  const [page, setPage] = useState(1);
  const [diffSource,setDiffSource]=useState<'github'|'local'>(localPatch && issue.type !== 'pr' ? 'local':'github');
  useEffect(()=>{if(requestedTab){restored.current=true;setTab(requestedTab.tab);setPage(1);if(requestedTab.tab==='files'&&localPatch)setDiffSource('local');}},[requestedTab?.sequence]);
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
    if (isAgent(tab) || tab==='files' && diffSource==='local' || !hasGitHub || (cache[tab as DetailSection]?.page ?? 0) >= page) { setLoading(false); return; }
    const controller = new AbortController(); setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/maintainer/api/item-detail?id=${encodeURIComponent(issue.id)}&section=${tab}&page=${page}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? '详情加载失败');
        if (controller.signal.aborted) return;
        const previous = cache[tab as DetailSection];
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
  }, [issue.id, tab, page, reload, hasGitHub,diffSource]);
  useEffect(()=>{if(tab==='files'&&requestedTab?.path){const node=[...document.querySelectorAll<HTMLDetailsElement>('.mw-reader-file')].find(node=>node.dataset.path===requestedTab.path);if(node){node.open=true;const line=requestedTab.line ? node.querySelector<HTMLElement>(`[data-new-line="${requestedTab.line}"]`):null;(line??node).scrollIntoView({block:'start'});line?.classList.add('mw-diff-target');}}},[tab,cache.files,diffSource,requestedTab?.sequence]);
  const summary = cache.summary?.summary;
  const data = isAgent(tab) ? undefined : cache[tab as DetailSection];
  const aiTabs:ReaderTab[]=['overview',...(issue.type==='issue' && (issue.plan || draft.plan || issue.analysis?.category !== 'question' || tab==='plan') ? ['plan' as const] : []),'work','review'];
  const sourceTabs:ReaderTab[]=issue.type==='pr' || localPatch ? ['summary','activity','files'] : ['summary','activity'];
  const state = summary?.merged ?? issue.merged ? '已合并' : summary?.draft ? '草稿' : (summary?.state ?? issue.state) === 'closed' ? '已关闭' : '开放中';
  const refresh = () => { setCache({}); setPage(1); setReload(value => value + 1); };
  const content = <>
    <header className="mw-reader-header">
      <h2>{returnToList && <button className="mw-icon-button mw-mobile-list-return" aria-label="返回来源列表" onClick={returnToList}>←</button>}{summary?.title ?? issue.title}</h2>
      <div className="mw-reader-meta"><div className="mw-reader-facts"><span className={`mw-reader-state ${state === '已合并' ? 'merged' : state === '已关闭' ? 'closed' : ''}`}>{issue.type === 'pr' ? <GitPullRequest size={15} /> : <CircleDot size={15} />}{state}</span><span className="mw-title-reference"><span>#{issue.number}</span> {safeLink(issue.url) && <a className="mw-icon-button" title="在 GitHub 查看" aria-label="在 GitHub 查看" href={safeLink(issue.url)} target="_blank" rel="noreferrer"><ExternalLink size={16}/></a>}</span><strong>{summary?.author ?? issue.author}</strong><span>{summary ? `创建于 ${when(summary.createdAt)}` : `同步于 ${when(issue.updatedAt)}`}</span>{summary?.headRef && <><code>{summary.headRef}</code><span>→</span><code>{summary.baseRef}</code></>}</div><div className="mw-reader-top-actions">{isAgent(tab) && renderAgentActions && <div className="mw-reader-stage-actions">{renderAgentActions(tab as AgentTab)}</div>}{hasGitHub && !isAgent(tab) && <button className="mw-icon-button" title="刷新详情" aria-label="刷新详情" disabled={loading} onClick={refresh}><RefreshCw size={16}/></button>}{!embedded && <button className="mw-reader-close" onClick={close} aria-label="关闭完整详情"><X size={18} /></button>}</div></div>
      <div className="mw-reader-tabbar"><nav className="mw-reader-tabs mw-reader-ai-tabs" aria-label="AI 功能">{aiTabs.map(key=><button key={key} aria-current={tab===key?'page':undefined} className={tab===key?'active':''} onClick={()=>selectTab(key)}>{names[key]}</button>)}</nav><nav className="mw-reader-tabs mw-reader-source-tabs" aria-label="GitHub 原始内容">{sourceTabs.map(key=><button key={key} aria-current={tab===key?'page':undefined} className={tab===key?'active':''} onClick={()=>selectTab(key)}>{names[key]}</button>)}</nav><div className="mw-reader-compact-tabs"><select aria-label="AI 功能" value={isAgent(tab)?tab:''} onChange={e=>selectTab(e.target.value as ReaderTab)}><option value="" disabled>AI</option>{aiTabs.map(key=><option key={key} value={key}>{names[key]}</option>)}</select><select aria-label="GitHub 原始内容" value={!isAgent(tab)?tab:''} onChange={e=>selectTab(e.target.value as ReaderTab)}><option value="" disabled>GitHub</option>{sourceTabs.map(key=><option key={key} value={key}>{names[key]}</option>)}</select></div></div>

    </header>
    <main className="mw-reader-content">

      {draftError && <p role="alert">{draftError}</p>}
      {error && <div className="mw-callout red" role="alert"><div><strong>详情未完整加载</strong><p>{error}</p><button className="mw-text-button" onClick={refresh}>重新加载</button></div></div>}
      {!!data?.warnings.length && <details className="mw-compact-notice"><summary>覆盖范围 · {data.warnings.length}</summary>{data.warnings.map(warning=><p key={warning}>{warning}</p>)}</details>}
      {tab === 'summary' && <div className="mw-reader-summary"><article><div className="mw-reader-card-header">{summary?.author ?? issue.author} · 正文 {!summary && <small>同步时的快照</small>}</div><RepositoryMarkdown text={summary?.body ?? issue.body} /></article><aside><h4>标签</h4><div className="mw-tags">{(summary?.labels ?? issue.labels).map(label => <span className="mw-tag" key={label}>{label}</span>)}</div>{!(summary?.labels ?? issue.labels).length && <p>暂无标签</p>}<h4>负责人</h4><p>{summary?.assignees.join(', ') || '未指定'}</p>{summary?.headSha && <><h4>变更范围</h4><p>{summary.changedFiles} 个文件 · <span className="mw-reader-add">+{summary.additions}</span> / <span className="mw-reader-del">−{summary.deletions}</span></p><h4>当前 HEAD</h4><code>{summary.headSha.slice(0, 12)}</code></>}</aside></div>}
      {tab==='summary' && issue.type==='pr' && hasGitHub && <section><SummaryRecords key={`${issue.id}:commits:${reload}`} id={issue.id} section="commits"/><SummaryRecords key={`${issue.id}:checks:${reload}`} id={issue.id} section="checks"/></section>}
      {tab === 'activity' && <section className="mw-reply-editor"><h4>回复草稿</h4><textarea aria-label="回复草稿" rows={4} disabled={!ready} value={draft.reply??''} onChange={e=>update({reply:e.target.value})}/>{responseDraft && <button className="mw-text-button" disabled={!ready} onClick={()=>update({reply:responseDraft})}>填入当前分析的回复建议</button>}<button className="mw-button" disabled={!draft.reply?.trim()} onClick={()=>void navigator.clipboard.writeText(draft.reply!)}>复制草稿</button><button className="mw-button" disabled={!onPreviewReply || !draft.reply?.trim() || !!draftError} onClick={onPreviewReply}>预览发布回复</button><small>{onPreviewReply ? "保存在本机，尚未发布" : "本机草稿；先在 Review 接受结果才能发布"}</small></section>}
      {tab === 'activity' && <div className="mw-reader-timeline">{data?.rows.map(row => <article key={row.id} className="mw-reader-event"><div className="mw-reader-event-dot" /><header><strong>{row.author}</strong> {events[row.kind] ?? row.kind}{row.status && <span className="mw-tag">{statusNames[row.status] ?? row.status}</span>}<time>{when(row.at)}</time>{safeLink(row.url) && <a href={safeLink(row.url)} target="_blank" rel="noreferrer">原始记录 ↗</a>}</header>{row.path && <code>{row.path}{row.line ? `:${row.line}` : ''}</code>}{row.sha && <code>{row.sha.slice(0, 12)}</code>}{row.body && <RepositoryMarkdown text={row.body} />}{row.patch && <details><summary>查看评论位置的代码</summary><Diff patch={row.patch} /></details>}</article>)}</div>}
      {tab==='files' && requestedTab?.path && <button className="mw-text-button" onClick={()=>selectTab('review')}>返回 Review</button>}
      {tab==='files' && localPatch && <div className="mw-workflow-actions">{issue.type==='pr' && <button className="mw-button" onClick={()=>setDiffSource('github')}>PR 原始变更</button>}<button className="mw-button" onClick={()=>setDiffSource('local')}>本机产物 · {localPatch.label}</button></div>}
      {tab==='files' && diffSource==='local' && localPatch && <section><p>本机产物 · 基线 <code>{localPatch.revision.slice(0,12)}</code></p>{localPatch.patch.split(/(?=^diff --git )/m).filter(Boolean).map((patch,index)=><details className="mw-reader-file" open={index===0} key={index}><summary>{patch.match(/^\+\+\+ b\/(.*)$/m)?.[1] ?? patch.split('\n')[0]}</summary><Diff patch={patch}/></details>)}</section>}
      {tab === 'files' && diffSource==='github' && <div className="mw-reader-files"><p>{data?.rows.length ?? 0} 个已加载文件 · + / − 为 GitHub 报告的行数</p>{data?.rows.map((row, index) => <details className="mw-reader-file" data-path={row.path} key={row.id} open={index === 0 ? true : undefined}><summary><span>{row.path}</span><span className="mw-reader-file-status">{row.status}{row.previousPath ? ` · 原路径 ${row.previousPath}` : ''}</span><b className="mw-reader-add">+{row.additions}</b><b className="mw-reader-del">−{row.deletions}</b></summary>{row.patch ? <Diff patch={row.patch} /> : <p>GitHub 未提供文本差异。{safeLink(row.url) && <a href={safeLink(row.url)} target="_blank" rel="noreferrer">查看文件 ↗</a>}</p>}</details>)}</div>}
      {tab === 'commits' && <div className="mw-reader-commits">{data?.rows.map(row => <article className="mw-reader-commit" key={row.id}><div><h4>{row.body.split('\n')[0]}</h4><span>{row.author} · {when(row.at)}</span>{row.body.includes('\n') && <details><summary>完整提交说明</summary><RepositoryMarkdown text={row.body} /></details>}</div><a href={safeLink(row.url)} target="_blank" rel="noreferrer"><code>{row.sha?.slice(0, 12)}</code></a></article>)}</div>}
      {tab === 'checks' && <div className="mw-reader-checks">{data?.rows.map(row => <article key={row.id} className="mw-reader-check"><header><span className={`mw-reader-check-status ${row.status === 'success' ? 'success' : ['failure', 'error', 'timed_out'].includes(row.status ?? '') ? 'failure' : ''}`}>{statusNames[row.status ?? ''] ?? row.status}</span><h4>{row.title}</h4><time>{when(row.at)}</time>{safeLink(row.url) && <a href={safeLink(row.url)} target="_blank" rel="noreferrer">查看日志 ↗</a>}</header>{row.body && <details><summary>检查详情</summary><RepositoryMarkdown text={row.body} /></details>}</article>)}</div>}
      {isAgent(tab) && <div className="mw-reader-agent">{renderAgentPanel ? renderAgentPanel(tab === 'agent' ? 'review' : tab as AgentTab) : agentPanel}</div>}
      {!hasGitHub && !(tab==='files'&&localPatch) && tab !== 'summary' && !isAgent(tab) && <p className="mw-reader-empty">当前只有本地事项。关联 GitHub 远端并同步后可查看讨论和活动。</p>}
      {data && !data.rows.length && !loading && tab !== 'summary' && <p className="mw-reader-empty">{tab === 'checks' ? '当前没有可显示的检查记录；不表示测试通过。' : '此页暂无记录。'}</p>}
      {loading && <p className="mw-reader-loading" role="status"><Loader2 className="mw-spin" size={17} />正在读取{names[tab]}…</p>}
      {data?.more && !loading && !error && <button className="mw-button" onClick={() => setPage(data.page + 1)}>加载更多（每页最多 100 条）</button>}
    </main>
  </>;
  return embedded ? <section id="mw-detail" tabIndex={-1} className="mw-reader-embedded" aria-label={`${issue.type === 'pr' ? 'PR' : 'Issue'} #${issue.number} 详情`}>{content}</section> : <dialog className="mw-reader-dialog" aria-label={`${issue.type === 'pr' ? 'PR' : 'Issue'} #${issue.number} 完整详情`} ref={dialog} onCancel={event => { event.preventDefault(); close(); }}>{content}</dialog>;
}
