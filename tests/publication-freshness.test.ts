import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { fixtureAnalysis, seedFixture } from './support/fixtures.ts';
import type { Job } from '../src/core/types.ts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'node:http';
import { handler, localRejection } from '../src/server/http.ts';
import { PublicationConfirm, publicationPreviewCurrent } from '../src/client/PublicationConfirm.tsx';

async function setup(t: TestContext, kind: Job['kind'] = 'investigate') {
  const store = new Store(':memory:'); seedFixture(store);
  const repo = store.repos()[0], issue = { ...store.issues()[0], url: 'https://github.com/fixture/queue/issues/128' };
  store.put('issues', issue);
  let remoteSha = repo.headSha, remoteUpdatedAt = issue.updatedAt, posts = 0, postedBody = '', loseResponse = false;
  const reads: string[] = [];
  let afterComments: (() => void) | undefined;
  const github = new GitHub('fixture', async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') { posts++; postedBody = JSON.parse(String(init.body)).body; if (loseResponse) { loseResponse = false; throw Error('lost response'); } return Response.json({ html_url: issue.url + '#fixture-comment' }); }
    reads.push(url);
    if (url.includes('/commits/')) return Response.json({ sha: remoteSha });
    if (url.includes('/comments?')) { afterComments?.(); return Response.json(postedBody ? [{ body: postedBody, html_url: issue.url + '#fixture-comment' }] : []); }
    if (url.endsWith(`/issues/${issue.number}`)) return Response.json({ updated_at: remoteUpdatedAt });
    throw Error('Unexpected fixture request: ' + url);
  });
  const workbench = new Workbench(store, '/tmp/maintainer-publication-fixture', undefined, github, false);
  const id = workbench.enqueue([issue.id], kind).created[0];
  store.put('jobs', { ...store.get<Job>('jobs', id)!, status: 'completed', result: fixtureAnalysis(issue, kind) });
  await workbench.review(id, 'approve', 'Approve only the saved report');
  const token = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'fixture';
  t.after(async () => { await workbench.close(); if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token; });
  return { store, workbench, id, repo, issue, reads, loseNextResponse: () => { loseResponse = true; }, clearPublishedMarker: () => { postedBody = ''; }, posts: () => posts, setRemoteSha: (sha: string) => { remoteSha = sha; }, setRemoteIssue: (updatedAt: string) => { remoteUpdatedAt = updatedAt; }, afterComments: (callback: () => void) => { afterComments = callback; } };
}

test('an approved unbound investigation cannot publish after synced repository HEAD changes', async t => {
  const f = await setup(t);
  f.store.put('repos', { ...f.repo, headSha: 'b'.repeat(40) });
  assert.equal(f.workbench.snapshot().jobs.find(job => job.id === f.id)?.artifactState, 'stale');
  await assert.rejects(f.workbench.publish(f.id, 'comment'), /输入.*变化|代码基线.*变化/);
  assert.equal(f.posts(), 0);
});

test('an approved unbound investigation cannot publish after an unsynced remote HEAD change', async t => {
  const f = await setup(t); f.setRemoteSha('b'.repeat(40));
  await assert.rejects(f.workbench.publish(f.id, 'comment'), /代码基线.*变化/);
  assert.equal(f.posts(), 0);
});

test('a final comment-list await cannot publish through a concurrent local input update', async t => {
  const f = await setup(t);
  f.afterComments(() => f.store.put('issues', { ...f.issue, title: 'Changed during publication' }));
  await assert.rejects(f.workbench.publish(f.id, 'comment'), /输入.*变化/);
  assert.equal(f.posts(), 0);
});

test('a remote HEAD change during comment lookup is caught before the new POST', async t => {
  const f = await setup(t); f.afterComments(() => f.setRemoteSha('c'.repeat(40)));
  await assert.rejects(f.workbench.publish(f.id, 'comment'), /代码基线.*变化/);
  assert.equal(f.posts(), 0);
});

test('preview validates repository and issue inputs read-only, and confirmation checks again', async t => {
  const f = await setup(t);
  const saved = JSON.stringify(f.store.jobs());
  const preview = await f.workbench.previewPublish(f.id, 'comment');
  assert.equal(preview.id, f.id); assert.equal(preview.stamp.length, 64);
  assert.ok(f.reads.some(url => url.includes('/commits/')));
  assert.ok(f.reads.some(url => url.endsWith(`/issues/${f.issue.number}`)));
  assert.equal(JSON.stringify(f.store.jobs()), saved); assert.equal(f.posts(), 0);
  f.setRemoteSha('d'.repeat(40));
  await assert.rejects(f.workbench.publish(f.id, 'comment', preview.stamp), /代码基线.*变化/);
  await assert.rejects(f.workbench.previewPublish(f.id, 'comment'), /代码基线.*变化/);
  assert.equal(f.posts(), 0);
});

for (const change of ['synced-head', 'local-issue', 'remote-issue'] as const) test(`preview refuses ${change} drift`, async t => {
  const f = await setup(t);
  if (change === 'synced-head') f.store.put('repos', { ...f.repo, headSha: 'e'.repeat(40) });
  if (change === 'local-issue') f.store.put('issues', { ...f.issue, body: 'new evidence' });
  if (change === 'remote-issue') f.setRemoteIssue('2026-10-04T00:00:00Z');
  await assert.rejects(f.workbench.previewPublish(f.id, 'comment'), /变化|已更新/);
  assert.equal(f.posts(), 0);
});

test('confirmation refuses approved content changed since the explicit preview', async t => {
  const f = await setup(t), preview = await f.workbench.previewPublish(f.id, 'comment');
  const job = f.store.get<Job>('jobs', f.id)!;
  f.store.put('jobs', { ...job, result: { ...job.result!, responseDraft: 'Not the text the maintainer previewed' } });
  await assert.rejects(f.workbench.publish(f.id, 'comment', preview.stamp), /预览已失效/);
  assert.equal(f.posts(), 0);
});

test('valid confirmation posts once; an already-published receipt remains a read-only retry', async t => {
  const f = await setup(t), preview = await f.workbench.previewPublish(f.id, 'comment');
  const urls = await f.workbench.publish(f.id, 'comment', preview.stamp);
  assert.equal(f.posts(), 1); assert.deepEqual(urls, [f.issue.url + '#fixture-comment']);
  const reads = f.reads.length;
  f.store.put('repos', { ...f.repo, headSha: 'f'.repeat(40) });
  assert.deepEqual(await f.workbench.publish(f.id, 'comment', preview.stamp), urls);
  assert.equal(f.posts(), 1); assert.equal(f.reads.length, reads);
});

test('a lost comment response can reconcile read-only after sync makes its source stale', async t => {
  const f = await setup(t); f.loseNextResponse();
  await assert.rejects(f.workbench.publish(f.id, 'comment'), /写入结果尚未确认/);
  f.setRemoteIssue('2026-10-05T00:00:00Z');
  f.store.put('issues', { ...f.issue, updatedAt: '2026-10-05T00:00:00Z' });
  f.store.put('repos', { ...f.repo, headSha: 'e'.repeat(40) }); f.setRemoteSha('e'.repeat(40));
  const jobs = JSON.stringify(f.store.jobs());
  const preview = await f.workbench.previewPublish(f.id, 'comment');
  assert.deepEqual(preview.alreadyPublished, [f.issue.url + '#fixture-comment']);
  assert.equal(JSON.stringify(f.store.jobs()), jobs, 'Receipt lookup preview remains read-only');
  const stale = f.workbench.snapshot().jobs.find(job => job.id === f.id)!;
  assert.equal(stale.artifactState, 'stale'); assert.equal(publicationPreviewCurrent(preview, stale), true);
  assert.match(renderToStaticMarkup(React.createElement(PublicationConfirm, { preview, job: stale, busy: false, confirm: () => {} })), /确认只核对并保存回执，不重复发布/);
  const result = await f.workbench.publish(f.id, 'comment', preview.stamp);
  assert.deepEqual(result, preview.alreadyPublished); assert.equal(f.posts(), 1);
  assert.equal(f.store.get<Job>('jobs', f.id)?.publications?.comment?.status, 'published');
});

test('a disappeared recovery marker never permits a fresh POST with stale inputs', async t => {
  const f = await setup(t); f.loseNextResponse();
  await assert.rejects(f.workbench.publish(f.id, 'comment'), /写入结果尚未确认/);
  f.store.put('issues', { ...f.issue, updatedAt: '2026-10-05T00:00:00Z' });
  const preview = await f.workbench.previewPublish(f.id, 'comment');
  f.clearPublishedMarker();
  await assert.rejects(f.workbench.publish(f.id, 'comment', preview.stamp), /发布记录已不存在/);
  assert.equal(f.posts(), 1);
});

test('receipt-only preview cannot become a new send when its marker disappears but inputs remain current', async t => {
  const f = await setup(t); f.loseNextResponse();
  await assert.rejects(f.workbench.publish(f.id, 'comment'), /写入结果尚未确认/);
  const preview = await f.workbench.previewPublish(f.id, 'comment');
  assert.ok(preview.alreadyPublished?.length); f.clearPublishedMarker();
  await assert.rejects(f.workbench.publish(f.id, 'comment', preview.stamp), /仅核对回执，不会重新发送/);
  assert.equal(f.posts(), 1);
});

test('publication preview is bound to its chosen action as well as its content', async t => {
  const f = await setup(t), preview = await f.workbench.previewPublish(f.id, 'comment');
  await assert.rejects(f.workbench.publish(f.id, 'labels', preview.stamp), /预览已失效/);
  assert.equal(f.posts(), 0);
});

test('metadata-only Issue triage remains independent of unrelated repository HEAD changes', async t => {
  const f = await setup(t, 'triage');
  f.store.put('repos', { ...f.repo, headSha: 'f'.repeat(40) }); f.setRemoteSha('f'.repeat(40));
  const preview = await f.workbench.previewPublish(f.id, 'comment');
  await f.workbench.publish(f.id, 'comment', preview.stamp);
  assert.equal(f.posts(), 1); assert.ok(!f.reads.some(url => url.includes('/commits/')));
});

test('stale, revoked, changed or mismatched open previews disable and guard the confirmation callback', async t => {
  const f = await setup(t), preview = await f.workbench.previewPublish(f.id, 'comment');
  const original = f.workbench.snapshot().jobs.find(job => job.id === f.id)!;
  let confirmed = 0;
  for (const job of [undefined, { ...original, artifactState: 'stale' }, { ...original, status: 'rejected' as const }, { ...original, revision: 'other' }, { ...original, updatedAt: 'later' }, { ...original, id: 'other' }]) {
    assert.equal(publicationPreviewCurrent(preview, job), false);
    const element = PublicationConfirm({ preview, job, busy: false, confirm: () => confirmed++ });
    assert.match(renderToStaticMarkup(element), /预览已失效/);
    assert.match(renderToStaticMarkup(element), /disabled=""/);
    const button = element.props.children[2]; button.props.onClick();
  }
  assert.equal(confirmed, 0);
  const valid = PublicationConfirm({ preview, job: original, busy: false, confirm: () => confirmed++ });
  valid.props.children[2].props.onClick(); assert.equal(confirmed, 1);
});

test('HTTP preview is read-only and a changed input cannot be confirmed through the publish endpoint', async t => {
  const f = await setup(t), server = createServer(handler(f.workbench, localRejection));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/maintainer/api`;
  const post = (path: string, data: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const response = await post('/publish/preview', { id: f.id, action: 'comment' });
  assert.equal(response.status, 200); const preview = await response.json(); assert.equal(f.posts(), 0);
  f.store.put('repos', { ...f.repo, headSha: 'a'.repeat(40) + 'changed' });
  const rejected = await post('/publish', { id: f.id, action: 'comment', previewStamp: preview.stamp });
  assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /预览已失效/); assert.equal(f.posts(), 0);
});

test('edited item reply is previewed and draft changes invalidate confirmation',async t=>{
 const f=await setup(t);f.store.saveDraft(f.issue.id,{reply:'Maintainer edited reply'});
 const preview=await f.workbench.previewPublish(f.id,'comment');assert.equal('responseDraft' in preview ? preview.responseDraft:undefined,'Maintainer edited reply');assert.equal(f.posts(),0);
 f.store.saveDraft(f.issue.id,{reply:'Changed after preview'});
 await assert.rejects(f.workbench.publish(f.id,'comment',preview.stamp),/预览已失效/);assert.equal(f.posts(),0);
 const fresh=await f.workbench.previewPublish(f.id,'comment');await f.workbench.publish(f.id,'comment',fresh.stamp);assert.equal(f.posts(),1);
});
test('reply edits during the final read cannot reach an external write',async t=>{
 const f=await setup(t);f.store.saveDraft(f.issue.id,{reply:'First reply'});const preview=await f.workbench.previewPublish(f.id,'comment');
 f.afterComments(()=>f.store.saveDraft(f.issue.id,{reply:'Concurrent reply'}));
 await assert.rejects(f.workbench.publish(f.id,'comment',preview.stamp),/内容已变化/);assert.equal(f.posts(),0);
});
