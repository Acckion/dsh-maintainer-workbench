import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { fixtureAnalysis, seedFixture, fixtureRunner } from './support/fixtures.ts';
import { GitHub } from '../src/core/github.ts';
import { git, collectPatch } from '../src/core/git.ts';
import { Credentials } from '../src/core/credentials.ts';
import { handler, localRejection } from '../src/server/http.ts';
import type { Job, Runner } from '../src/core/types.ts';

function fixture(autoStart = true) { const store = new Store(':memory:'); const workbench = new Workbench(store, '/tmp/maintainer-tests', fixtureRunner, undefined, autoStart); seedFixture(store); return { store, workbench, issue: store.issues()[0] }; }

test('bulk dispatch is atomic and duplicate clicks reuse the same revision', async () => {
  const { workbench, store, issue } = fixture(false);
  assert.throws(() => workbench.enqueue([issue.id, 'missing'], 'triage')); assert.equal(store.jobs().length, 0);
  const first = workbench.enqueue([issue.id], 'triage');
  assert.deepEqual(workbench.enqueue([issue.id], 'triage'), { created: [], reused: first.created });
  workbench.pump(); await workbench.drain();
  assert.equal(store.jobs()[0].status, 'awaiting_review'); assert.equal(store.jobs()[0].engine, 'unit-test fixture');
  assert.equal(store.issues()[0].analysis?.tests[0].status, 'not_run');
  await workbench.close();
});

test('cancelled work never overwrites cancellation with completed; retry keeps original attempt', async () => {
  const { workbench, store, issue } = fixture();
  const id = workbench.enqueue([issue.id], 'triage').created[0]; workbench.cancel(id); await workbench.drain();
  assert.equal(store.get<Job>('jobs', id)?.status, 'cancelled');
  workbench.retry(id); await workbench.drain();
  assert.deepEqual(store.jobs().map(j => j.status), ['cancelled', 'awaiting_review']);
  assert.equal(store.jobs()[1].attempt, 2); await workbench.close();
});

test('concurrency cap and timeout apply to the actual worker lifecycle', async () => {
  const { workbench, store } = fixture(false);
  workbench.updateSettings({ ...store.settings(), concurrency: 1, timeoutMs: 1000 });
  workbench.enqueue(store.issues().slice(0, 3).map(i => i.id), 'triage'); workbench.pump();
  assert.equal(store.jobs().filter(j => j.status === 'running').length, 1);
  await workbench.drain(); assert.equal(store.jobs().filter(j => j.status === 'awaiting_review').length, 3);
  await workbench.close();
});

test('stale issue input cannot approve an old result', async () => {
  const { workbench, store, issue } = fixture();
  const id = workbench.enqueue([issue.id], 'triage').created[0]; await workbench.drain();
  store.put('issues', { ...issue, title: 'changed' });
  await assert.rejects(workbench.review(id, 'approve', ''), /输入已变化/);
  await workbench.review(id, 'reject', 'need fresh evidence'); assert.equal(store.get<Job>('jobs', id)?.status, 'rejected');
  await workbench.close();
});

test('restart preserves queued tasks but does not replay a running modification', async () => {
  const { store, workbench, issue } = fixture(false);
  const id = workbench.enqueue([issue.id], 'fix').created[0];
  store.put('jobs', { ...store.get<Job>('jobs', id)!, status: 'running' });
  const recovered = new Workbench(store, '/tmp/maintainer-tests', undefined, undefined, false);
  assert.equal(store.get<Job>('jobs', id)?.status, 'failed');
  assert.match(store.get<Job>('jobs', id)?.error ?? '', /进程中断/); await recovered.close();
});

test('HTTP rejects cross-origin mutations and malformed batch input', async () => {
  const { workbench } = fixture(false);
  const server = createServer(handler(workbench, localRejection)); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/maintainer/api`;
  assert.equal((await fetch(url + '/jobs', { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url + '/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"issueIds":[],"kind":"invalid"}' })).status, 400);
  assert.equal((await fetch(url + '/state')).status, 200);
  await new Promise<void>(r => server.close(() => r())); await workbench.close();
});

test('GitHub pagination excludes no PR records and reports the pinned default branch SHA', async () => {
  const calls: string[] = [];
  const fake: typeof fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.includes('/commits/')) return Response.json({ sha: 'abc123' });
    if (url.includes('/issues?')) return Response.json([{ number: 7, title: 'PR example', body: null, user: { login: 'dev' }, labels: [{ name: 'bug' }], state: 'open', comments: 1, updated_at: '2026-09-22T00:00:00Z', html_url: 'https://github.com/owner/repo/pull/7', pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/7' } }]);
    return Response.json({ full_name: 'owner/repo', description: null, default_branch: 'main' });
  };
  const result = await new GitHub('', fake).sync('owner/repo');
  assert.equal(result.repo.headSha, 'abc123'); assert.equal(result.issues[0].type, 'pr'); assert.equal(calls.length, 3);
});

test('secrets persist with 0600 permissions and invalid remote HTTP is refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maintainer-secret-'));
  const oldKey = process.env.MAINTAINER_API_KEY, oldDeepseek = process.env.DEEPSEEK_API_KEY;
  const credentials = new Credentials(directory);
  await credentials.save({ apiKey: 'test-placeholder', baseUrl: 'https://api.example.com/v1' });
  assert.equal((await stat(join(directory, 'credentials.json'))).mode & 0o777, 0o600);
  await assert.rejects(credentials.save({ baseUrl: 'http://remote.example.com' }), /HTTPS/);
  if (oldKey === undefined) delete process.env.MAINTAINER_API_KEY; else process.env.MAINTAINER_API_KEY = oldKey;
  if (oldDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldDeepseek;
  delete process.env.MAINTAINER_BASE_URL;
});

test('local execution produces an actual patch and blocks approval after worktree tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maintainer-git-')); const path = join(dir, 'repo'); await mkdir(path);
  await git(path, ['init', '-b', 'main']); await git(path, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  await writeFile(join(path, 'sum.js'), 'export const sum = (a,b) => a-b;\n'); await git(path, ['add', '.']); await git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'initial']);
  const sha = await git(path, ['rev-parse', 'HEAD']);
  const store = new Store(':memory:');
  const runner: Runner = async ({ job, issue }) => { await writeFile(join(job.worktree!, 'sum.js'), 'export const sum = (a,b) => a+b;\n'); return { result: fixtureAnalysis(issue, 'fix'), engine: 'test-fixture' }; };
  const workbench = new Workbench(store, dir, runner);
  const repo = { id: 'owner/repo', fullName: 'owner/repo', description: '', defaultBranch: 'main', headSha: sha, localPath: path, mode: 'github' as const, syncedAt: null, syncWarning: null };
  store.put('repos', repo); store.put('issues', { id: 'owner/repo#1', repoId: repo.id, number: 1, type: 'issue', title: 'sum returns wrong answer', body: 'sum(2,1) should be 3', author: 'dev', labels: [], state: 'open', comments: 0, updatedAt: '2026-09-22', url: 'https://github.com/owner/repo/issues/1' });
  const id = workbench.enqueue(['owner/repo#1'], 'fix').created[0]; await workbench.drain();
  const job = store.get<Job>('jobs', id)!; assert.equal(job.status, 'awaiting_review'); assert.match(job.patch!, /a\+b/);
  assert.match(await readFile(join(path, 'sum.js'), 'utf8'), /a-b/);
  await writeFile(join(job.worktree!, 'sum.js'), 'export const sum = () => 0;\n');
  await assert.rejects(workbench.review(id, 'approve', ''), /差异已过期/);
  await workbench.close();
});

test('fix -> real failing/passing test -> review -> commit/push -> draft PR request is runnable locally', async () => {
  const { publish } = await import('../src/core/publish.ts');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), 'maintainer-e2e-'));
  const path = join(directory, 'repo'), bare = join(directory, 'remote.git'); await mkdir(path); await mkdir(bare);
  await git(bare, ['init', '--bare']); await git(path, ['init', '-b', 'main']); await git(path, ['remote', 'add', 'origin', 'https://github.com/fixture/local.git']);
  await writeFile(join(path, 'sum.cjs'), 'module.exports = (a,b) => a-b;\n');
  await writeFile(join(path, 'test.cjs'), "const assert=require('node:assert/strict');assert.equal(require('./sum.cjs')(2,1),3);console.log('regression passed');\n");
  await git(path, ['add', '.']); await git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'initial']);
  const sha = await git(path, ['rev-parse', 'HEAD']); const store = new Store(':memory:');
  const repo = { id: 'fixture/local', fullName: 'fixture/local', description: '', defaultBranch: 'main', headSha: sha, localPath: path, mode: 'github' as const, syncedAt: null, syncWarning: null };
  const issue = { id: 'fixture/local#1', repoId: repo.id, number: 1, type: 'issue' as const, title: 'sum is subtraction', body: 'sum(2,1) should return 3', author: 'dev', labels: [], state: 'open' as const, comments: 0, updatedAt: '2026-09-22T00:00:00Z', url: 'https://github.com/fixture/local/issues/1' };
  const runner: Runner = async ({ job }) => {
    let before = '';
    try { await exec(process.execPath, ['test.cjs'], { cwd: job.worktree }); assert.fail('baseline must fail'); }
    catch (e) { before = String((e as { stderr: string }).stderr); assert.match(before, /AssertionError/); }
    await writeFile(join(job.worktree!, 'sum.cjs'), 'module.exports = (a,b) => a+b;\n');
    const after = await exec(process.execPath, ['test.cjs'], { cwd: job.worktree });
    const result = fixtureAnalysis(issue, 'fix'); result.summary = 'Local fixture: corrected subtraction to addition.';
    result.tests = [{ command: 'node test.cjs (before)', status: 'failed', output: before.slice(0, 1000) }, { command: 'node test.cjs (after)', status: 'passed', output: after.stdout }];
    return { result, engine: 'deterministic-local-test-runner' };
  };
  const workbench = new Workbench(store, directory, runner); store.put('repos', repo); store.put('issues', issue);
  const id = workbench.enqueue([issue.id], 'fix').created[0]; await workbench.drain(); await workbench.review(id, 'approve', 'local fixture checked');
  const requests: { url: string; body?: unknown }[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input); requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/issues/')) return Response.json({ updated_at: issue.updatedAt });
    if (url.includes('?state=')) return Response.json([]);
    return Response.json({ html_url: 'https://github.com/fixture/local/pull/2' });
  };
  const oldToken = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'fixture-token-not-real';
  try {
    const urls = await publish(store, store.get<Job>('jobs', id)!, repo, 'pr', new GitHub('', fake), async (cwd, args) => {
      assert.deepEqual(args.slice(0, 2), ['push', 'https://github.com/fixture/local.git']);
      return git(cwd, ['push', bare, args[2]]);
    });
    assert.deepEqual(urls, ['https://github.com/fixture/local/pull/2']);
    const payload = requests.find(r => r.url.endsWith('/pulls'))?.body as { draft: boolean; body: string };
    assert.equal(payload.draft, true); assert.match(payload.body, /regression passed/);
    assert.equal(await git(bare, ['rev-parse', store.get<Job>('jobs', id)!.branch!]), store.get<Job>('jobs', id)!.publishedCommit);
    assert.equal(store.get<Job>('jobs', id)!.publications?.pr?.status, 'published');
    assert.match(await readFile(join(path, 'sum.cjs'), 'utf8'), /a-b/);
  } finally { if (oldToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = oldToken; await workbench.close(); }
});

test('related issue retrieval prioritizes explicit links and causal terms over input order', async () => {
  const { retrieveRelated } = await import('../src/core/retrieval.ts');
  const { store, workbench, issue } = fixture(false);
  const reported = { ...issue, title: 'refresh token invalid', body: 'Same failure as #131 with concurrent refresh token requests' };
  const related = retrieveRelated(reported, store.issues().filter(i => i.id !== issue.id), 2);
  assert.equal(related[0].number, 131); assert.equal(related.length, 2); await workbench.close();
});

test('comment publication recovers an ambiguous POST without posting a duplicate', async () => {
  const { publish } = await import('../src/core/publish.ts');
  const { workbench, store, issue } = fixture();
  const id = workbench.enqueue([issue.id], 'triage').created[0]; await workbench.drain(); await workbench.review(id, 'approve', '');
  const original = store.repos()[0]; const repo = { ...original, mode: 'github' as const, fullName: 'fixture/repo' };
  let posted = '', writes = 0;
  const fake: typeof fetch = async (input, init) => {
    if (String(input).includes('/comments')) {
      if (init?.method === 'POST') { writes++; posted = JSON.parse(String(init.body)).body; throw new Error('simulated lost response after server commit'); }
      return Response.json(posted ? [{ body: posted, html_url: 'https://github.com/fixture/repo/issues/1#issuecomment-1' }] : []);
    }
    return Response.json({ updated_at: issue.updatedAt });
  };
  const old = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'fixture-only';
  try {
    await assert.rejects(publish(store, store.get<Job>('jobs', id)!, repo, 'comment', new GitHub('', fake)), /lost response/);
    const urls = await publish(store, store.get<Job>('jobs', id)!, repo, 'comment', new GitHub('', fake));
    assert.equal(writes, 1); assert.equal(urls.length, 1); assert.equal(store.get<Job>('jobs', id)!.publications?.comment?.status, 'published');
  } finally { if (old === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = old; await workbench.close(); }
});

test('a second worker cannot take the same data directory', async () => {
  const { lockDirectory } = await import('../src/core/lock.ts');
  const directory = await mkdtemp(join(tmpdir(), 'maintainer-lock-'));
  const release = lockDirectory(directory); assert.throws(() => lockDirectory(directory), /正在被进程/); release();
  const next = lockDirectory(directory); next();
});
