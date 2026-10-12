import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleReport, type ReportContext } from '../src/core/report-assembly.ts';
import { parseReport } from '../src/core/report-finalizer.ts';
import { artifactSchemas } from '../src/core/artifacts.ts';
import type { ExecutionRecord, JobKind } from '../src/core/types.ts';

export const reports: Record<JobKind, object> = {
  triage: { category: 'bug', priority: 'P2', labels: [], module: 'ui', impact: 'unknown', missingInfo: [], duplicateOf: null, duplicateReason: '', route: 'investigate', routeReason: '需源码证据' },
  preflight: { intent: '修复 UI', risks: [], readiness: 'review', blockers: [] },
  investigate: { facts: [], hypotheses: [], reproduction: '未复现', rootCause: 'unknown', impact: 'unknown', proposedChanges: [], acceptanceCriteria: [], blockers: [] },
  fix: { changes: ['修改 UI'], acceptanceCriteria: [], limitations: [], tests: [] },
  docs: { changes: ['修改文档'], acceptanceCriteria: [], limitations: [], tests: [] },
  validate: { environment: 'local', tests: [], blockers: ['检查尚未执行'] },
  review: { inspectedSources: [], findings: [], verdict: 'incomplete', blockers: ['源码覆盖不足'] },
  ci: { classification: 'unknown', facts: [], hypotheses: [], proposedChanges: [], blockers: [] },
};
const compact = (kind: JobKind, extra: object = {}) => ({ reportFormat: 'compact-v1', summary: '结论', coverage: '明确覆盖范围', ...reports[kind], ...extra });
const record: ExecutionRecord = { id: 'session:1', callId: 'call1', sessionId: 'session', tool: 'bash', command: 'check "C:\\tmp"\nnext', cwd: '/worktree', checkoutSha: 'base', patchHash: 'patch', exitCode: 1, isError: false, output: 'actual "failure"\n\\n remains literal', recordedAt: 'now', truncated: false };
const context: ReportContext = { sessionId: 'session', baseSha: 'base', worktree: '/worktree', patchSha256: 'patch', executionRecords: [record] };

for (const kind of Object.keys(reports) as JobKind[]) test(`compact ${kind} assembles into the unchanged internal artifact contract`, () => {
  const value = compact(kind), before = JSON.stringify(value);
  const artifact = parseReport(kind, before, () => {});
  assert.ok(artifactSchemas[kind].safeParse(artifact).success);
  assert.equal(artifact.schemaVersion, 1); assert.equal(artifact.stage, kind);
  assert.deepEqual(artifact.evidence, []); assert.deepEqual(artifact.nextSteps, []); assert.equal(artifact.responseDraft, '');
  assert.equal(JSON.stringify(value), before);
  assert.throws(() => assembleReport(kind, { ...value, stage: 'fake' }));
});

test('host supplies commands and original output; failed, cancelled and unexecuted checks cannot become passing', () => {
  const report = compact('validate', { tests: [{ executionId: record.id, status: 'passed', output: 'fake success' }], evidenceRefs: [record.callId] });
  const artifact = assembleReport('validate', report, context);
  assert.deepEqual('tests' in artifact && artifact.tests[0], { executionId: record.id, command: record.command, status: 'failed', output: record.output });
  assert.ok(artifact.evidence[0].detail.includes(record.output));
  for (const change of [{ exitCode: null }, { exitCode: 0, signal: 'SIGTERM' }]) {
    const result = assembleReport('validate', report, { ...context, executionRecords: [{ ...record, ...change }] });
    assert.equal('tests' in result && result.tests[0].status, 'not_run');
  }
  const failed = assembleReport('validate', compact('validate', { tests: [{ executionId: record.id, status: 'failed' }] }), { ...context, executionRecords: [{ ...record, exitCode: 0 }] });
  assert.equal('tests' in failed && failed.tests[0].status, 'failed');
  const missing = assembleReport('validate', compact('validate', { tests: [{ command: 'pnpm test', status: 'not_run', output: '依赖未安装' }] }));
  assert.equal('tests' in missing && missing.tests[0].status, 'not_run');
  assert.throws(() => assembleReport('validate', compact('validate', { tests: [{ command: 'pnpm test', status: 'passed' }] })));
});

test('evidence references reject foreign sessions, revisions, worktrees, patches, missing or ambiguous IDs', () => {
  const value = compact('validate', { tests: [{ executionId: record.id }] });
  for (const replacement of [{ sessionId: 'old' }, { checkoutSha: 'old' }, { cwd: '/other' }, { patchHash: 'old' }, { command: undefined }])
    assert.throws(() => assembleReport('validate', value, { ...context, executionRecords: [{ ...record, ...replacement }] }));
  assert.throws(() => assembleReport('validate', value));
  assert.throws(() => assembleReport('validate', value, { ...context, executionRecords: [record, record] }));
});

test('source quotes can be extracted only from a cited numbered read, with existing review checks still required', () => {
  const source = { ...record, tool: 'read', command: undefined, sourcePath: 'source.ts', exitCode: null, output: '12 | const text = "quoted";\n13 | next();' };
  const value = compact('review', { inspectedSources: [{ executionId: record.id, path: 'source.ts', line: 12 }] });
  const artifact = assembleReport('review', value, { ...context, executionRecords: [source] });
  assert.equal(artifact.stage === 'review' && artifact.inspectedSources?.[0].quote, 'const text = "quoted";');
  assert.throws(() => assembleReport('review', value, { ...context, executionRecords: [{ ...source, sourcePath: 'other.ts' }] }));
  assert.throws(() => assembleReport('review', value, { ...context, executionRecords: [{ ...source, output: 'un-numbered source' }] }));
});

test('compact empty optional requests retain the previous normalization without discarding real gaps', () => {
  const artifact = assembleReport('triage', compact('triage', { inputRequest: { reason: '无追问', fields: [] }, missingInfo: ['真实缺口'], route: 'needs_info' }));
  assert.equal(artifact.inputRequest, undefined); assert.deepEqual(artifact.stage === 'triage' && artifact.missingInfo, ['真实缺口']);
});
