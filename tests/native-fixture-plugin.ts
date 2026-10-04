import type { Context } from '@deepseek-ai/cordis';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { harnessRunner, hostStatus } from '../src/plugin/native-runner.ts';
import { GitHub } from '../src/core/github.ts';
import { git } from '../src/core/git.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const inject = ['agents', 'agentPresets', 'permissionPresets', 'workspaceRegistry', 'agentDefaultModel', 'llm'];
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
    await writeFile(join(dir, 'result.json'), JSON.stringify(workbench.snapshot(), null, 2)); console.log('NATIVE_FIXTURE_RESULT', store.jobs()[0].status, store.jobs()[0].error ?? '');
  });
  ctx.effect(() => () => workbench.close());
}
