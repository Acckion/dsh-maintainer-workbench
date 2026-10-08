import test from 'node:test';
import assert from 'node:assert/strict';
import { githubDetail } from '../src/core/github-details.ts';
import type { Issue, Repo } from '../src/core/types.ts';
import { createServer } from 'node:http';
import { handler, API } from '../src/server/http.ts';
import type { Workbench } from '../src/core/workbench.ts';

const repo: Repo = { id: 'other/public', fullName: 'other/public', description: '', defaultBranch: 'main', headSha: 'a'.repeat(40), localPath: '', mode: 'github', syncedAt: null, syncWarning: null };
const issue: Issue = { id: 'other/public#1', repoId: repo.id, number: 1, type: 'pr', title: 'PR', body: '', author: 'other', labels: [], state: 'open', comments: 0, updatedAt: '', url: 'https://github.com/other/public/pull/1' };
const pr = { head: { sha: 'a'.repeat(40), ref: 'feature', label: 'contributor:feature' }, base: { sha: 'b'.repeat(40), ref: 'main' }, draft: false, merged: false, mergeable: null, additions: 2, deletions: 1, changed_files: 1 };
const source = { title: 'Summary', body: '## Description', state: 'open', user: { login: 'contributor' }, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', html_url: issue.url, labels: [{ name: 'bug' }], assignees: [] };

test('summary reads original description and PR branch metadata without Agent or ownership requirements', async () => {
  const paths: string[] = [];
  const result = await githubDetail({ request: async path => { paths.push(path); return path.includes('/issues/') ? source : pr; } }, repo, issue, 'summary');
  assert.equal(result.summary?.body, '## Description');
  assert.equal(result.summary?.headRef, 'contributor:feature');
  assert.equal(result.summary?.mergeable, null);
  assert.equal(paths.length, 2);
});

test('activity combines paginated timeline and inline comments with original file locations', async () => {
  const result = await githubDetail({ request: async path => path.includes('/timeline?') ? Array.from({ length: 100 }, (_, id) => ({ id, event: 'commented', actor: { login: 'reviewer' }, created_at: '2026-10-01', body: 'comment' })) : [{ id: 8, user: { login: 'reviewer' }, created_at: '2026-10-02', body: 'line comment', path: 'src/a.ts', line: 4, diff_hunk: '@@ -1 +1 @@\n+new' }] }, repo, issue, 'activity');
  assert.equal(result.more, true);
  assert.equal(result.rows.length, 101);
  assert.equal(result.rows.at(-1)?.line, 4);
  assert.equal(result.rows.at(-1)?.kind, 'inline_comment');
});

test('files pin PR version and expose binary/missing patch coverage', async () => {
  const paths: string[] = [];
  const result = await githubDetail({ request: async path => { paths.push(path); return path.includes('/files?') ? [{ filename: 'asset.png', status: 'added', additions: 0, deletions: 0 }] : pr; } }, repo, issue, 'files');
  assert.equal(result.revision, pr.head.sha);
  assert.ok(result.warnings.some(value => value.includes('二进制')));
  assert.equal(paths.length, 3);
});

test('PR update during file read discards inconsistent results', async () => {
  let reads = 0;
  await assert.rejects(githubDetail({ request: async path => path.includes('/files?') ? [] : ++reads === 1 ? pr : { ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } } }, repo, issue, 'files'), /已更新/);
});

test('permission-denied checks remain unknown while commit statuses are still available', async () => {
  const result = await githubDetail({ request: async path => {
    if (path.includes('/check-runs?')) throw Error('GitHub 403');
    if (path.includes('/statuses?')) return [{ id: 1, context: 'ci', state: 'pending', description: null, created_at: '2026-10-01', target_url: null }];
    return pr;
  } }, repo, issue, 'checks');
  assert.ok(result.warnings.some(value => value.includes('状态未知')));
  assert.equal(result.rows[0].status, 'pending');
});

test('Issue rejects PR-only pages, local items do not contact GitHub, and discovery names route correctly', async () => {
  const never = { request: async () => { throw Error('must not request'); } };
  await assert.rejects(githubDetail(never, repo, { ...issue, type: 'issue' }, 'files'), /仅适用于/);
  await assert.rejects(githubDetail(never, { ...repo, mode: 'local' }, issue, 'activity'), /没有对应/);
  await assert.rejects(githubDetail(never, repo, { ...issue, origin: 'repository' }, 'summary'), /没有对应/);
  await assert.rejects(githubDetail(never, repo, issue, 'activity', 31), /页码/);
  const paths: string[] = [];
  await githubDetail({ request: async path => { paths.push(path); return source; } }, { ...repo, fullName: 'local:123', mode: 'local', githubName: 'other/public' }, { ...issue, type: 'issue' }, 'summary');
  assert.equal(paths[0], '/repos/other/public/issues/1');
});

test('detail HTTP route is read-only, validates pages and preserves access rejection', async () => {
  const calls: unknown[] = [];
  const workbench = { itemDetail: async (...args: unknown[]) => { calls.push(args); return { rows: [] }; } } as unknown as Workbench;
  const server = createServer(handler(workbench, req => req.headers['x-test-deny'] ? 403 : undefined));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}${API}/item-detail?id=${encodeURIComponent(issue.id)}&section=activity&page=2`;
    assert.equal((await fetch(url)).status, 200);
    assert.deepEqual(calls, [[issue.id, 'activity', 2]]);
    assert.equal((await fetch(url + '0')).status, 200);
    assert.equal((await fetch(url + '00')).status, 400);
    assert.equal((await fetch(url, { headers: { 'x-test-deny': 'yes' } })).status, 403);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
