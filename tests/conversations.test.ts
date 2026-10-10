import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { conversationJobs, taskConversationCategory, taskConversationRecord } from '../src/core/conversations.ts';
import { organizeActions } from '../src/core/organize.ts';
import { categorySessionId, recordTaskConversations } from '../src/plugin/task-conversations.ts';
import { RepositoryOrganize } from '../src/client/RepositoryOrganize.tsx';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { seedFixture, fixtureRunner, fixtureAnalysis } from './support/fixtures.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { Job } from '../src/core/types.ts';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { revision } from '../src/core/revision.ts';
import { discoverWorkspace } from '../src/core/workspace-discovery.ts';

function fixture() {
  const store = new Store(':memory:'); seedFixture(store);
  const repo = store.repos()[0], issue = store.issues()[0];
  const job: Job = { id: 'first', repoId: repo.id, issueId: issue.id, issueSnapshot: { ...issue, type: 'pr' },
    kind: 'docs', status: 'completed', revision: 'one', baseSha: repo.headSha, attempt: 1,
    createdAt: '2026-10-01', updatedAt: '2026-10-01', result: fixtureAnalysis(issue, 'docs') };
  return { store, repo, job };
}

test('category directories from an older profile are not rediscovered as user repositories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mw-conversation-discovery-'));
  const store = new Store(join(dir, 'old-profile', 'workbench.sqlite'));
  try {
    const categoryRoot = join(dir, 'old-profile', 'conversations', 'repository');
    const currentProfile = join(dir, 'current-profile');
    await mkdir(categoryRoot, { recursive: true }); await mkdir(currentProfile);
    assert.equal(await discoverWorkspace(categoryRoot, currentProfile), undefined);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('categories combine PRs and attempts by repository and issue type, rather than execution stage', () => {
  const { store, repo, job } = fixture();
  try {
    const another = { ...job, id: 'second', kind: 'validate' as const, attempt: 2, createdAt: '2026-10-02',
      issueSnapshot: { ...job.issueSnapshot, number: 129 }, instructions: organizeActions.docs.instructions };
    assert.equal(taskConversationCategory(another), 'docs');
    assert.equal(taskConversationCategory({ ...job, kind: 'fix', issueSnapshot: { ...job.issueSnapshot, plan: { category: 'bug' } as any } }), 'bug');
    assert.equal(taskConversationCategory({ ...job, kind: 'investigate', issueSnapshot: { ...job.issueSnapshot, organizeMode: 'audit' } }), 'audit');
    assert.deepEqual(conversationJobs([{ ...another, repoId: 'other' }, another, job], repo.id, 'docs').map(item => item.id), ['first', 'second']);
    assert.notEqual(categorySessionId(repo.id, 'docs'), categorySessionId('other', 'docs'));
    assert.notEqual(categorySessionId(repo.id, 'docs'), categorySessionId(repo.id, 'bug'));
  } finally { store.close(); }
});

test('category records retain investigation decisions and actionable review evidence', () => {
  const { store, job } = fixture();
  const common = { schemaVersion: 1 as const, summary: 'Summary', coverage: 'Bounded source', evidence: [{ source: 'src/queue.ts:8', detail: 'Observed behavior' }], nextSteps: ['Confirm scope'], responseDraft: '' };
  try {
    const investigation = taskConversationRecord({ ...job, artifact: { ...common, stage: 'investigate', facts: ['Confirmed fact'], hypotheses: ['Unverified hypothesis'], reproduction: 'Reproduced input', rootCause: 'Cause', impact: 'Impact', proposedChanges: ['Minimal correction'], acceptanceCriteria: ['Required check'], blockers: ['Missing environment'] } });
    for (const value of ['Confirmed fact', 'Unverified hypothesis', 'Reproduced input', 'Minimal correction', 'Required check', 'Missing environment', 'Observed behavior']) assert.ok(investigation.includes(value), value);
    const review = taskConversationRecord({ ...job, artifact: { ...common, stage: 'review', verdict: 'changes_requested', blockers: [], findings: [{ id: 'finding', title: 'Queue order', severity: 'P1', path: 'src/queue.ts', line: 8, trigger: 'Parallel requests', evidence: 'Current source', recommendation: 'Preserve order' }] } });
    for (const value of ['changes_requested', 'src/queue.ts:8', 'Parallel requests', 'Current source', 'Preserve order']) assert.ok(review.includes(value), value);
  } finally { store.close(); }
});

test('repository page exposes category areas and selected history without mixing other categories or repos', async () => {
  const { store, repo, job } = fixture();
  const workbench = new Workbench(store, '/tmp/conversation-ui', fixtureRunner, undefined, false);
  try {
    store.put('jobs', { ...job, id: 'audit', kind: 'investigate', issueSnapshot: { ...job.issueSnapshot, origin: 'repository', organizeMode: 'audit', title: '结构检查' }, result: { ...job.result!, summary: '保存的结构检查结论' } });
    store.put('jobs', { ...job, result: { ...job.result!, summary: '不属于结构检查的文档记录' } });
    store.put('jobs', { ...job, id: 'foreign', repoId: 'foreign', issueSnapshot: { ...job.issueSnapshot, organizeMode: 'audit' }, result: { ...job.result!, summary: '其他仓库记录' } });
    const html = renderToStaticMarkup(React.createElement(RepositoryOrganize, { state: workbench.snapshot(), repoId: repo.id, busy: false, run: async () => {}, open: () => {} }));
    assert.match(html, /仓库主区/); assert.match(html, /问题类别子区/); assert.match(html, /保存的结构检查结论/);
    assert.doesNotMatch(html, /不属于结构检查的文档记录|其他仓库记录/);
  } finally { await workbench.close(); }
});

test('document validation and subsequent review retain the source category even for a bug PR', async () => {
  const { store, repo, job } = fixture();
  const workbench = new Workbench(store, '/tmp/conversation-chain', fixtureRunner, undefined, false);
  try {
    const issue = { ...job.issueSnapshot, analysis: { ...job.result!, category: 'bug' as const } };
    store.put('issues', issue);
    store.put('jobs', { ...job, issueSnapshot: issue, revision: revision(issue, repo, 'docs') });
    const validationId = workbench.enqueue([issue.id], 'validate', { sourceJobId: job.id }).created[0];
    const validation = store.get<Job>('jobs', validationId)!;
    assert.equal(validation.conversationCategory, 'docs');
    store.put('jobs', { ...validation, status: 'completed', result: job.result });
    const reviewId = workbench.enqueue([issue.id], 'review', { sourceJobId: validationId }).created[0];
    assert.equal(taskConversationCategory(store.get<Job>('jobs', reviewId)!), 'docs');
  } finally { await workbench.close(); }
});

test('native category logs reuse one session across PRs, retries and restart; no model turns are dispatched', async () => {
  const { store, repo, job } = fixture();
  const persisted = new Map<string, any>(); const workspaces = new Map<string, any>();
  const created: string[] = [], resumed: string[] = []; let flushes = 0;
  const dir = await mkdtemp(join(tmpdir(), 'mw-conversations-'));
  const makeHandle = (id: string, cwd: string, events: any[] = []) => {
    // Enforce the real message append contract; the service fixture below owns persistence replay.
    const native = Session.create(SessionId(id), undefined, { id: SessionId(id), version: SESSION_FORMAT_VERSION, isSeeded: false, cwd, createdAt: 0 });
    const session = { id, header: native.header, events: [...events], append: (type: any, data: any, options: any) => {
      const event = native.append(type, data, options); session.events.push(event); return event;
    } };
    return { agent: { session }, dispose: async () => {} };
  };
  const services = {
    sessions: { flush: async (session: any) => { flushes++; persisted.set(session.id, { header: session.header, events: [...session.events] }); } },
  };
  const ctx = {
    get: (key: string) => services[key as keyof typeof services],
    sessionPersistence: { stat: async (id: string) => persisted.get(id), open: async (id: string) => ({ read: async () => ({ events: persisted.get(id).events }), close: async () => {} }) },
    workspaceRegistry: { create: async (path: string, title: string) => {
      if (!workspaces.has(path)) workspaces.set(path, { path, title, ids: new Set(), attachSession: async (id: string) => workspaces.get(path).ids.add(id) });
      return workspaces.get(path);
    } },
    agents: {
      create: async (options: any) => { created.push(options.sessionId); return makeHandle(options.sessionId, options.meta.cwd); },
      resume: async (options: any) => { resumed.push(options.resumeSessionId); const data = persisted.get(options.resumeSessionId); return makeHandle(options.resumeSessionId, data.header.cwd, data.events); },
    },
    sessionTitle: { rename: () => {} },
  } as unknown as Context;
  try {
    const second = { ...job, id: 'second', issueSnapshot: { ...job.issueSnapshot, number: 130 } };
    await recordTaskConversations(ctx, [job, second], [repo], dir);
    assert.equal(created.length, 1); assert.equal(workspaces.size, 1); assert.equal(persisted.values().next().value.events.length, 2);
    await recordTaskConversations(ctx, [job, second], [repo], dir);
    assert.equal(flushes, 1);
    const retry = { ...job, id: 'retry', attempt: 2 };
    await recordTaskConversations(ctx, [job, second, retry], [repo], dir);
    assert.equal(created.length, 1); assert.equal(resumed.length, 1); assert.equal(workspaces.size, 1);
    assert.equal(persisted.values().next().value.events.length, 3);
    assert.match(taskConversationRecord(retry), /第 2 次/);
    const otherRepo = { ...repo, id: 'another-repository', localPath: '' };
    await recordTaskConversations(ctx, [{ ...job, id: 'foreign', repoId: otherRepo.id }], [otherRepo], dir);
    assert.equal(created.length, 2); assert.equal(workspaces.size, 2);
    await recordTaskConversations(ctx, [{ ...job, id: 'still-running', status: 'running' }], [repo], dir);
    assert.equal(created.length, 2);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
