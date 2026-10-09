import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { git } from '../src/core/git.ts';
import { artifactSchemas } from '../src/core/artifacts.ts';
import { reviewEvidenceGate, assertReviewEvidence, toolDiagnosticReasons, verifiedReviewCoverage } from '../src/core/review-evidence.ts';
import type { Job, ToolDiagnostics } from '../src/core/types.ts';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { seedFixture } from './support/fixtures.ts';
import { asAnalysis } from '../src/core/artifacts.ts';
import { reviewRequiredSources } from '../src/core/review-context.ts';

const diagnostics: ToolDiagnostics = { sessionId: 'session', provider: 'fixture', model: 'fixture', preset: 'coding', permission: 'read-only', mountedTools: ['read_file'], requests: [{ tools: ['read_file'] }], calls: 1, results: 1, canonicalResults: 1, errors: 0, finished: true };
test('diagnostics separate missing mount, request exposure, invocation and missing result', () => {
  assert.match(toolDiagnosticReasons()[0], /未采集/);
  assert.match(toolDiagnosticReasons({ ...diagnostics, mountedTools: [] })[0], /未挂载/);
  assert.match(toolDiagnosticReasons({ ...diagnostics, requests: [] })[0], /未观察到/);
  assert.match(toolDiagnosticReasons({ ...diagnostics, requests: [{ tools: [] }] })[0], /未携带/);
  assert.match(toolDiagnosticReasons({ ...diagnostics, calls: 0, results: 0, canonicalResults: 0 })[0], /未观察到调用/);
  assert.match(toolDiagnosticReasons({ ...diagnostics, results: 0 })[0], /未收到/);
  assert.match(toolDiagnosticReasons({ ...diagnostics, canonicalResults: 0 })[0], /采集链路/);
});

test('native review evidence fails closed for inaccurate, missing and stale source references', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mw-review-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  const quote = 'return items.slice(0, size - 1);';
  const testQuote = 'expect(chunk([1,2], 2)).toEqual([1,2]);';
  await writeFile(join(root, 'chunk.ts'), `// fixture\n${quote}\n`);
  await writeFile(join(root, 'chunk.test.ts'), `${testQuote}\n`);
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
  const baseline = await git(root, ['rev-parse', 'HEAD']);
  await writeFile(join(root, 'chunk.ts'), `// changed fixture\n${quote}\n`);
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'candidate']);
  const sha = await git(root, ['rev-parse', 'HEAD']);
  const digest = createHash('sha256').update('').digest('hex');
  const ref = { executionId: 'call-read', path: 'chunk.ts', line: 2, quote };
  const artifact = artifactSchemas.review.parse({ schemaVersion: 1, stage: 'review', summary: 'Fixture', coverage: 'chunk.ts', evidence: [], nextSteps: [], responseDraft: '', verdict: 'changes_requested', blockers: [], inspectedSources: [ref], findings: [{ id: 'F1', title: 'Drops last item', severity: 'P2', path: ref.path, line: ref.line, trigger: 'size=2', evidence: quote, recommendation: 'Use size', sourceEvidence: ref, reproduction: { input: '[1,2], size=2', expected: '[1,2]', actual: '[1]', basis: 'reasoned' } }] });
  const job = { id: 'fixture', kind: 'review', sessionId: 'session', worktree: root, baseSha: sha, patchSha256: digest, toolDiagnostics: diagnostics, artifact, executionRecords: [{ id: 'session:3', callId: 'call-read', sessionId: 'session', tool: 'read_file', sourcePath: 'chunk.ts', cwd: root, checkoutSha: sha, patchHash: digest, exitCode: null, isError: false, output: quote, truncated: false, recordedAt: '' }] } as Job;
  assert.equal((await reviewEvidenceGate(job)).allowed, true);
  const requiredJob = { ...job, prContext: { baseSha: baseline } } as Job;
  assert.deepEqual(await reviewRequiredSources(requiredJob), ['chunk.ts', 'chunk.test.ts']);
  assert.match((await reviewEvidenceGate(requiredJob)).reasons.join(' '), /缺少必读.*chunk.test.ts/);
  const testRead = { ...job.executionRecords![0], id: 'session:5', callId: 'call-test-read', sourcePath: 'chunk.test.ts', output: testQuote };
  const withTest = { ...artifact, inspectedSources: [...artifact.inspectedSources!, { executionId: testRead.callId, path: 'chunk.test.ts', line: 1, quote: testQuote }] };
  assert.equal((await reviewEvidenceGate({ ...requiredJob, executionRecords: [...job.executionRecords!, testRead] }, withTest)).allowed, true);
  const absolute = structuredClone(artifact); absolute.inspectedSources![0].path = join(root, 'chunk.ts'); absolute.findings[0].sourceEvidence!.path = join(root, 'chunk.ts');
  assert.equal((await reviewEvidenceGate(job, absolute)).allowed, true);
  assert.equal((await reviewEvidenceGate(job, { ...absolute, inspectedSources: [{ ...ref, path: '/tmp/outside.ts' }] })).allowed, false);
  const covered = verifiedReviewCoverage(job, { ...absolute, coverage: 'claimed tests inspected' }, true);
  assert.match(covered.coverage, /chunk.ts/); assert.doesNotMatch(covered.coverage, /claimed tests/);
  const badLine = structuredClone(artifact); badLine.findings[0].sourceEvidence!.line = 1;
  assert.equal((await reviewEvidenceGate(job, badLine)).allowed, false);
  for (const records of [[], [{ ...job.executionRecords![0], sessionId: 'other' }], [{ ...job.executionRecords![0], patchHash: 'other' }], [{ ...job.executionRecords![0], output: 'unrelated output' }], [{ ...job.executionRecords![0], isError: true }]]) {
    await assert.rejects(assertReviewEvidence({ ...job, executionRecords: records }), /证据未达/);
  }
  assert.equal((await reviewEvidenceGate({ ...job, toolDiagnostics: undefined })).allowed, false);
  const unexecuted = structuredClone(artifact); unexecuted.findings[0].reproduction!.basis = 'executed';
  assert.equal((await reviewEvidenceGate(job, unexecuted)).allowed, false);
  // A failing regression is valid execution evidence, with an authoritative exit code.
  unexecuted.findings[0].reproduction!.executionId = 'call-test';
  unexecuted.findings[0].reproduction!.command = 'node test.cjs';
  unexecuted.findings[0].reproduction!.outputQuote = quote;
  const processRecord = { ...job.executionRecords![0], id: 'session:4', callId: 'call-test', tool: 'bash', sourcePath: undefined, command: 'node test.cjs', exitCode: 1, isError: true };
  assert.equal((await reviewEvidenceGate({ ...job, executionRecords: [...job.executionRecords!, processRecord] }, unexecuted)).allowed, true);
  unexecuted.findings[0].reproduction!.command = 'invented command';
  assert.equal((await reviewEvidenceGate({ ...job, executionRecords: [...job.executionRecords!, processRecord] }, unexecuted)).allowed, false);
  const noFindings = { ...artifact, verdict: 'no_findings' as const, findings: [], inspectedSources: [] };
  assert.equal((await reviewEvidenceGate(job, noFindings)).allowed, false);
  const traversal = structuredClone(artifact); traversal.inspectedSources![0].path = '../chunk.ts';
  assert.equal((await reviewEvidenceGate(job, traversal)).allowed, false);
  await writeFile(join(root, 'chunk.ts'), '// changed\n');
  assert.equal((await reviewEvidenceGate(job)).allowed, false);
});

test('local approval cannot accept an old native review without tool diagnostics', async () => {
  const store = new Store(':memory:'); seedFixture(store);
  const workbench = new Workbench(store, tmpdir(), undefined, undefined, false);
  try {
    const issue = store.issues()[0];
    const artifact = artifactSchemas.review.parse({ schemaVersion: 1, stage: 'review', summary: 'Historical unsupported review', coverage: 'unknown', evidence: [], nextSteps: [], responseDraft: '', verdict: 'no_findings', blockers: [], findings: [] });
    store.put('jobs', { id: 'old-native', kind: 'review', status: 'awaiting_review', sessionId: 'session', worktree: '/missing-owned-fixture', baseSha: 'a'.repeat(40), repoId: issue.repoId, issueId: issue.id, issueSnapshot: issue, revision: 'fixture', attempt: 1, createdAt: '', updatedAt: '', artifact, result: asAnalysis(artifact) });
    await assert.rejects(workbench.review('old-native', 'approve', ''), /证据未达验收门槛/);
    assert.equal(store.get<Job>('jobs', 'old-native')!.status, 'awaiting_review');
    await workbench.review('old-native', 'reject', 'needs evidence');
    assert.equal(store.get<Job>('jobs', 'old-native')!.status, 'rejected');
  } finally { await workbench.close(); }
});

test('review of a supplied repair still requires source/tests when repair restores the remote PR base',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mw-restored-review-'));t.after(()=>rm(root,{recursive:true,force:true}));await git(root,['init','-b','main']);
 await writeFile(join(root,'chunk.ts'),'good source\n');await writeFile(join(root,'chunk.test.ts'),'regression test\n');await git(root,['add','.']);await git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','good baseline']);const good=await git(root,['rev-parse','HEAD']);
 await writeFile(join(root,'chunk.ts'),'bad source\n');await git(root,['add','.']);await git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','controlled defect']);const bad=await git(root,['rev-parse','HEAD']);
 await writeFile(join(root,'chunk.ts'),'good source\n');assert.equal(await git(root,['diff','--name-only',good]),'');
 assert.deepEqual(await reviewRequiredSources({worktree:root,baseSha:bad,sourceJobId:'validation',prContext:{baseSha:good}} as Job),['chunk.ts','chunk.test.ts']);
});
