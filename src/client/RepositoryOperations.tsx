import { reportNeedsRecovery } from "../core/report-state.ts";
import { useEffect, useState } from 'react';
import { Search, FileSearch, BookOpen, GitBranch, Workflow, ArrowLeft, RefreshCw } from 'lucide-react';
import { organizeActions, type OrganizeMode } from '../core/organize.ts';
import type { Snapshot, Job } from '../core/types.ts';
import { Tag, Empty } from './Primitives.tsx';
import { taskStatus } from './review-evidence.ts';
import { RepositoryMarkdown } from './RepositoryDetail.tsx';

const icons = { audit: FileSearch, docs: BookOpen, agents: GitBranch, ci: Workflow };
const checks: Record<OrganizeMode, string[]> = {
  audit: ['文档职责与适用版本', '文档、实现和配置的一致性', '缺失说明、重复内容与失效引用', '最小修改建议与可追溯证据'],
  docs: ['安装、使用和开发说明', '实现变更影响的文档与示例', '引用、链接与声明的检查命令', '保留历史设计与项目原有风格'],
  agents: ['已有 AGENTS.md 与贡献指南', '模块边界与仓库导航', '真实构建、测试命令及工作目录', '增量更新，保留人工约定'],
  ci: ['已有工作流、清单与锁文件', '真实 lint、test、build 命令', '兼容运行环境与最小权限', '本地验证结果与待运行的远端 CI'],
};
type Panel = 'Overview' | 'Configure' | 'Results' | 'History';
type Draft = { instructions: string; pr: string; auditJobId: string };
const emptyDraft: Draft = { instructions: '', pr: '', auditJobId: '' };
const when = (value: string) => new Date(value).toLocaleString('zh-CN');

export function RepositoryOperations({ state, repoId, busy, run, open, act }: {
  state: Snapshot; repoId: string; busy: boolean;
  run: (data: unknown) => Promise<string | undefined>;
  open: (id: string) => void;
  act: (path: string, data: unknown, message: string) => Promise<unknown>;
}) {
  const repo = state.repos.find(r => r.id === repoId);
  const [mode, setMode] = useState<OrganizeMode>('audit');
  const [panel, setPanel] = useState<Panel>('Overview');
  const [search, setSearch] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState('');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [draftError, setDraftError] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const key = `maintainer.repository:${repoId}:${mode}`;
  useEffect(() => {
    setSelectedJob(''); setError(''); setDraftError('');
    try { setDraft({ ...emptyDraft, ...JSON.parse(localStorage.getItem(key) ?? '{}') }); }
    catch { setDraft(emptyDraft); setDraftError('本地范围草稿不可用，请重新填写。'); }
  }, [key]);
  useEffect(() => { setMode('audit'); setPanel('Overview'); setDetailOpen(false); setSearch(''); }, [repoId]);
  const update = (value: Partial<Draft>) => {
    const next = { ...draft, ...value }; setDraft(next);
    try { localStorage.setItem(key, JSON.stringify(next)); setDraftError(''); }
    catch { setDraftError('无法保存范围草稿；本次填写仍可使用。'); }
  };
  const prs = state.issues.filter(i => i.repoId === repoId && i.type === 'pr' && i.state === 'open');
  const jobs = state.jobs.filter(j => j.repoId === repoId && (j.issueSnapshot.origin === 'repository' || j.instructions?.startsWith(organizeActions.docs.instructions)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const modeJobs = jobs.filter(j => j.issueSnapshot.organizeMode === mode || mode === 'docs' && j.issueSnapshot.type === 'pr');
  const latest = modeJobs[0];
  const chosen = modeJobs.find(j => j.id === selectedJob) ?? latest;
  const audits = jobs.filter(j => j.issueSnapshot.organizeMode === 'audit' && j.status === 'completed' && j.artifactState !== 'stale' && j.artifact);
  const running = modeJobs.find(j => ['queued', 'running'].includes(j.status));
  const current = organizeActions[mode];
  const disabledReason = !state.capabilities.harness ? '请在 DeepSeek Harness 中打开插件，以使用仓库执行器。'
    : mode !== 'audit' && (repo?.localKind === 'folder' || repo?.mode === 'local' && !repo.headSha) ? '此目录尚无 Git 提交；目前可以运行只读检查。'
    : draft.pr && !prs.some(i => i.id === draft.pr) ? '所选 PR 已不在开放列表，请重新选择。'
    : draft.auditJobId && !audits.some(j => j.id === draft.auditJobId) ? '所选检查报告已过期或不可用，请重新选择。' : '';
  const start = async () => {
    if (disabledReason || submitting || busy || running) return;
    setSubmitting(true); setError('');
    try {
      const id = await run({ repoId, mode, instructions: draft.instructions, ...(mode === 'docs' && draft.pr ? { issueId: draft.pr } : {}), ...(mode !== 'audit' && draft.auditJobId ? { auditJobId: draft.auditJobId } : {}) });
      if (id) { setSelectedJob(id); setPanel('Results'); setDetailOpen(true); }
    } catch (e) { setError(e instanceof Error ? e.message : '任务启动失败，请重试。'); }
    finally { setSubmitting(false); }
  };
  const command = async (path: string, job: Job) => {
    try { setError(''); await act(path, { id: job.id }, path === '/cancel' ? '任务已取消' : '任务已重新派发'); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
  };
  const report = chosen?.artifact ?? chosen?.result;
  const active = chosen && ['queued', 'running'].includes(chosen.status);
  return <div className={`mw-organize-workspace mw-repository-browser ${detailOpen ? 'detail-open' : ''}`}>
    <aside className="mw-organize-sidebar mw-list-panel" aria-label="仓库维护列表">
      <div className="mw-toolbar"><label className="mw-search"><Search size={16}/><input aria-label="搜索仓库维护" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索维护项目…"/></label></div>
      <nav aria-label="仓库整理项目">{(Object.entries(organizeActions) as [OrganizeMode, typeof current][]).filter(([, a]) => `${a.title} ${a.description}`.toLowerCase().includes(search.toLowerCase())).map(([value, action]) => {
        const Icon = icons[value]; const last = jobs.find(j => j.issueSnapshot.organizeMode === value || value === 'docs' && j.issueSnapshot.type === 'pr');
        return <button key={value} className={`mw-task-row ${mode === value ? 'focused' : ''}`} aria-current={mode === value ? 'page' : undefined} onClick={() => { setMode(value); setPanel('Overview'); setDetailOpen(true); }}>
          <span className="mw-task-icon"><Icon size={16}/></span><div><strong>{action.title}</strong><p>{action.description}</p>{last && <small>{when(last.updatedAt)}</small>}</div>{last && <Tag tone={taskStatus(last).tone}>{taskStatus(last).label}</Tag>}
        </button>;
      })}</nav>
      <div className="mw-repository-list-footer">{jobs.filter(j => ['queued', 'running'].includes(j.status)).length} 个运行中 · {jobs.filter(j => j.status === 'awaiting_review').length} 个待审阅</div>
    </aside>
    <section className="mw-organize-main mw-reader-embedded" aria-label="仓库维护详情">
      <header className="mw-reader-header"><h2><button className="mw-icon-button mw-repository-back" aria-label="返回仓库维护列表" onClick={() => setDetailOpen(false)}><ArrowLeft size={16}/></button>{current.title}</h2>
        <div className="mw-reader-tabbar"><nav className="mw-reader-tabs" aria-label="仓库维护详情页面">{(['Overview', 'Configure', 'Results', 'History'] as Panel[]).map(p => <button key={p} className={panel === p ? 'active' : ''} aria-current={panel === p ? 'page' : undefined} onClick={() => setPanel(p)}>{p}{p === 'History' && modeJobs.length ? ` (${modeJobs.length})` : ''}</button>)}</nav></div>
      </header>
      <div className="mw-repository-content">
        {(error || draftError) && <p role="alert" className="mw-repository-error">{error || draftError}</p>}
        {panel === 'Overview' && <>
          <div className="mw-repository-section-heading"><p>{current.description}</p><button className="mw-button" onClick={() => setPanel('Configure')}>配置并开始</button></div>
          <section className="mw-repository-section"><h3>仓库上下文</h3><dl className="mw-repository-context"><dt>工作区</dt><dd>{repo?.localPath || '执行时准备本地工作副本'}</dd><dt>版本</dt><dd>{repo?.localBranch || repo?.defaultBranch} {repo?.headSha?.slice(0, 12) || '尚未读取'}</dd><dt>语言</dt><dd>{repo?.profile?.languages.join('、') || '首次执行时识别'}</dd><dt>检查命令</dt><dd>{repo?.profile?.commands.length ? repo.profile.commands.map((c, i) => <div key={i}><code>{c.command}</code> <small>{c.source}</small></div>) : '首次执行时从仓库清单、贡献指南和 CI 中识别'}</dd></dl></section>
          <section className="mw-repository-section"><h3>检查范围</h3><ul>{checks[mode].map(c => <li key={c}>{c}</li>)}</ul></section>
          {latest && <section className="mw-repository-section"><div className="mw-repository-section-heading"><h3>最近结果</h3><button className="mw-button" onClick={() => { setSelectedJob(latest.id); setPanel('Results'); }}>查看结果</button></div><Tag tone={taskStatus(latest).tone}>{taskStatus(latest).label}</Tag><p>{latest.artifact?.summary || latest.result?.summary || latest.error || '任务已派发，等待结果。'}</p></section>}
          {repo?.profile?.warnings.length ? <details><summary>上下文读取限制 · {repo.profile.warnings.length}</summary><ul>{repo.profile.warnings.map((s, i) => <li key={i}>{s}</li>)}</ul></details> : null}
        </>}
        {panel === 'Configure' && <>
          <label className="mw-repository-field">本次范围与要求<textarea aria-label="本次范围与要求" rows={5} maxLength={4000} value={draft.instructions} onChange={e => update({ instructions: e.target.value })} placeholder="例如：只检查 docs/ 和 README；保留历史设计；补齐新的安装步骤。"/></label>
          {mode === 'docs' && <label className="mw-repository-field">文档同步范围<select aria-label="文档同步范围" value={draft.pr} onChange={e => update({ pr: e.target.value })}><option value="">整个仓库</option>{prs.map(i => <option key={i.id} value={i.id}>PR #{i.number} · {i.title}</option>)}</select></label>}
          {mode !== 'audit' && <label className="mw-repository-field">沿用检查报告<select aria-label="沿用检查报告" value={draft.auditJobId} onChange={e => update({ auditJobId: e.target.value })}><option value="">直接检查当前仓库</option>{audits.map(j => <option key={j.id} value={j.id}>{when(j.createdAt)} · {j.artifact?.summary.slice(0, 80)}</option>)}</select></label>}
          <div className="mw-repository-section-heading"><span>{mode === 'audit' ? '只读检查，结果自动保存。' : '在独立工作副本准备补丁，随后验证和审阅。'}</span><button className="mw-button primary" disabled={!!disabledReason || submitting || busy || !!running} onClick={() => void start()}>{submitting ? '正在派发…' : running ? '任务进行中' : mode === 'audit' ? '开始检查' : '准备修改'}</button></div>
          {disabledReason && <p role="status">{disabledReason}</p>}
          {running && <button className="mw-button" onClick={() => { setSelectedJob(running.id); setPanel('Results'); }}>查看正在执行的任务</button>}
        </>}
        {panel === 'Results' && (chosen ? <>
          <div className="mw-repository-section-heading"><div><Tag tone={taskStatus(chosen).tone}>{taskStatus(chosen).label}</Tag><small> {when(chosen.updatedAt)}</small></div><div className="mw-repository-actions">{active && <button className="mw-button" disabled={busy} onClick={() => void command('/cancel', chosen)}>取消任务</button>}{chosen.status === 'failed' && <button className="mw-button" disabled={busy} onClick={() => void command(reportNeedsRecovery(chosen) ? '/retry' : '/rerun', chosen)}><RefreshCw size={14}/>{reportNeedsRecovery(chosen) ? "重新整理报告" : "重试"}</button>}<button className="mw-button" onClick={() => open(chosen.id)}>查看执行与审阅</button></div></div>
          {chosen.error && <p role="alert" className="mw-repository-error">{chosen.error}</p>}
          {report ? <><section className="mw-repository-section"><h3>结论</h3><RepositoryMarkdown text={report.summary}/></section>{'facts' in report && <section className="mw-repository-section"><h3>仓库事实与文档职责</h3><ul>{report.facts.map((s, i) => <li key={i}>{s}</li>)}</ul></section>}{'proposedChanges' in report && <section className="mw-repository-section"><h3>建议修改</h3><ul>{report.proposedChanges.map((s, i) => <li key={i}>{s}</li>)}</ul></section>}{'changes' in report && <section className="mw-repository-section"><h3>已准备的修改</h3><ul>{report.changes.map((s, i) => <li key={i}>{s}</li>)}</ul></section>}
            <details><summary>证据 · {report.evidence.length}</summary>{report.evidence.map((e, i) => <div className="mw-repository-evidence" key={i}><code>{e.source}</code><p>{e.detail}</p></div>)}</details>
            {'tests' in report && <details><summary>验证记录 · {report.tests.length}</summary>{report.tests.map((t, i) => <div className="mw-repository-evidence" key={i}><code>{t.command}</code><Tag>{t.status}</Tag><pre>{t.output}</pre></div>)}</details>}
            {'blockers' in report && report.blockers.length > 0 && <section className="mw-repository-section"><h3>待解决</h3><ul>{report.blockers.map((s, i) => <li key={i}>{s}</li>)}</ul></section>}
            {report.nextSteps.length > 0 && <section className="mw-repository-section"><h3>建议下一步</h3><ul>{report.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ul></section>}
          </> : <Empty title={active ? '任务执行中' : '尚无保存的报告'} text="可查看执行记录；完成后结果会自动显示在这里。"/>}
          {mode === 'audit' && chosen.status === 'completed' && chosen.artifactState !== 'stale' && chosen.artifact && <div className="mw-repository-actions">{(['docs', 'agents', 'ci'] as OrganizeMode[]).map(next => <button className="mw-button" key={next} onClick={() => { setMode(next); setPanel('Configure'); try { const k = `maintainer.repository:${repoId}:${next}`; localStorage.setItem(k, JSON.stringify({ ...emptyDraft, ...JSON.parse(localStorage.getItem(k) ?? '{}'), auditJobId: chosen.id })); } catch { setError('无法保存报告选择，请在配置中重新选择。'); } }}>{organizeActions[next].title}</button>)}</div>}
        </> : <Empty title="还没有检查结果" text="配置范围并开始；结果将按仓库保存。"/>)}
        {panel === 'History' && (modeJobs.length ? <div className="mw-repository-history">{modeJobs.map(j => <button className="mw-task-row" key={j.id} onClick={() => { setSelectedJob(j.id); setPanel('Results'); }}><div><strong>{j.artifact?.summary || j.result?.summary || j.issueSnapshot.title}</strong><small>{when(j.createdAt)} · {j.kind}{j.sourceJobId ? ' · 关联后续任务' : ''}</small></div><Tag tone={taskStatus(j).tone}>{taskStatus(j).label}</Tag></button>)}</div> : <Empty title="暂无执行历史" text="本项维护的运行记录会保留在这里。"/>)}
      </div>
    </section>
  </div>;
}
