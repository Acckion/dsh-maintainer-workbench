import type { Context } from '@deepseek-ai/cordis';
import { Store } from '../src/core/store.ts';
import { buildModelCatalog } from '@deepseek-ai/dsh-api-session-controller';
import { Workbench } from '../src/core/workbench.ts';
import { harnessRunner, hostStatus } from '../src/plugin/native-runner.ts';
import { categorySessionId, recordTaskConversations } from '../src/plugin/task-conversations.ts';
import { taskConversationCategory } from '../src/core/conversations.ts';
import { GitHub } from '../src/core/github.ts';
import { git } from '../src/core/git.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import type {} from '@deepseek-ai/dsh-compaction';
export const inject = ['agents', 'agentPresets', 'permissionPresets', 'workspaceRegistry', 'agentDefaultModel', 'llm', 'toolResultPruner', 'compaction', 'sessions', 'sessionPersistence'];
async function conversationRecords(ctx: Context, store: Store) {
  const counts: Record<string, number> = {};
  for (const job of store.jobs()) {
    const id = categorySessionId(job.repoId, taskConversationCategory(job));
    if (id in counts) continue;
    const reader = await ctx.sessionPersistence.open(id, 'read');
    try { counts[id] = (await reader.read()).events.filter(event => event.type === 'user/message' && event.data.source.kind === 'maintainer-record').length; }
    finally { await reader.close(); }
  }
  return counts;
}
export async function apply(ctx: Context) {
  console.log('NATIVE_FIXTURE_SERVICES_READY');
  const dir = process.env.FIXTURE_DIR!;
  const path = join(dir, 'repo');
  const sha = await git(path, ['rev-parse', 'HEAD']);
  const store = new Store(join(dir, 'jobs.sqlite'));
  if (process.env.FIXTURE_RESTART === '1') {
    const before = await conversationRecords(ctx, store);
    await recordTaskConversations(ctx, store.jobs(), store.repos(), dir);
    await recordTaskConversations(ctx, store.jobs(), store.repos(), dir);
    if (JSON.stringify(before) !== JSON.stringify(await conversationRecords(ctx, store))) throw Error('宿主重启后不能重复追加历史记录');
    const source = store.jobs().find(job => job.id === 'pr-one')!;
    store.put('jobs', { ...source, id: 'pr-retry-after-restart', attempt: 2 });
    await recordTaskConversations(ctx, store.jobs(), store.repos(), dir);
    const after = await conversationRecords(ctx, store);
    const id = categorySessionId(source.repoId, taskConversationCategory(source));
    if (after[id] !== before[id] + 1) throw Error('重启后的新记录必须恢复并复用原有会话');
    const workspaces = ctx.workspaceRegistry.list().map(workspace => ({ path: workspace.path, sessions: workspace.sessionIds }));
    if (workspaces.length !== 2 || workspaces.reduce((n, workspace) => n + workspace.sessions.length, 0) !== 3) throw Error('重启后应保留两个仓库主区和三个类别子区');
    await writeFile(join(dir, 'restart.json'), JSON.stringify({ before, after, workspaces }, null, 2));
    store.close(); console.log('CONVERSATION_RESTART_PASS'); return;
  }
  const github = new GitHub('', async () => Response.json([]));
  const workbench = new Workbench(store, dir, harnessRunner(ctx, github), github, true, () => hostStatus(ctx), () => buildModelCatalog(ctx));
  workbench.updateSettings({ ...store.settings(), timeoutMs: 90000, concurrency: 1, provider: 'obsolete-plugin-provider', model: 'obsolete-plugin-model', permissionPreset: 'inherit',nativeDefaultModel:{provider:'deepseek-official',model:'deepseek-v4-pro'},stageModels:{triage:{provider:'deepseek-official',model:'deepseek-flash'}} });
  await workbench.validateModelSettings(store.settings());
  const modelCatalog=await workbench.models();
  store.put('repos', { id: 'fixture/native', fullName: 'fixture/native', mode: 'github', headSha: sha, defaultBranch: 'main', localPath: path, description: '', syncedAt: null, syncWarning: null });
  store.put('issues', { id: 'fixture/native#1', repoId: 'fixture/native', number: 1, type: 'issue', title: 'sum implementation is subtraction', body: 'Run node fixture-fix.cjs to reproduce and fix the deterministic fixture', author: 'fixture', labels: [], state: 'open', comments: 0, updatedAt: '2026-09-22', url: '' });
  workbench.enqueue(['fixture/native#1'], 'fix');
  store.put('repos', { ...store.repos()[0], id: 'fixture/metadata', fullName: 'fixture/metadata', localPath: '' });
  store.put('issues', { ...store.issues()[0], id: 'fixture/metadata#2', repoId: 'fixture/metadata', number: 2, title: 'Metadata-only issue', body: 'Classify from provided discussion only' });
  workbench.enqueue(['fixture/metadata#2'], 'triage');
  void workbench.drain().then(async () => {
    const implementation = store.jobs().find(job => job.kind === 'fix')!;
    if (implementation.status === 'awaiting_review') {
      workbench.enqueue(['fixture/native#1'], 'validate', { sourceJobId: implementation.id });
      await workbench.drain();
    }
    const inputIssue={...store.issues()[0],id:'fixture/native#3',number:3,title:'Input bridge fixture'};
    store.put('issues',inputIssue);
    const inputId=workbench.enqueue([inputIssue.id],'investigate',{instructions:'INPUT_BRIDGE_FIXTURE'}).created[0];
    await workbench.drain();
    const paused=store.jobs().find(job=>job.id===inputId)!;
    const state=store.processing.current(inputIssue.id)!,wait=state.waits.find(w=>w.type==='user_input'&&w.state==='open');
    let continuedId:string|undefined;
    if(wait){workbench.processing.submitInput(inputIssue.id,wait.id,{behavior:'Keep queue order'},state.version);continuedId=workbench.resume(inputId).created[0];await workbench.drain();}
    const inputProbe={pausedStatus:paused.status,question:wait?.questions?.[0].question,continuedStatus:store.jobs().find(job=>job.id===continuedId)?.status,differentWorktree:paused.worktree!==store.jobs().find(job=>job.id===continuedId)?.worktree,running:workbench.snapshot().capabilities.running};
    await recordTaskConversations(ctx, store.jobs(), store.repos(), dir);
    await recordTaskConversations(ctx, store.jobs(), store.repos(), dir);
    const records = () => conversationRecords(ctx, store);
    const initialRecords = await records();
    // Synthetic PR results probe grouping with the real host/session store, independently of remote GitHub.
    const base = store.jobs().find(job => job.kind === 'triage')!;
    for (const [id, number, category] of [['pr-one', 101, 'maintenance'], ['pr-two', 102, 'maintenance'], ['pr-docs', 103, 'docs']] as const) {
      store.put('jobs', { ...base, id, repoId: 'fixture/native', conversationCategory: category, sessionId: undefined,
        issueId: `fixture/native#${number}`, issueSnapshot: { ...base.issueSnapshot!, id: `fixture/native#${number}`, repoId: 'fixture/native', number, type: 'pr' } });
    }
    await recordTaskConversations(ctx, store.jobs(), store.repos(), dir);
    const addedRecords = await records();
    await recordTaskConversations(ctx, store.jobs(), store.repos(), dir);
    if (JSON.stringify(addedRecords) !== JSON.stringify(await records())) throw new Error('重复同步不得追加重复记录');
    const bugId = categorySessionId('fixture/native', 'maintenance');
    if (addedRecords[bugId] !== initialRecords[bugId] + 2) throw new Error('不同 PR 的同类记录应追加到原有类别会话');
    const changed = store.jobs().find(job => job.id === 'pr-two')!;
    store.put('jobs', { ...changed, result: { ...changed.result!, summary: 'PR 分类记录更新' } });
    await recordTaskConversations(ctx, store.jobs(), store.repos(), dir);
    const updatedRecords = await records();
    if (updatedRecords[bugId] !== addedRecords[bugId] + 1) throw new Error('更新后的结果应保留新的归纳记录');
    const conversationProbe = { workspaces: ctx.workspaceRegistry.list().map(workspace => ({ path: workspace.path, sessions: workspace.sessionIds })), archived: ctx.workspaceRegistry.archivedSessionIds, initialRecords, addedRecords, updatedRecords };
    const categories = conversationProbe.workspaces.filter(workspace => workspace.sessions.some(id => String(id).startsWith('maintainer-category-')));
    if (categories.length !== 2 || categories.find(workspace => workspace.path === path)?.sessions.length !== 2 || categories.find(workspace => workspace.path !== path)?.sessions.length !== 1)
      throw new Error('类别对话必须按仓库复用主区，每个类别只注册一个入口');
    if (store.jobs().some(job => job.sessionId && !conversationProbe.archived.includes(job.sessionId as any)))
      throw new Error('执行会话结束后必须归档，保留类别入口');
    await writeFile(join(dir, 'result.json'), JSON.stringify({ ...workbench.snapshot(), modelCatalog, inputProbe, conversationProbe, contextProbe: { pruned: ctx.toolResultPruner.pruneContent([{ type: 'text', text: 'HEAD' + 'x'.repeat(12000) + 'TAIL' }]) } }, null, 2)); console.log('NATIVE_FIXTURE_RESULT', store.jobs()[0].status, store.jobs()[0].error ?? '');
  });
  ctx.effect(() => () => workbench.close());
}
