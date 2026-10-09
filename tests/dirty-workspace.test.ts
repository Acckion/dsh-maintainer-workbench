import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { git } from '../src/core/git.ts';
import { GitHub } from '../src/core/github.ts';
import { Store } from '../src/core/store.ts';
import type { Issue, Job, Runner } from '../src/core/types.ts';
import { Workbench } from '../src/core/workbench.ts';
import { WorkspaceManager } from '../src/infrastructure/git/workspace-manager.ts';
import { fixtureAnalysis, seedFixture } from './support/fixtures.ts';

async function fixture(t: TestContext, runner: Runner) {
  const dir = await mkdtemp(join(tmpdir(), 'mw-dirty-'));
  const path = join(dir, 'source');
  await mkdir(path);
  await git(path, ['init', '-b', 'main']);
  await writeFile(join(path, 'value.txt'), 'committed\n');
  await git(path, ['add', '.']);
  await git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '-m', 'baseline']);
  const headSha = await git(path, ['rev-parse', 'HEAD']);
  // Retain a staged new file, staged edits followed by unstaged edits, and an
  // untracked file. Compare the actual source index bytes after every stage.
  await writeFile(join(path, 'AGENTS.md'), '# Pending document task\n');
  await writeFile(join(path, 'value.txt'), 'staged\n');
  await git(path, ['add', '.']);
  await writeFile(join(path, 'value.txt'), 'unstaged\n');
  await writeFile(join(path, 'untracked.txt'), 'user scratch\n');
  const store = new Store(':memory:');
  seedFixture(store);
  const repo = { ...store.repos()[0], mode: 'local' as const, localKind: 'git' as const, discovered: true, dirty: true, headSha, localPath: path };
  store.put('repos', repo);
  const github = new GitHub('', async () => Response.json([]));
  const w = new Workbench(store, join(dir, 'data'), runner, github, false);
  t.after(async () => { await w.close(); await rm(dir, { recursive: true, force: true }); });
  const before = {
    index: await readFile(join(path, '.git', 'index')),
    status: await git(path, ['status', '--porcelain']),
    head: headSha,
  };
  const assertSourcePreserved = async () => {
    assert.deepEqual(await readFile(join(path, '.git', 'index')), before.index);
    assert.equal(await git(path, ['status', '--porcelain']), before.status);
    assert.equal(await git(path, ['rev-parse', 'HEAD']), before.head);
    assert.equal(await git(path, ['branch', '--show-current']), 'main');
    assert.equal(await readFile(join(path, 'value.txt'), 'utf8'), 'unstaged\n');
    assert.equal(await readFile(join(path, 'AGENTS.md'), 'utf8'), '# Pending document task\n');
    assert.equal(await readFile(join(path, 'untracked.txt'), 'utf8'), 'user scratch\n');
  };
  return { dir, path, headSha, repo, store, github, w, assertSourcePreserved };
}

async function assertCommittedInput(job: Job) {
  assert.ok(job.worktree);
  assert.equal(await readFile(join(job.worktree, 'value.txt'), 'utf8'), 'committed\n');
  await assert.rejects(readFile(join(job.worktree, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(job.worktree, 'untracked.txt')), { code: 'ENOENT' });
}

test('dirty local checkout permits isolated fix and frozen validation handoff without changing its index or files', async t => {
  const paths: string[] = [];
  const f = await fixture(t, async ({ job, issue }) => {
    paths.push(job.worktree!);
    if (job.kind === 'fix') {
      await assertCommittedInput(job);
      await writeFile(join(job.worktree!, 'value.txt'), 'task fix\n');
    } else {
      assert.equal(await readFile(join(job.worktree!, 'value.txt'), 'utf8'), 'task fix\n');
    }
    return { result: fixtureAnalysis(issue, job.kind), engine: 'fixture' };
  });
  const id = f.w.enqueue([f.store.issues()[0].id], 'fix').created[0];
  f.w.pump(); await f.w.drain();
  const source = f.store.get<Job>('jobs', id)!;
  assert.equal(source.status, 'awaiting_review', source.error);
  await f.assertSourcePreserved();
  const next = f.w.enqueue([source.issueId], 'validate', { sourceJobId: id }).created[0];
  f.w.pump(); await f.w.drain();
  const validation = f.store.get<Job>('jobs', next)!;
  assert.equal(validation.status, 'completed', validation.error);
  assert.equal(new Set(paths).size, 2);
  const manager = new WorkspaceManager(f.store, join(f.dir, 'data'));
  assert.equal(manager.snapshot(id)!.resultTreeHash, manager.snapshot(next)!.resultTreeHash);
  assert.doesNotMatch(source.patch!, /staged|unstaged|Pending document|scratch/);
  await f.assertSourcePreserved();
});

test('ordinary PR review uses pinned PR head even with staged AGENTS.md in the source checkout', async t => {
  let inspected = false;
  const f = await fixture(t, async ({ job, issue }) => {
    await assertCommittedInput(job);
    assert.equal(job.kind, 'review');
    assert.equal(job.baseSha, f.headSha);
    inspected = true;
    return { result: fixtureAnalysis(issue, job.kind), engine: 'fixture' };
  });
  // Entire PR transport is local: no GitHub network or real model is used.
  await git(f.path, ['remote', 'add', 'origin', f.path]);
  await git(f.path, ['update-ref', 'refs/pull/7/head', f.headSha]);
  const issue: Issue = { ...f.store.issues()[0], type: 'pr', number: 7, headSha: f.headSha, prBaseSha: f.headSha };
  f.store.put('issues', issue);
  f.github.pullRequest = async () => ({ headSha: f.headSha, baseSha: f.headSha, headRef: 'topic', headRepo: f.repo.fullName, baseRef: 'main', draft: false, merged: false, mergeable: true, checks: [], reviews: [], warnings: [] });
  const id = f.w.enqueue([issue.id], 'review').created[0];
  f.w.pump(); await f.w.drain();
  const job = f.store.get<Job>('jobs', id)!;
  assert.equal(inspected, true, job.error);
  assert.ok(job.worktree);
  assert.notEqual(job.worktree, f.path);
  assert.equal(job.patch, '');
  await f.assertSourcePreserved();
});

test('repository organization can prepare a document patch from dirty local HEAD and keeps unrelated staged documents out', async t => {
  const f = await fixture(t, async ({ job, issue }) => {
    await assertCommittedInput(job);
    await writeFile(join(job.worktree!, 'AGENTS.md'), '# Generated in isolated task\n');
    return { result: fixtureAnalysis(issue, job.kind), engine: 'fixture' };
  });
  const id = f.w.organize(f.repo.id, 'agents').created[0];
  f.w.pump(); await f.w.drain();
  const job = f.store.get<Job>('jobs', id)!;
  assert.equal(job.status, 'awaiting_review', job.error);
  assert.match(job.patch!, /Generated in isolated task/);
  assert.doesNotMatch(job.patch!, /Pending document/);
  await f.assertSourcePreserved();
});

test('removing the dirty guard still requires a committed baseline for isolated tasks', async t => {
  const f = await fixture(t, async ({ issue, job }) => ({ result: fixtureAnalysis(issue, job.kind), engine: 'fixture' }));
  f.store.put('repos', { ...f.repo, headSha: '', localKind: 'folder' });
  assert.throws(() => f.w.organize(f.repo.id, 'agents'), /至少一个 Git 提交/);
  assert.throws(() => f.w.enqueue([f.store.issues()[0].id], 'fix'), /无 Git 提交/);
  assert.equal(f.store.jobs().length, 0);
  await f.assertSourcePreserved();
});
