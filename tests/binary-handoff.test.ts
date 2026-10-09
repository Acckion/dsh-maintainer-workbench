import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/core/git.ts';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { seedFixture, fixtureAnalysis } from './support/fixtures.ts';
import type { Job } from '../src/core/types.ts';

for (const mixed of [false, true]) test(`${mixed ? 'mixed text/binary' : 'binary-only'} patches survive fix, validation, review, and independent patch application`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mw-binary-')), path = join(dir, 'repo');
  await mkdir(path);
  await git(path, ['init', '-b', 'main']);
  await git(path, ['remote', 'add', 'origin', 'https://github.com/fixture/queue.git']);
  const before = Buffer.from([0, 1, 2, 3]), after = Buffer.from([0, 1, 2, 4]);
  await writeFile(join(path, 'asset.bin'), before);
  await writeFile(join(path, 'old.bin'), before);
  await writeFile(join(path, 'note.txt'), 'before\n');
  await git(path, ['add', '.']);
  await git(path, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'initial']);
  const sha = await git(path, ['rev-parse', 'HEAD']);
  const store = new Store(':memory:'); seedFixture(store);
  store.put('repos', { ...store.repos()[0], localPath: path, headSha: sha });
  const seen: string[] = [];
  const w = new Workbench(store, dir, async ({ job, issue }) => {
    seen.push(job.worktree!);
    if (job.kind === 'fix') {
      await writeFile(join(job.worktree!, 'asset.bin'), after);
      await writeFile(join(job.worktree!, 'new.bin'), after);
      await rm(join(job.worktree!, 'old.bin'));
      if (mixed) await writeFile(join(job.worktree!, 'note.txt'), 'after\n');
    } else {
      assert.deepEqual(await readFile(join(job.worktree!, 'asset.bin')), after);
      assert.deepEqual(await readFile(join(job.worktree!, 'new.bin')), after);
      await assert.rejects(readFile(join(job.worktree!, 'old.bin')), { code: 'ENOENT' });
      assert.equal(await readFile(join(job.worktree!, 'note.txt'), 'utf8'), mixed ? 'after\n' : 'before\n');
    }
    return { result: fixtureAnalysis(issue, job.kind), engine: 'test' };
  }, undefined, false);
  t.after(async () => { await w.close(); await rm(dir, { recursive: true, force: true }); });
  let sourceJobId: string | undefined;
  for (const kind of ['fix', 'validate', 'review'] as const) {
    sourceJobId = w.enqueue([store.issues()[0].id], kind, { sourceJobId }).created[0];
    w.pump(); await w.drain();
    const job = store.get<Job>('jobs', sourceJobId)!;
    assert.equal(job.status, kind === 'validate' ? 'completed' : 'awaiting_review', job.error);
    assert.match(job.patch!, /GIT binary patch/);
  }
  assert.equal(new Set(seen).size, 3);
  assert.deepEqual(await readFile(join(path, 'asset.bin')), before);
  const exportedPatch = join(dir, 'result.patch');
  await writeFile(exportedPatch, store.get<Job>('jobs', sourceJobId!)!.patch + '\n');
  await git(path, ['apply', '--check', exportedPatch]);
  await git(path, ['apply', exportedPatch]);
  assert.deepEqual(await readFile(join(path, 'asset.bin')), after);
  assert.deepEqual(await readFile(join(path, 'new.bin')), after);
});
