import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../src/core/store.ts';
import { Workbench, revision } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { seedFixture, fixtureRunner, fixtureAnalysis } from './support/fixtures.ts';
import type { FindingFollowup, Issue, IssuePlan, Job, ReviewThread, ThreadSnapshot } from '../src/core/types.ts';
import { defaultPlan, nextIssueStage, planBlocker, receiveReplies } from '../src/core/issue-flow.ts';
import { reviewFollowups } from '../src/core/finding-followup.ts';
import { executionRecord, saveExecutionLog, readExecutionLog } from '../src/core/execution-evidence.ts';
import { linkedExecution, reconcileTestExecutions } from '../src/core/execution-links.ts';
import { IssuePlanning } from '../src/client/IssuePlanning.tsx';
import { ReviewFindingControls } from '../src/client/ReviewFindingControls.tsx';
import { TestExecutionLink } from '../src/client/ExecutionEvidence.tsx';
import { artifactSchemas } from '../src/core/artifacts.ts';

function setup(github = new GitHub('', async () => { throw new Error('unexpected external request'); })) {
  const store = new Store(':memory:'); seedFixture(store);
  const workbench = new Workbench(store, '/tmp/maintainer-improvement-unit', fixtureRunner, github, false);
  return { store, workbench, issue: store.issues()[0], repo: store.repos()[0] };
}
const common = { schemaVersion: 1 as const, summary: 'review', coverage: 'fixture', evidence: [], nextSteps: [], responseDraft: '', stage: 'review' as const, verdict: 'no_findings' as const, blockers: [] };
const finding = { id: 'f1', title: 'incorrect sum', severity: 'P1' as const, path: 'sum.ts', line: 1, trigger: 'sum', evidence: 'fails', recommendation: 'correct' };
function reviewJob(issue: Issue, repo: ReturnType<typeof setup>['repo'], id: string): Job {
  return { id, issueId: issue.id, repoId: repo.id, kind: 'review', status: 'awaiting_review', baseSha: repo.headSha, revision: revision(issue, repo, 'review'), issueSnapshot: issue, attempt: 1, createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z', result: fixtureAnalysis(issue, 'review'), artifact: { ...common, findings: [finding] } };
}

test('information requests deduplicate, preserve history and require explicit completion before redispatch', async () => {
  const { store, workbench, issue } = setup();
  try {
    const first = workbench.askInformation(issue.id, ['  version? ', 'steps?'], issue.author);
    const duplicate = workbench.askInformation(issue.id, ['steps?', 'version?'], issue.author);
    assert.equal(duplicate.id, first.id); assert.equal(duplicate.reused, true);
    assert.equal(store.issues()[0].informationRequests?.length, 1);
    assert.throws(() => workbench.enqueue([issue.id], 'triage'), /尚未收到/);
    workbench.finishInformation(issue.id, first.id, 'fulfilled');
    assert.equal(store.issues()[0].informationRequests?.[0].state, 'fulfilled');
    assert.ok(workbench.enqueue([issue.id], 'triage').created.length);
  } finally { await workbench.close(); }
});

test('reply matching ignores earlier and other-author comments, deduplicates and never declares sufficiency', () => {
  const request = { id: 'q', questions: ['version'], waitingFor: 'reporter', state: 'asked' as const, askedAt: '2026-10-04T00:00:00Z', baselineComments: 0, source: 'maintainer_record' as const, replies: [] };
  const row = { id: 3, author: 'Reporter', createdAt: '2026-10-04T01:00:00Z', url: 'https://github.com/fixture/queue/issues/1#comment', body: 'v2' };
  const result = receiveReplies(request, [{ ...row, id: 1, createdAt: '2026-10-03T00:00:00Z' }, { ...row, id: 2, author: 'other' }, row], false);
  assert.equal(result.state, 'reply_received'); assert.deepEqual(result.replies, [row]);
  assert.equal(receiveReplies(result, [row], false).replies.length, 1);
  assert.match(receiveReplies(result, [], true).warning!, /100/);
});

test('sync keeps plans and asked questions across versions, signals fresh replies, and recovers read errors', async () => {
  const github = new GitHub('', async () => { throw Error('unexpected'); });
  const { store, workbench, issue, repo } = setup(github);
  let fail = true;
  github.sync = async () => ({ repo, issues: [{ ...issue, comments: 1, updatedAt: '2026-10-04T01:00:00Z' }] });
  github.informationReplies = async () => { if (fail) throw Error('permission denied'); return { replies: [{ id: 3, author: issue.author, createdAt: new Date(Date.now() + 1000).toISOString(), url: 'https://github.com/fixture/queue/issues/128#comment', body: 'steps' }], partial: false }; };
  try {
    workbench.savePlan(issue.id, { ...defaultPlan(issue), goal: 'fix', decision: 'proposed' });
    const { id } = workbench.askInformation(issue.id, ['steps?'], issue.author);
    await workbench.sync(repo.fullName);
    assert.equal(store.issues()[0].plan?.goal, 'fix');
    assert.match(store.issues()[0].informationRequests?.[0].warning!, /permission/);
    assert.equal(store.issues()[0].informationRequests?.[0].state, 'asked');
    fail = false; await workbench.sync(repo.fullName);
    assert.equal(store.issues()[0].informationRequests?.[0].id, id);
    assert.equal(store.issues()[0].informationRequests?.[0].state, 'reply_received');
    assert.equal(store.issues()[0].workflow?.stage, 'decision');
    assert.equal(nextIssueStage(store.issues()[0]), 'triage');
  } finally { await workbench.close(); }
});

test('type-specific acceptance enforces feature decisions and reproduction; docs and questions have short paths', async () => {
  const { store, workbench, issue, repo } = setup();
  const plan: IssuePlan = { ...defaultPlan(issue), category: 'feature', goal: 'sync offline', scope: 'only sync', acceptanceCriteria: ['offline queue'], decision: 'proposed' };
  try {
    workbench.savePlan(issue.id, plan);
    assert.throws(() => workbench.enqueue([issue.id], 'fix'), /接受/);
    const accepted = { ...plan, decision: 'accepted' as const }; workbench.savePlan(issue.id, accepted);
    assert.equal(planBlocker(store.issues()[0], 'fix'), undefined);
    assert.equal(nextIssueStage(store.issues()[0]), 'fix');
    assert.notEqual(revision(issue, repo), revision(store.issues()[0], repo));
    assert.match(planBlocker({ ...issue, plan: { ...accepted, category: 'bug' } }, 'fix')!, /复现/);
    const doc = { ...issue, plan: { ...accepted, category: 'docs' as const } };
    assert.equal(nextIssueStage(doc), 'docs'); assert.match(planBlocker(doc, 'fix')!, /文档/);
    workbench.savePlan(issue.id, { ...accepted, category: 'question' });
    assert.throws(() => workbench.enqueue([issue.id], 'fix'), /使用提问/);
    workbench.decide(issue.id, 'answered', 'Answered with documentation link');
    assert.equal(store.issues()[0].state, 'open'); assert.equal(nextIssueStage(store.issues()[0]), undefined);
  } finally { await workbench.close(); }
});

test('new review follows exact historical IDs and leaves omitted findings unverified', () => {
  const { store, issue, repo } = setup();
  try {
    const previous = reviewJob(issue, repo, 'previous'); const next = reviewJob(issue, repo, 'next');
    next.handoff = [{ id: previous.id, kind: 'review', revision: previous.revision, artifact: previous.artifact }];
    assert.equal(reviewFollowups(next)[0].status, 'unverified');
    const resolved: FindingFollowup = { sourceJobId: 'previous', findingId: 'f1', status: 'resolved', evidence: 'new head reproducer passes' };
    assert.deepEqual(reviewFollowups(next, [resolved]), [resolved]);
    assert.throws(() => reviewFollowups(next, [{ ...resolved, sourceJobId: 'other' }]), /引用/);
    assert.throws(() => reviewFollowups(next, [resolved, resolved]), /重复/);
  } finally { store.close(); }
});

test('bulk finding decisions are atomic; followup changes revoke local acceptance and reject foreign sources', async () => {
  const { store, workbench, issue, repo } = setup();
  try {
    const previous = reviewJob(issue, repo, 'previous'), current = reviewJob(issue, repo, 'current');
    current.handoff = [{ id: previous.id, kind: 'review', revision: previous.revision, artifact: previous.artifact }];
    store.put('jobs', previous); store.put('jobs', current);
    assert.throws(() => workbench.findings(current.id, ['f1','unknown'], 'resolved'), /不存在/);
    assert.equal(store.jobs()[1].findingDecisions, undefined);
    workbench.findings(current.id, ['f1'], 'accepted'); assert.equal(store.jobs()[1].findingDecisions?.f1, 'accepted');
    store.put('jobs', { ...store.jobs()[1], status: 'approved' });
    workbench.followup(current.id, { sourceJobId: previous.id, findingId: 'f1', status: 'still_present', evidence: 'still fails at current version' });
    assert.equal(store.jobs()[1].status, 'awaiting_review');
    assert.throws(() => workbench.followup(current.id, { sourceJobId: 'foreign', findingId: 'f1', status: 'resolved', evidence: 'invented' }), /引用/);
  } finally { await workbench.close(); }
});

test('thread preview binds exact PR membership/version/state; changed version or finding decisions cause zero writes', async () => {
  const github = new GitHub('', async () => { throw Error('unexpected'); });
  const { store, workbench, repo } = setup(github);
  const issue = { ...store.issues()[0], type: 'pr' as const, headSha: 'b'.repeat(40), prBaseSha: 'a'.repeat(40) }; store.put('issues', issue);
  const current = reviewJob(issue, repo, 'current');
  current.prContext = { headSha: issue.headSha, baseSha: issue.prBaseSha, headRef: 'feature', baseRef: 'main', headRepo: repo.fullName, draft: false, merged: false, mergeable: true, checks: [], reviews: [], warnings: [] };
  store.put('jobs', current);
  const thread: ReviewThread = { id: 'thread-1', path: 'sum.ts', line: 1, isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: true, url: 'https://github.com/fixture/queue/pull/128#thread', body: 'fix sum' };
  let snapshot: ThreadSnapshot = { headSha: issue.headSha, baseSha: issue.prBaseSha, threads: [thread], partial: false, syncedAt: '' }, writes = 0;
  github.threads = async () => structuredClone(snapshot);
  github.setThreadResolved = async (id, resolved) => { assert.equal(id, thread.id); writes++; snapshot.threads[0].isResolved = resolved; };
  try {
    const preview = await workbench.previewThread(current.id, thread.id, true); assert.equal(writes, 0);
    await assert.rejects(workbench.previewThread(current.id, 'foreign', true), /不属于/);
    snapshot.headSha = 'c'.repeat(40); await assert.rejects(workbench.updateThread(current.id, thread.id, true, preview.stamp), /版本/); assert.equal(writes, 0);
    snapshot.headSha = issue.headSha;
    workbench.findings(current.id, ['f1'], 'resolved');
    await assert.rejects(workbench.updateThread(current.id, thread.id, true, preview.stamp), /变化/); assert.equal(writes, 0);
    const next = await workbench.previewThread(current.id, thread.id, true); await workbench.updateThread(current.id, thread.id, true, next.stamp); assert.equal(writes, 1);
    const confirmed = await workbench.previewThread(current.id, thread.id, true); await workbench.updateThread(current.id, thread.id, true, confirmed.stamp); assert.equal(writes, 1);
  } finally { await workbench.close(); }
});

test('GraphQL errors never become an empty successful thread snapshot', async () => {
  const { store, repo } = setup();
  try {
    const github = new GitHub('test-placeholder', async () => Response.json({ errors: [{ message: 'permission denied' }] }));
    await assert.rejects(github.threads(repo, 128), /permission/);
  } finally { store.close(); }
});

test('execution evidence records host exit values, rejects stdout spoofing and prevents ambiguous/wrong-patch links', async () => {
  const { store, issue, repo } = setup();
  try {
    const job = reviewJob(issue, repo, 'job');
    const record = executionRecord(job, 'session', 3, { name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) }, { message: { toolCallId: 'call', content: [{ type: 'text', text: '[exit code: 0]' }] }, meta: { exitCode: 1, stdout: { text: 'failed', truncated: false }, stderr: { text: '' } } }, 'patch');
    assert.equal(record.exitCode, 1); job.patchSha256 = 'patch'; job.executionRecords = [record];
    assert.equal(linkedExecution(job, { command: 'npm test' })?.id, record.id);
    const validation = artifactSchemas.validate.parse({ ...common, stage: 'validate', environment: 'fixture', tests: [{ command: 'npm test', status: 'passed', output: 'claimed pass' }] });
    const reconciled = reconcileTestExecutions(validation, job); assert.ok('tests' in reconciled); assert.equal(reconciled.tests[0].status, 'failed'); assert.equal(reconciled.tests[0].executionId, record.id);
    assert.equal(executionRecord(job, 'session', 4, undefined, { message: { content: [{ text: '[exit code: 0]' }] } }).exitCode, null);
    job.executionRecords.push({ ...record, id: 'another', exitCode: 0 }); assert.equal(linkedExecution(job, { command: 'npm test' }), undefined);
    assert.equal(linkedExecution(job, { command: 'npm test', executionId: record.id })?.exitCode, 1);
    job.patchSha256 = 'other'; assert.equal(linkedExecution(job, { command: 'npm test', executionId: record.id }), undefined);
    const dir = await mkdtemp(join(tmpdir(), 'maintainer-execution-')); saveExecutionLog(dir, job.id, record.id, 'original event');
    assert.equal(readExecutionLog(dir, job, record.id).raw, 'original event');
    assert.throws(() => readExecutionLog(dir, job, '../../secrets'), /没有此/);
  } finally { store.close(); }
});

test('UI displays type fields, waiting identities, unverified followups and actual test evidence', () => {
  const { store, issue, repo } = setup(); const act = async () => undefined;
  try {
    const plan = renderToStaticMarkup(React.createElement(IssuePlanning, { issue: { ...issue, plan: defaultPlan(issue) }, busy: false, act }));
    assert.match(plan, /复现条件与步骤/); assert.match(plan, /等待回复的 GitHub 用户名/);
    const job = reviewJob(issue, repo, 'new'); job.findingFollowups = [{ sourceJobId: 'old', findingId: 'f1', status: 'unverified', evidence: 'missing reproduction' }];
    assert.match(renderToStaticMarkup(React.createElement(ReviewFindingControls, { job, history: [], busy: false, act })), /无法验证/);
    job.executionRecords = [executionRecord(job, 'session', 2, { name: 'bash', arguments: '{"command":"npm test"}' }, { meta: { exitCode: 1 }, message: { toolCallId: 'c' } })];
    const output = renderToStaticMarkup(React.createElement(TestExecutionLink, { job, test: { command: 'npm test', status: 'passed' } }));
    assert.match(output, /报告声称通过/); assert.match(output, /原始工具日志/);
    assert.equal(artifactSchemas.review.parse({ ...common, findings: [] }).followups, undefined);
  } finally { store.close(); }
});
