import type { Context } from '@deepseek-ai/cordis';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { harnessRunner, hostStatus } from '../src/plugin/native-runner.ts';
import { GitHub } from '../src/core/github.ts';
import { git } from '../src/core/git.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import type {} from '@deepseek-ai/dsh-compaction';
export const inject = ['agents', 'agentPresets', 'permissionPresets', 'workspaceRegistry', 'agentDefaultModel', 'llm', 'toolResultPruner', 'compaction'];
export async function apply(ctx: Context) {
  const dir = process.env.FIXTURE_DIR!;
  const path = join(dir, 'repo');
  const sha = await git(path, ['rev-parse', 'HEAD']);
  const store = new Store(join(dir, 'jobs.sqlite'));
  const github = new GitHub('', async () => Response.json([]));
  const workbench = new Workbench(store, dir, harnessRunner(ctx, github), github, true, () => hostStatus(ctx));
  workbench.updateSettings({ ...store.settings(), timeoutMs: 90000, concurrency: 1, provider: 'obsolete-plugin-provider', model: 'obsolete-plugin-model', permissionPreset: 'inherit' });
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
    await writeFile(join(dir, 'result.json'), JSON.stringify({ ...workbench.snapshot(), inputProbe, contextProbe: { pruned: ctx.toolResultPruner.pruneContent([{ type: 'text', text: 'HEAD' + 'x'.repeat(12000) + 'TAIL' }]) } }, null, 2)); console.log('NATIVE_FIXTURE_RESULT', store.jobs()[0].status, store.jobs()[0].error ?? '');
  });
  ctx.effect(() => () => workbench.close());
}
