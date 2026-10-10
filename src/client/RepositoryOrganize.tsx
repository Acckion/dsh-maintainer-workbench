import React, { useState } from 'react';
import { organizeActions, type OrganizeMode } from '../core/organize.ts';
import { conversationCategories, conversationJobs, repositoryConversationTitle, taskConversationRecord, type ConversationCategory } from '../core/conversations.ts';
import type { Snapshot } from '../core/types.ts';
import { RepositoryMarkdown } from './RepositoryDetail.tsx';

interface Props {
  state: Snapshot; repoId: string; busy: boolean;
  run: (data: unknown) => Promise<void>; open: (id: string) => void;
}

export function RepositoryOrganize(props: Props) {
  // Scope drafts and navigation to the repository rather than carrying them across main areas.
  return <RepositoryArea key={props.repoId} {...props} />;
}

function RepositoryArea({ state, repoId, busy, run, open }: Props) {
  const repo = state.repos.find(repo => repo.id === repoId);
  const [drafts, setDrafts] = useState<Partial<Record<ConversationCategory, string>>>({});
  const [category, setCategory] = useState<ConversationCategory>('audit');
  const instructions = drafts[category] ?? '';
  const [pr, setPr] = useState('');
  const [limit, setLimit] = useState(20);
  const prs = state.issues.filter(issue => issue.repoId === repoId && issue.type === 'pr' && issue.state === 'open');
  const jobs = conversationJobs(state.jobs, repoId, category);
  const mode = category in organizeActions ? category as OrganizeMode : undefined;
  const current = mode ? organizeActions[mode] : undefined;
  const disabled = busy || !repoId || !state.capabilities.harness || mode !== 'audit' && repo?.mode === 'local' && !repo.headSha;
  return <div className="mw-organize-workspace" aria-label="仓库主区">
    <aside className="mw-organize-sidebar">
      <h3>{repo ? repositoryConversationTitle(repo) : '仓库维护'}</h3>
      <p className="mw-muted">按问题类别管理对话，PR 与执行记录归入对应子区。</p>
      <nav aria-label="问题类别子区">{Object.entries(conversationCategories).map(([value, title]) => <button
        key={value} className={`mw-task-row ${category === value ? 'focused' : ''}`}
        aria-current={category === value ? 'page' : undefined}
        onClick={() => { setCategory(value as ConversationCategory); setLimit(20); }}>
        <strong>{title}</strong><small>{conversationJobs(state.jobs, repoId, value as ConversationCategory).length} 条记录</small>
      </button>)}</nav>
    </aside>
    <section className="mw-organize-main" aria-label={`${conversationCategories[category]}子区`}>
      <header className="mw-organize-heading"><div><h2>{conversationCategories[category]}</h2>
        <p>{current?.description ?? '汇总此仓库同类问题的调查、处理结论与后续步骤。'}</p></div>
        {current && <button className="mw-button primary" disabled={disabled} onClick={() => void run({ repoId, mode, instructions })}>{mode === 'audit' ? '开始检查' : '检查并准备修改'}</button>}
      </header>
      {current && <>
        <label>本次范围或重点（可选）<textarea rows={3} value={instructions} onChange={event => setDrafts({ ...drafts, [category]: event.target.value })} placeholder="例如只整理 docs/，保留历史设计文档" /></label>
        {mode === 'docs' && <details><summary>为一个 PR 补齐文档</summary><label>选择当前仓库的开放 PR<select value={prs.some(issue => issue.id === pr) ? pr : ''} onChange={event => setPr(event.target.value)}><option value="">选择 PR</option>{prs.map(issue => <option key={issue.id} value={issue.id}>#{issue.number} {issue.title}</option>)}</select></label><button className="mw-button" disabled={busy || !state.capabilities.harness || !prs.some(issue => issue.id === pr)} onClick={() => void run({ repoId, mode: 'docs', issueId: pr, instructions })}>检查并准备文档补丁</button></details>}
        {!state.capabilities.harness && <p role="status">在 Harness 中打开插件后可读取仓库和准备修改。</p>}
        {mode !== 'audit' && <p className="mw-muted">改动将在独立工作副本中准备，结果归入本子区。</p>}
      </>}
      <section className="mw-conversation-history" aria-label="类别对话记录">
        <h3>处理记录 · {jobs.length}</h3>
        {jobs.length > limit && <button className="mw-button" onClick={() => setLimit(limit + 20)}>加载更早记录</button>}
        {jobs.slice(-limit).map(job => <article className="mw-conversation-record" key={job.id}>
          {job.artifactState === 'stale' && <p className="mw-callout amber">旧版本记录，请核对当前仓库版本。</p>}
          <RepositoryMarkdown text={taskConversationRecord(job)} />
          <button className="mw-button" onClick={() => open(job.id)}>查看任务、工具执行与原始输出</button>
        </article>)}
        {!jobs.length && <p className="mw-muted">此类别尚无处理记录</p>}
      </section>
    </section>
  </div>;
}
