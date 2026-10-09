import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { git, prepareManagedCheckout, validateCheckout } from '../src/core/git.ts';
import type { Repo } from '../src/core/types.ts';

const template = (over: Partial<Repo>): Repo => ({
  id: 'owner/repo', fullName: 'owner/repo', description: '', defaultBranch: 'main',
  headSha: 'a'.repeat(40), localPath: '', mode: 'github', syncedAt: null, syncWarning: null, ...over,
});

test('connecting one remote of a multi-remote discovered workspace merges into one row', async () => {
  const github = new GitHub('');
  github.sync = async fullName => ({ repo: template({ id: fullName, fullName }), issues: [] });
  const store = new Store(':memory:');
  const workbench = new Workbench(store, '/tmp/import-merge-test', undefined, github, false);
  try {
    store.put('repos', template({
      id: 'local:workspace', fullName: 'workbench-folder', mode: 'local', discovered: true,
      localKind: 'git', defaultBranch: '', githubName: undefined, localPath: '/host/workbench-folder',
      remoteCandidates: ['owner/repo', 'owner/other'],
    }));
    await workbench.sync('owner/repo');
    assert.equal(store.repos().length, 1);
    const merged = store.repos()[0];
    assert.equal(merged.id, 'local:workspace');
    assert.equal(merged.githubName, 'owner/repo');
    assert.equal(merged.mode, 'local');
    assert.equal(merged.defaultBranch, 'main');
    await workbench.sync('owner/other');
    assert.equal(store.repos().length, 2);
  } finally { await workbench.close(); }
});

test('a row already linked to another GitHub repository is not merged with a different import', async () => {
  const github = new GitHub('');
  github.sync = async fullName => ({ repo: template({ id: fullName, fullName }), issues: [] });
  const store = new Store(':memory:');
  const workbench = new Workbench(store, '/tmp/import-isolation-test', undefined, github, false);
  try {
    store.put('repos', template({
      id: 'local:workspace', fullName: 'workbench-folder', mode: 'local', discovered: true,
      localKind: 'git', defaultBranch: '', githubName: 'owner/repo', localPath: '/host/workbench-folder',
      remoteCandidates: ['owner/repo', 'owner/second'],
    }));
    await workbench.sync('owner/second');
    assert.equal(store.repos().length, 2);
    const created = store.get<Repo>('repos', 'owner/second');
    assert.equal(created?.githubName, undefined);
    const linked = store.get<Repo>('repos', 'local:workspace');
    assert.equal(linked?.githubName, 'owner/repo');
  } finally { await workbench.close(); }
});

test('discovery keeps the synced GitHub default branch and reports the local branch separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'import-branch-'));
  await git(root, ['init', '-b', 'work']);
  await writeFile(join(root, 'README.md'), 'fixture');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base']);
  await git(root, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  const store = new Store(':memory:');
  const workbench = new Workbench(store, join(root, 'data'), undefined, undefined, false);
  try {
    store.put('repos', template({ id: 'owner/repo', defaultBranch: 'develop', localPath: '' }));
    await workbench.discover([root]);
    const repo = store.get<Repo>('repos', 'owner/repo');
    assert.ok(repo);
    assert.equal(repo.defaultBranch, 'develop');
    assert.equal(repo.localBranch, 'work');
    assert.equal(repo.githubName, 'owner/repo');
    assert.equal(repo.discovered, true);
  } finally { await workbench.close(); }
});

test('origin validation uses the linked GitHub name and explains mismatches per repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'import-origin-'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['remote', 'add', 'origin', 'https://github.com/other/place.git']);
  const toplevel = await realpath(await git(root, ['rev-parse', '--show-toplevel']));
  await assert.rejects(
    validateCheckout(root, template({ mode: 'local', githubName: 'owner/repo', localPath: root })),
    /本地 origin 与所选 GitHub 仓库（owner\/repo）不匹配/,
  );
  await assert.rejects(
    validateCheckout(root, template({ mode: 'github', fullName: 'owner/repo', localPath: root })),
    /本地 origin 与所选 GitHub 仓库（owner\/repo）不匹配/,
  );
  assert.equal(
    await validateCheckout(root, template({ mode: 'local', githubName: undefined, localPath: root })),
    toplevel,
  );
  await git(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git']);
  assert.equal(
    await validateCheckout(root, template({ mode: 'github', localPath: root })),
    toplevel,
  );
});

test('managed clone and fetch failures explain the cause in Chinese', async () => {
  const root = await mkdtemp(join(tmpdir(), 'import-clone-'));
  const repo = template({});
  const failing = (message: string, killed = false): typeof git => async () => {
    const error = new Error('git failed') as Error & { stderr?: string; killed?: boolean };
    error.stderr = `${message}\n`;
    error.killed = killed;
    throw error;
  };
  await assert.rejects(
    prepareManagedCheckout(repo, root, undefined, failing('fatal: repository not found')),
    /克隆 GitHub 仓库 owner\/repo 失败：fatal: repository not found/,
  );
  await assert.rejects(
    prepareManagedCheckout(repo, root, undefined, failing('git terminated', true)),
    /克隆 GitHub 仓库超时（超过 4 分钟）/,
  );
});

test('syncMany keeps valid entries beyond the 20-repository batch cap as per-line errors', async () => {
  const github = new GitHub('');
  let calls = 0;
  github.sync = async fullName => { calls++; return { repo: template({ id: fullName, fullName }), issues: [] }; };
  const store = new Store(':memory:');
  const workbench = new Workbench(store, '/tmp/import-batch-test', undefined, github, false);
  try {
    const names = Array.from({ length: 21 }, (_, i) => `owner/repo-${i}`);
    const { results } = await workbench.syncMany(names);
    assert.equal(results.length, 21);
    assert.equal(calls, 20);
    assert.equal(results[19].error, undefined);
    assert.equal(results[20].error, '一次最多连接 20 个仓库，请分批');
    const { results: mixed } = await workbench.syncMany(['owner/URL', 'https://github.com/Owner/Url.GIT', 'bad input']);
    assert.equal(mixed.length, 2);
    assert.equal(mixed[0].fullName, 'owner/url');
    assert.equal(mixed[1].error, '不是有效的 owner/repository 或 GitHub 仓库地址');
  } finally { await workbench.close(); }
});
