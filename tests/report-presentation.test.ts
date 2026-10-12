import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.ts';
import { seedFixture } from './support/fixtures.ts';
import { reportPresentation } from '../src/client/report-presentation.ts';
import { reportFailureMessage } from '../src/core/report-state.ts';
import { projectTimeline } from '../src/workflow/timeline.ts';
import { availableActions } from '../src/workflow/actions.ts';
import type { Job } from '../src/core/types.ts';

function fixture() {
  const store = new Store(':memory:'); seedFixture(store);
  const issue = store.issues()[0], state = store.processing.current(issue.id)!; store.close();
  const run: Job = { id: 'failed-report', kind: 'triage', status: 'failed', issueId: issue.id, repoId: issue.repoId, caseId: state.id, revision: 'r', baseSha: '', issueSnapshot: issue, attempt: 3, createdAt: issue.updatedAt, updatedAt: issue.updatedAt, rawOutput: '{}', formatRecovery: { baseSha: '', patchHash: 'hash' } };
  return { run, timeline: projectTimeline(issue, { ...state, currentRunId: run.id }, [run], [], availableActions(issue, run, [run])) };
}

test('legacy timeline wording follows the same report run as its action without changing eligibility', () => {
  const { run, timeline } = fixture();
  timeline.nodes[0].result = '执行失败'; timeline.actions!.controls![0].label = '重试任务'; timeline.actions!.controls![0].enabled = false; timeline.actions!.controls![0].blockedReasons = ['事项已暂缓'];
  const original = JSON.stringify(timeline), view = reportPresentation(timeline, [run]);
  assert.equal(view.nodes[0].result, '报告待整理');
  assert.deepEqual(view.actions!.controls![0], { ...timeline.actions!.controls![0], label: '重新整理报告' });
  assert.equal(JSON.stringify(timeline), original);
  const executionFailure = reportPresentation(timeline, [{ ...run, formatRecovery: undefined }]);
  assert.equal(executionFailure.nodes[0].result, '执行失败'); assert.equal(executionFailure.actions!.controls![0].label, '重试任务');
  for (const status of ['manual', 'skipped', 'stale', 'waiting'] as const) {
    const protectedView = { ...timeline, historical: true, nodes: [{ ...timeline.nodes[0], status, result: 'existing disposition' }] };
    assert.equal(reportPresentation(protectedView, [run]).nodes[0].result, 'existing disposition');
  }
});

test('legacy schema dumps receive readable summaries while the stored diagnostic remains intact', () => {
  const { run } = fixture();
  const error = '结果整理仍失败，已保留原始输出： ' + JSON.stringify([{ code: 'too_small', path: ['inputRequest', 'fields'], minimum: 1, type: 'array' }]);
  const failed = { ...run, error };
  assert.equal(reportFailureMessage(failed), '报告包含空的补充信息请求，请重新整理报告。'); assert.equal(failed.error, error);
  assert.equal(reportFailureMessage({ ...failed, formatRecovery: undefined }), error);
  assert.equal(reportFailureMessage({ ...failed, error: 'network failed [not JSON]' }), 'network failed [not JSON]');
});
