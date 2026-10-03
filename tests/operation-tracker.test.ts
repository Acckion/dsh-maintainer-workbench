import assert from 'node:assert/strict';
import test from 'node:test';
import { operationTaskIds } from '../src/client/OperationTracker.tsx';
import { operationFailureRecord, operationRecordFromResponse, pageSearchKey, restoreInboxContext, reviewNoteForTask } from '../src/client/operation-state.ts';

test('operation tracker keeps only explicit created and reused task identifiers', () => {
  assert.deepEqual(operationTaskIds({ ids: ['new-1', 'same'], reused: ['same', 'reused-2'], errors: [{ id: 'issue-3', error: 'denied' }], at: '2026-10-03T00:00:00.000Z' }), ['new-1', 'same', 'reused-2']);
  assert.deepEqual(operationTaskIds(undefined), []);
});

test('operation state preserves real responses, cautious failures, scoped search and return origin', () => {
  assert.deepEqual(operationRecordFromResponse({ created: ['retry-2'], reused: ['retry-1'], errors: [] }, 'now').ids, ['retry-2']);
  assert.match(operationFailureRecord(['issue-1'], new Error('timeout'), 'now').errors[0].error, /未确认是否已创建/);
  assert.equal(pageSearchKey('repo-a', 'inbox'), 'repo-a:inbox');
  assert.equal(restoreInboxContext({ repoId: 'repo-a', scrollTop: 40, focused: 'i1' }, 'repo-b'), undefined);
  assert.equal(reviewNoteForTask('a', 'b', 'old approval note'), '');
});
