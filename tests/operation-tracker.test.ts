import assert from 'node:assert/strict';
import test from 'node:test';
import { operationTaskIds } from '../src/client/OperationTracker.tsx';

test('operation tracker keeps only explicit created and reused task identifiers', () => {
  assert.deepEqual(operationTaskIds({ ids: ['new-1', 'same'], reused: ['same', 'reused-2'], errors: [{ id: 'issue-3', error: 'denied' }], at: '2026-10-03T00:00:00.000Z' }), ['new-1', 'same', 'reused-2']);
  assert.deepEqual(operationTaskIds(undefined), []);
});
