import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { git } from '../src/core/git.ts';
import { ArtifactFormatError } from '../src/core/execution-errors.ts';
import { fixtureAnalysis, seedFixture } from './support/fixtures.ts';
import type { Job, Runner } from '../src/core/types.ts';

async function fixture(t: TestContext, runner: Runner) {
  const dir = await mkdtemp(join(tmpdir(), 'mw-recovery-'));
  const path = join(dir, 'repo');
  await mkdir(path);
  await git(path, ['init', '-b', 'main']);
  await git(path, ['remote', 'add', 'origin', 'https://github.com/fixture/queue.git']);
  await writeFile(join(path, 'value.txt'), 'original\n');
  await git(path, ['add', '.']);
  await git(path, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'initial']);
  const sha = await git(path, ['rev-parse', 'HEAD']);
  const store = new Store(':memory:');
  seedFixture(store);
  store.put('repos', { ...store.repos()[0], headSha: sha, localPath: path });
  const github = new GitHub('', async () => Response.json([]));
  const workbench = new Workbench(store, dir, runner, github, false);
  t.after(async () => { await workbench.close(); await rm(dir, { recursive: true, force: true }); });
  const run = async () => { workbench.pump(); await workbench.drain(); return store.jobs().at(-1)!; };
  return { store, workbench, run, github };
}

for (const kind of ['validate', 'review', 'ci'] as const) {
  test(`${kind} mutation rejection cannot be relabeled as a formatting failure on retry`, async t => {
    const calls: Job[] = [];
    const f = await fixture(t, async ({ job, issue, recordOutput }) => {
      calls.push(job);
      if (!job.formatOnly) await writeFile(join(job.worktree!, 'value.txt'), 'unapproved change\n');
      recordOutput?.('{"summary":"otherwise valid output"}');
      return { result: fixtureAnalysis(issue, job.kind), engine: 'test' };
    });
    // Seed the execution-stage job directly; PR fetching/routing has separate tests.
    const id = f.workbench.enqueue([f.store.issues()[0].id], 'validate').created[0];
    f.store.put('jobs', { ...f.store.get<Job>('jobs', id)!, kind });
    const failed = await f.run();
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!, /修改了代码/);
    assert.equal(failed.formatRecovery, undefined);
    if (kind === 'validate') f.workbench.retry(failed.id);
    else {
      // A retry must also pass enqueue's PR eligibility check. Temporarily capture
      // the requested retry kind, then queue its code-execution equivalent.
      const enqueue = f.workbench.enqueue.bind(f.workbench);
      f.workbench.enqueue = (ids, retryKind, options) => {
        assert.equal(retryKind, kind);
        const queued = enqueue(ids, 'validate', options);
        for (const id of queued.created) f.store.put('jobs', { ...f.store.get<Job>('jobs', id)!, kind });
        return queued;
      };
      f.workbench.retry(failed.id);
    }
    const retried = await f.run();
    assert.equal(retried.status, 'failed');
    assert.equal(retried.formatOnly, undefined);
    assert.notEqual(calls[0].worktree, calls[1].worktree);
    assert.equal(await readFile(join(failed.worktree!, 'value.txt'), 'utf8'), 'unapproved change\n');
  });
}

test('malformed output does not make a mutated validation workspace recoverable', async t => {
  const f = await fixture(t, async ({ job, recordOutput }) => {
    await writeFile(join(job.worktree!, 'value.txt'), 'unapproved change\n');
    recordOutput?.('malformed output');
    throw new ArtifactFormatError('schema validation failed');
  });
  f.workbench.enqueue([f.store.issues()[0].id], 'validate');
  const failed = await f.run();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /修改了代码/);
  assert.equal(failed.formatRecovery, undefined);
});

test('genuine format-only retries retain the reviewed execution patch without rerunning implementation', async t => {
  let implementations = 0;
  const f = await fixture(t, async ({ job, issue, recordOutput }) => {
    if (!job.formatOnly) {
      implementations++;
      await writeFile(join(job.worktree!, 'value.txt'), 'intended change\n');
      recordOutput?.('malformed output');
      throw new ArtifactFormatError('schema validation failed');
    }
    return { result: fixtureAnalysis(issue, job.kind), engine: 'test' };
  });
  f.workbench.enqueue([f.store.issues()[0].id], 'fix');
  const failed = await f.run();
  assert.ok(failed.formatRecovery);
  f.workbench.retry(failed.id);
  const recovered = await f.run();
  assert.equal(recovered.status, 'awaiting_review', recovered.error);
  assert.equal(recovered.formatOnly, true);
  assert.equal(recovered.worktree, failed.worktree);
  assert.match(recovered.patch!, /intended change/);
  assert.equal(implementations, 1);
  assert.equal(recovered.formatRecovery, undefined);
});

for (const tamper of ['patch', 'head'] as const) {
  test(`format recovery rejects ${tamper} drift before invoking the runner`, async t => {
    let calls = 0;
    const f = await fixture(t, async ({ job, issue, recordOutput }) => {
      calls++;
      if (job.formatOnly) return { result: fixtureAnalysis(issue, job.kind), engine: 'test' };
      await writeFile(join(job.worktree!, 'value.txt'), 'intended change\n');
      recordOutput?.('malformed output');
      throw new ArtifactFormatError('schema validation failed');
    });
    f.workbench.enqueue([f.store.issues()[0].id], 'fix');
    const failed = await f.run();
    if (tamper === 'patch') await writeFile(join(failed.worktree!, 'value.txt'), 'different change\n');
    else await git(failed.worktree!, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'unreviewed history']);
    f.workbench.retry(failed.id);
    const retried = await f.run();
    assert.equal(retried.status, 'failed');
    assert.match(retried.error!, /工作区.*已变化/);
    assert.equal(calls, 1);
    assert.equal(retried.formatRecovery, undefined);
  });
}

test('execution errors with recorded output retry as fresh work, not format-only recovery', async t => {
  const calls: Job[] = [];
  const f = await fixture(t, async ({ job, recordOutput }) => {
    calls.push(job);
    recordOutput?.('partial progress, not a completed result');
    throw new Error('permission or tool execution failed');
  });
  f.workbench.enqueue([f.store.issues()[0].id], 'investigate');
  const failed = await f.run();
  f.workbench.retry(failed.id);
  await f.run();
  assert.equal(calls[1].formatOnly, undefined);
  assert.notEqual(calls[0].worktree, calls[1].worktree);
});

for (const formatFails of [false, true]) test(`format-only recovery rejects concurrent changes when reformatting ${formatFails ? 'fails' : 'succeeds'}`, async t => {
  const f = await fixture(t, async ({ job, issue, recordOutput }) => {
    if (!job.formatOnly) {
      await writeFile(join(job.worktree!, 'value.txt'), 'intended change\n');
      recordOutput?.('malformed output');
      throw new ArtifactFormatError('schema validation failed');
    }
    await writeFile(join(job.worktree!, 'value.txt'), 'concurrent unreviewed change\n');
    if (formatFails) throw new ArtifactFormatError('still malformed');
    return { result: fixtureAnalysis(issue, job.kind), engine: 'test' };
  });
  f.workbench.enqueue([f.store.issues()[0].id], 'fix');
  const failed = await f.run();
  f.workbench.retry(failed.id);
  const retried = await f.run();
  assert.equal(retried.status, 'failed');
  assert.match(retried.error!, /结果整理期间已变化/);
  assert.equal(retried.formatRecovery, undefined);
});

test('cancellation during checkpoint capture stays cancelled and cannot enable format recovery', async t => {
  let captureStarting = false, cancelled = false;
  const f = await fixture(t, async ({ recordOutput }) => {
    recordOutput?.('malformed output');
    captureStarting = true;
    throw new ArtifactFormatError('schema validation failed');
  });
  const get = f.store.get.bind(f.store);
  f.store.get = ((table: Parameters<Store['get']>[0], id: string) => {
    const value = get(table, id);
    if (captureStarting && table === 'jobs') {
      captureStarting = false;
      queueMicrotask(() => { f.workbench.cancel(id); cancelled = true; });
    }
    return value;
  }) as Store['get'];
  f.workbench.enqueue([f.store.issues()[0].id], 'validate');
  const job = await f.run();
  assert.equal(cancelled, true);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.formatRecovery, undefined);
});

test('format-only PR recovery rejects a changed comparison base without stale local sync', async t => {
  let calls = 0;
  const f = await fixture(t, async ({ recordOutput }) => {
    calls++;
    recordOutput?.('malformed output');
    throw new ArtifactFormatError('schema validation failed');
  });
  const repo = f.store.repos()[0];
  const issue = { ...f.store.issues()[0], type: 'pr' as const, headSha: repo.headSha, prBaseSha: repo.headSha };
  f.store.put('issues', issue);
  let baseSha = repo.headSha;
  f.github.pullRequest = async () => ({ headSha: repo.headSha, baseSha, headRef: 'topic', headRepo: repo.fullName, baseRef: 'main', draft: false, merged: false, mergeable: null, checks: [], reviews: [], warnings: [] });
  f.workbench.enqueue([issue.id], 'preflight');
  const failed = await f.run();
  assert.ok(failed.formatRecovery);
  baseSha = 'b'.repeat(40);
  f.workbench.retry(failed.id);
  const retried = await f.run();
  assert.equal(retried.status, 'failed');
  assert.match(retried.error!, /head\/base 已变化/);
  assert.equal(calls, 1);
});
