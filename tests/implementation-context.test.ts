import test from 'node:test';
import assert from 'node:assert/strict';
import { needsImplementationCompletion, implementationPromptHandoff } from '../src/core/implementation-context.ts';
import { artifactSchemas } from '../src/core/artifacts.ts';

test('no-patch completion applies once to implementation without bypassing permission denial', () => {
  assert.equal(needsImplementationCompletion({ stage: 'fix', changes: ['claimed edit'] }, '', false), true);
  assert.equal(needsImplementationCompletion({ stage: 'docs', changes: ['claimed edit'] }, '', false), true);
  assert.equal(needsImplementationCompletion({ stage: 'fix', changes: ['edit'] }, 'actual diff', false), false);
  assert.equal(needsImplementationCompletion({ stage: 'fix', changes: [] }, '', false), true);
  assert.equal(needsImplementationCompletion({ stage: 'fix', changes: ['edit'] }, '', true), false);
  assert.equal(needsImplementationCompletion({ stage: 'review', changes: ['edit'] }, '', false), false);
});

test('implementation handoff marks its primary accepted target and omits old coverage/execution claims', () => {
  const review = artifactSchemas.review.parse({ schemaVersion: 1, stage: 'review', summary: 'Historical review', coverage: 'Already tested', evidence: [], nextSteps: [], responseDraft: '', findings: [{ id: 'F1', title: 'Wrong bound', severity: 'P2', path: 'src/chunk.ts', line: 8, trigger: 'size=2', evidence: 'old proof', recommendation: 'Restore bound', sourceEvidence: { executionId: 'call_old', path: 'src/chunk.ts', line: 8, quote: 'old code' } }], verdict: 'changes_requested', blockers: [] });
  const target = implementationPromptHandoff({ sourceJobId: 'review-job', handoff: [{ id: 'review-job', kind: 'review', revision: 'sha', artifact: review, findings: { F1: 'accepted' } }] })!;
  assert.equal(target[0].isPrimaryTarget, true);
  assert.equal(target[0].findings[0].decision, 'accepted');
  assert.doesNotMatch(JSON.stringify(target), /call_old|Already tested|sourceEvidence/);
});
