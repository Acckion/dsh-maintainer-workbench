import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionWithinWorktree } from '../src/core/execution-cwd-native.ts';
import { executionRecord } from '../src/core/execution-evidence.ts';
import { parseReport, reportRecoveryPrompt } from '../src/core/report-finalizer.ts';
import { linkedExecution } from '../src/core/execution-links.ts';
import type { Job } from '../src/core/types.ts';

test('monorepo checks retain their actual absolute cwd, including old relative records; escapes stay rejected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'report-cwd-'));
  const outside = await mkdtemp(join(tmpdir(), 'report-outside-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const sub = join(root, 'projects', 'core');
  await mkdir(sub, { recursive: true });
  await symlink(outside, join(root, 'escape'));
  const job = { worktree: root, kind: 'validate', baseSha: 'base', sessionId: 'session', patchSha256: 'patch' } as Job;
  const record = executionRecord(job, 'session', 37, { name: 'bash', arguments: JSON.stringify({ command: 'node --test', workdir: 'projects/core' }) }, { message: { toolCallId: 'call-test' }, meta: { exitCode: 0, output: '4 passed' } }, 'patch');
  assert.equal(record.cwd, sub);
  for (const cwd of [sub, 'projects/core']) {
    const context = { ...job, executionRecords: [{ ...record, cwd }] };
    assert.equal(linkedExecution(context, { command: record.command!, executionId: record.id })?.id, record.id);
    const report = { reportFormat: 'compact-v1', summary: '通过', coverage: 'core', environment: 'local', tests: [{ executionId: record.id }], blockers: [] };
    const artifact = parseReport('validate', JSON.stringify(report), () => {}, context);
    assert.equal(artifact.stage === 'validate' && artifact.tests[0].status, 'passed');
    for (const change of [{ sessionId: 'foreign' }, { checkoutSha: 'old' }, { patchHash: 'old' }, { cwd: outside }, { cwd: '../outside' }, { cwd: 'escape' }])
      assert.throws(() => parseReport('validate', JSON.stringify(report), () => {}, { ...context, executionRecords: [{ ...record, ...change }] }));
  }
  assert.equal(executionWithinWorktree(root, join(root, 'missing')), false);
  assert.equal(executionWithinWorktree(root, join(root + '-sibling')), false);
});

test('saved report retries provide authoritative source and test IDs without accepting invented aliases', () => {
  const job = { worktree: '/fixture', baseSha: 'base', sessionId: 'session', patchSha256: 'patch' } as Job;
  const record = executionRecord(job, 'session', 24, { name: 'read', arguments: '{"path":"core.ts"}' }, { message: { toolCallId: 'call-source', content: [{ text: '18: export function sum() {}' }] } }, 'patch');
  const context = { ...job, executionRecords: [record] };
  const report = { reportFormat: 'compact-v1', summary: '已读源码', coverage: 'core', inspectedSources: [{ executionId: 'read-core-src', path: 'core.ts', line: 18, quote: 'export function sum() {}' }], findings: [], verdict: 'incomplete', blockers: ['尚未完成'] };
  assert.throws(() => parseReport('review', JSON.stringify(report), () => {}, context), /read-core-src/);
  const prompt = reportRecoveryPrompt('review', JSON.stringify(report), 'schema', undefined, context);
  assert.ok(prompt.includes('session:24') && prompt.includes('call-source') && prompt.includes('core.ts'));
  assert.match(prompt, /Do not retain invented aliases/);
  const corrected = { ...report, inspectedSources: [{ ...report.inspectedSources[0], executionId: record.id }] };
  assert.equal(parseReport('review', JSON.stringify(corrected), () => {}, context).stage, 'review');
  const abbreviated = { ...corrected, inspectedSources: [{ ...corrected.inspectedSources[0], quote: 'function sum() {}' }] };
  const expanded = parseReport('review', JSON.stringify(abbreviated), () => {}, context);
  assert.equal(expanded.stage === 'review' && expanded.inspectedSources?.[0].quote, 'export function sum() {}');
  assert.throws(() => parseReport('review', JSON.stringify({ ...abbreviated, inspectedSources: [{ ...abbreviated.inspectedSources[0], quote: 'export function unrelated() {}' }] }), () => {}, context), /请使用完整原文或省略 quote/);
  const withoutQuote = { ...corrected, inspectedSources: [{ ...corrected.inspectedSources[0], quote: undefined }] };
  const extracted = parseReport('review', JSON.stringify(withoutQuote), () => {}, context);
  assert.equal(extracted.stage === 'review' && extracted.inspectedSources?.[0].quote, 'export function sum() {}');
});
