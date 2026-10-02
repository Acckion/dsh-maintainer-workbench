import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { corpus, corpusVersion } from './corpus.ts';
import type { Artifact } from '../../src/core/artifacts.ts';
import type { Job, Runner } from '../../src/core/types.ts';

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return args[i + 1]; };
const source = resolve(arg('--source')), out = resolve(arg('--out'));
const load = (file: string) => import(pathToFileURL(join(source, file)).href);
const { Store } = await load('src/core/store.ts') as typeof import('../../src/core/store.ts');
const { Workbench } = await load('src/core/workbench.ts') as typeof import('../../src/core/workbench.ts');
const { GitHub } = await load('src/core/github.ts') as typeof import('../../src/core/github.ts');
const { git } = await load('src/core/git.ts') as typeof import('../../src/core/git.ts');
const { artifactSchemas, asAnalysis } = await load('src/core/artifacts.ts') as typeof import('../../src/core/artifacts.ts');
const FormatError = existsSync(join(source, 'src/core/execution-errors.ts')) ? (await load('src/core/execution-errors.ts')).ArtifactFormatError as ErrorConstructor : Error;
const exec = promisify(execFile);
// Fixture-only process: no source can fall through to a real network request.
const denyNetwork: typeof fetch = async () => { throw new Error('Evaluation forbids external network access'); };
globalThis.fetch = denyNetwork;
process.env.MAINTAINER_API_KEY = 'deterministic-fixture-only';
process.env.GITHUB_TOKEN = 'deterministic-fixture-only';
process.env.MAINTAINER_BASE_URL = 'http://127.0.0.1:9';
const common = { schemaVersion: 1 as const, summary: 'Deterministic workflow fixture', coverage: 'Owned local corpus; scripted responses, not model intelligence', evidence: [], nextSteps: [], responseDraft: '' };
const triage = (missing = false) => artifactSchemas.triage.parse({ ...common, stage: 'triage', category: 'bug', priority: 'P2', labels: [], module: 'sum', impact: missing ? 'unknown' : 'incorrect addition', missingInfo: missing ? ['steps to reproduce'] : [], duplicateOf: null, duplicateReason: '', route: missing ? 'needs_info' : 'investigate', routeReason: missing ? 'Evidence is absent' : 'Reproduce first' });
const result = (artifact: Artifact) => ({ artifact, result: asAnalysis(artifact), engine: 'deterministic fixture executor (no model inference)' });
const validateArtifact = (tests: { command: string; status: 'passed' | 'failed' | 'not_run'; output: string }[] = []) => artifactSchemas.validate.parse({ ...common, stage: 'validate', environment: 'owned local fixture', tests, blockers: [] });
const fixArtifact = (tests: { command: string; status: 'passed' | 'failed' | 'not_run'; output: string }[] = []) => artifactSchemas.fix.parse({ ...common, stage: 'fix', changes: ['owned fixture change'], acceptanceCriteria: ['fixture assertions hold'], limitations: ['scripted executor; not model quality'], tests });
const reviewArtifact = () => artifactSchemas.review.parse({ ...common, stage: 'review', findings: [], verdict: 'no_findings', blockers: [] });
type Measurement = { runnerInvocations: number; testCommands: { command: string; exitCode: number; output: string; durationMs: number }[]; observations: Record<string, unknown>; jobs: unknown[] };
const reports: unknown[] = [];

for (const entry of corpus) {
  const started = performance.now();
  const dir = await mkdtemp(join(tmpdir(), 'mw-evaluation-'));
  const path = join(dir, 'repo'); await mkdir(path);
  const measure: Measurement = { runnerInvocations: 0, testCommands: [], observations: {}, jobs: [] };
  let store: InstanceType<typeof Store> | undefined, workbench: InstanceType<typeof Workbench> | undefined;
  let passed = false, error: string | undefined;
  try {
    await git(path, ['init', '-b', 'main']);
    await git(path, ['remote', 'add', 'origin', 'https://github.com/fixture/evaluation.git']);
    await writeFile(join(path, 'sum.cjs'), `module.exports=(a,b)=>a${entry.id === 'bug-lifecycle' ? '-' : '+'}b;\n`);
    await writeFile(join(path, 'test.cjs'), "const assert=require('node:assert/strict');assert.equal(require('./sum.cjs')(2,1),3);assert.equal(require('./sum.cjs')(-2,1),-1);console.log('REGRESSION_PASSED');\n");
    await writeFile(join(path, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(path, 'old.bin'), Buffer.from([0, 1, 2, 3]));
    await git(path, ['add', '.']);
    await git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'owned evaluation fixture']);
    const sha = await git(path, ['rev-parse', 'HEAD']);
    store = new Store(':memory:');
    store.put('repos', { id: 'fixture/evaluation', fullName: 'fixture/evaluation', description: '', defaultBranch: 'main', headSha: sha, localPath: path, mode: 'github', syncedAt: null, syncWarning: null, profile: { revision: sha, scannedAt: '2026-10-02', languages: ['JavaScript'], roots: [], testPaths: ['test.cjs'], workflows: [], manifests: [], commands: [{ source: 'test.cjs', command: 'node test.cjs' }], sources: [], warnings: [] } });
    const issue = { id: 'fixture/evaluation#1', repoId: 'fixture/evaluation', number: 1, type: 'issue' as const, title: entry.title, body: entry.oracle, author: 'owned-fixture', labels: [], state: 'open' as const, comments: 0, updatedAt: '2026-10-02T00:00:00Z', url: '' };
    store.put('issues', issue);
    const github = new GitHub('', async () => Response.json([]));
    github.context = async () => JSON.stringify({ comments: [], pullRequest: null });
    github.profile = async repo => repo.profile!;
    const testCommand = async (cwd: string) => {
      const start = performance.now(); let exitCode = 0, output = '';
      try { const r = await exec(process.execPath, ['test.cjs'], { cwd, timeout: 10000, maxBuffer: 100000 }); output = r.stdout + r.stderr; }
      catch (e) { const failure = e as { code?: number; stdout?: string; stderr?: string }; exitCode = typeof failure.code === 'number' ? failure.code : -1; output = (failure.stdout ?? '') + (failure.stderr ?? ''); }
      const record = { command: 'node test.cjs', exitCode, output: output.slice(0, 5000), durationMs: Math.round((performance.now() - start) * 100) / 100 };
      measure.testCommands.push(record); return { command: record.command, status: exitCode === 0 ? 'passed' as const : 'failed' as const, output: record.output };
    };
    let implementations = 0;
    const runner: Runner = async input => {
      measure.runnerInvocations++;
      const { job, recordOutput } = input;
      if (entry.id === 'mutation-retry') {
        if (!job.formatOnly) await writeFile(join(job.worktree!, 'sum.cjs'), 'module.exports=()=>999;\n');
        recordOutput?.(JSON.stringify(validateArtifact()));
        return result(validateArtifact());
      }
      if (entry.id === 'format-recovery') {
        if (!job.formatOnly) { implementations++; await writeFile(join(job.worktree!, 'sum.cjs'), 'module.exports=(a,b)=>Number(a)+Number(b);\n'); recordOutput?.('malformed final response'); throw new FormatError('fixture output/schema failure'); }
        return result(fixArtifact());
      }
      if (job.kind === 'triage') return result(triage(entry.id === 'missing-context'));
      if (job.kind === 'investigate') return result(artifactSchemas.investigate.parse({ ...common, stage: 'investigate', facts: ['sum.cjs subtracts instead of adding'], hypotheses: [], reproduction: 'node test.cjs', rootCause: 'wrong arithmetic operator', impact: 'incorrect output', proposedChanges: ['replace subtraction with addition'], acceptanceCriteria: ['positive and negative inputs pass'], blockers: [] }));
      if (job.kind === 'fix') {
        implementations++;
        if (entry.id === 'binary-handoff') {
          await writeFile(join(job.worktree!, 'asset.bin'), Buffer.from([0, 1, 2, 4]));
          await writeFile(join(job.worktree!, 'new.bin'), Buffer.from([0, 4, 3, 2]));
          await rm(join(job.worktree!, 'old.bin'));
          return result(fixArtifact());
        }
        const before = await testCommand(job.worktree!); assert.equal(before.status, 'failed');
        await writeFile(join(job.worktree!, 'sum.cjs'), 'module.exports=(a,b)=>a+b;\n');
        const after = await testCommand(job.worktree!); assert.equal(after.status, 'passed');
        return result(fixArtifact([before, after]));
      }
      if (entry.id === 'binary-handoff') {
        assert.deepEqual(await readFile(join(job.worktree!, 'asset.bin')), Buffer.from([0, 1, 2, 4]));
        assert.deepEqual(await readFile(join(job.worktree!, 'new.bin')), Buffer.from([0, 4, 3, 2]));
        await assert.rejects(readFile(join(job.worktree!, 'old.bin')), { code: 'ENOENT' });
      }
      if (job.kind === 'validate') { const checked = await testCommand(job.worktree!); assert.equal(checked.status, 'passed'); return result(validateArtifact([checked])); }
      assert.equal(job.kind, 'review');
      assert.equal(await readFile(join(job.worktree!, 'sum.cjs'), 'utf8'), 'module.exports=(a,b)=>a+b;\n');
      return result(reviewArtifact());
    };
    if (['unexecuted-test-claim', 'unsupported-duplicate'].includes(entry.id)) {
      globalThis.fetch = async input => {
        const url = String(input);
        if (url === 'http://127.0.0.1:9/chat/completions') {
          const artifact = entry.id === 'unexecuted-test-claim' ? validateArtifact([{ command: 'npm test', status: 'passed', output: 'invented model claim' }]) : { ...triage(), duplicateOf: 999, duplicateReason: 'unsupported claim' };
          return Response.json({ choices: [{ message: { content: JSON.stringify(artifact) } }] });
        }
        if (url.startsWith('https://api.github.com/')) return Response.json([]);
        throw new Error(`Unexpected fixture destination: ${url}`);
      };
    }
    const remoteOnly = ['unexecuted-test-claim', 'unsupported-duplicate'].includes(entry.id);
    workbench = new Workbench(store, dir, remoteOnly ? undefined : runner, github, false);
    const run = async (kind: Job['kind'], sourceJobId?: string) => {
      const id = workbench!.enqueue([issue.id], kind, { sourceJobId }).created[0];
      workbench!.pump(); await workbench!.drain(); return store!.get<Job>('jobs', id)!;
    };
    if (entry.id === 'bug-lifecycle' || entry.id === 'binary-handoff') {
      let sourceJobId: string | undefined;
      const stages: Job['kind'][] = entry.id === 'bug-lifecycle' ? ['triage', 'investigate', 'fix', 'validate', 'review'] : ['fix', 'validate', 'review'];
      for (const kind of stages) { const j = await run(kind, sourceJobId); assert.equal(j.status, ['fix', 'review'].includes(kind) ? 'awaiting_review' : 'completed', j.error); sourceJobId = j.id; }
      assert.equal(implementations, 1);
      assert.equal(await readFile(join(path, 'sum.cjs'), 'utf8'), `module.exports=(a,b)=>a${entry.id === 'bug-lifecycle' ? '-' : '+'}b;\n`);
      assert.deepEqual(await readFile(join(path, 'asset.bin')), Buffer.from([0, 1, 2, 3]));
      assert.deepEqual(await readFile(join(path, 'old.bin')), Buffer.from([0, 1, 2, 3]));
      await assert.rejects(readFile(join(path, 'new.bin')), { code: 'ENOENT' });
      measure.observations.sourceCheckoutUnchanged = true;
      measure.observations.independentCodeWorkspaces = new Set(store.jobs().map(j => j.worktree).filter(Boolean)).size;
      assert.equal(measure.observations.independentCodeWorkspaces, entry.id === 'bug-lifecycle' ? 4 : 3, 'Code stages must use separate worktrees');
    } else if (entry.id === 'clean-review') {
      const validation = await run('validate'); assert.equal(validation.status, 'completed', validation.error);
      const review = await run('review', validation.id); assert.equal(review.status, 'awaiting_review', review.error);
      assert.equal(review.artifact?.stage, 'review'); assert.equal(review.artifact.stage === 'review' && review.artifact.findings.length, 0); assert.equal(review.patch, '');
      measure.observations.scriptedFalsePositive = false;
    } else if (entry.id === 'missing-context') {
      const j = await run('triage'); assert.equal(j.status, 'completed'); assert.ok(j.artifact?.stage === 'triage' && j.artifact.route === 'needs_info'); assert.equal(j.worktree, undefined); assert.equal(j.patch, '');
    } else if (entry.id === 'mutation-retry') {
      const first = await run('validate'); assert.equal(first.status, 'failed');
      workbench.retry(first.id); workbench.pump(); await workbench.drain();
      const retry = store.jobs().at(-1)!;
      measure.observations = { initialStatus: first.status, retryStatus: retry.status, sameWorktree: first.worktree === retry.worktree, unsafeArtifactAccepted: retry.status !== 'failed' };
      assert.equal(retry.status, 'failed', 'Retry accepted the forbidden validator modification');
    } else if (entry.id === 'unexecuted-test-claim') {
      const j = await run('validate'); assert.equal(j.status, 'completed', j.error);
      assert.ok(j.artifact && 'tests' in j.artifact);
      measure.observations = { artifactTestStatus: j.artifact.tests[0].status, projectionTestStatus: j.result?.tests[0].status };
      assert.equal(j.artifact.tests[0].status, 'not_run'); assert.equal(j.result?.tests[0].status, 'not_run');
      const next = workbench.enqueue([issue.id], 'investigate', { sourceJobId: j.id }).created[0];
      const inherited = store.get<Job>('jobs', next)!.handoff!.find(h => h.id === j.id)!.artifact!;
      assert.ok('tests' in inherited); assert.equal(inherited.tests[0].status, 'not_run');
    } else if (entry.id === 'unsupported-duplicate') {
      const j = await run('triage'); assert.equal(j.status, 'failed'); assert.match(j.error!, /重复/); assert.equal(j.result, undefined);
    } else if (entry.id === 'format-recovery') {
      const first = await run('fix'); assert.equal(first.status, 'failed');
      workbench.retry(first.id); workbench.pump(); await workbench.drain(); const retry = store.jobs().at(-1)!;
      assert.equal(retry.status, 'awaiting_review', retry.error); assert.equal(retry.worktree, first.worktree); assert.equal(implementations, 1); measure.observations.implementationExecutions = implementations;
    }
    passed = true;
  } catch (e) { error = e instanceof Error ? e.message.slice(0, 3000) : String(e); }
  finally {
    globalThis.fetch = denyNetwork;
    if (store) measure.jobs = store.jobs().map(j => ({ id: j.id, kind: j.kind, status: j.status, error: j.error, formatOnly: j.formatOnly ?? false, hasWorktree: !!j.worktree, sourceJobId: j.sourceJobId, patch: j.patch, artifact: j.artifact, reportedTests: j.result?.tests }));
    if (workbench) await workbench.close(); else store?.close();
    await rm(dir, { recursive: true, force: true });
  }
  const report = { ...entry, expectationSatisfied: passed, error, durationMs: Math.round((performance.now() - started) * 100) / 100, ...measure };
  reports.push(report); console.log(`${passed ? 'PASS' : 'FAIL'} ${entry.id}${error ? ': ' + error.split('\n')[0] : ''}`);
}
const data = { schemaVersion: 1, corpusVersion, generatedAt: new Date().toISOString(), sourceCommit: arg('--commit'), mode: 'deterministic-workflow-contracts', corpusDescription: 'Scripted responses and disposable local repositories exercise product contracts. This is not a model-quality benchmark.', metrics: { cases: reports.length, passed: reports.filter(r => (r as { expectationSatisfied: boolean }).expectationSatisfied).length, paidApiRequests: 0, realModelTokens: null, realApiCostUsd: null, humanAcceptanceRate: null, realModelFalsePositiveRate: null }, cases: reports, limitations: ['Scripted outcomes do not establish model reasoning or repair quality', 'Elapsed times include local fixture setup; single runs are not performance comparisons', 'The no-defect control validates plumbing, not a learned reviewer', 'No external GitHub writes or paid model calls'] };
await mkdir(resolve(out, '..'), { recursive: true }); await writeFile(out, JSON.stringify(data, null, 2) + '\n');
