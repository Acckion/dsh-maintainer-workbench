import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateReport } from '../tests/evaluation/report.ts';
import { fixtureEnvironment } from '../tests/evaluation/environment.ts';
import { dependencyFingerprints } from '../tests/evaluation/dependencies.ts';
const exec = promisify(execFile), root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing ${flag} value`); return args[i + 1]; };
for (let i = 0; i < args.length; i++) { if (['--baseline', '--out'].includes(args[i])) i++; else if (args[i] !== '--skip-native') throw Error(`Unknown argument: ${args[i]}`); }
const git = async args => (await exec('git', args, { cwd: root })).stdout.trim();
const baseline = await git(['rev-parse', '--verify', '--end-of-options', `${value('--baseline', '853bc5a75cc2823e407d8a0a6123cabca85d3985')}^{commit}`]);
const candidate = await git(['rev-parse', 'HEAD']);
const dirty = !!(await git(['status', '--porcelain']));
const directory = resolve(root, value('--out', `.data/evaluations/${new Date().toISOString().replace(/[:.]/g, '-')}`));
await mkdir(directory, { recursive: true });
if ((await readdir(directory)).length) throw Error('Output directory is not empty; use a new directory to preserve evidence');
const scratch = await mkdtemp(join(tmpdir(), 'mw-compare-'));
const env = fixtureEnvironment(process.env, scratch);
await mkdir(join(scratch, 'home'));
await writeFile(join(scratch, 'empty.gitconfig'), '');
const runCorpus = async (source, label, commit) => {
  const output = join(directory, `${label}.json`);
  const result = await exec(process.execPath, ['--import', 'tsx', 'tests/evaluation/run.ts', '--source', source, '--out', output, '--commit', commit], { cwd: root, env, timeout: 60000, maxBuffer: 500000 });
  console.log(`${label}:\n${result.stdout.trim()}`);
  return validateReport(JSON.parse(await readFile(output, 'utf8')));
};
let before, after, dependencyLockSha256, baselineDependencyLockSha256, dependencyGraphSha256, native = { status: 'not_run', mode: 'real Harness agent with deterministic local model', realModelQualityMeasured: false };
try {
  const source = join(scratch, 'baseline'); await mkdir(source);
  const archive = join(scratch, 'baseline.tar');
  await exec('git', ['archive', '--format=tar', `--output=${archive}`, baseline], { cwd: root });
  await exec('tar', ['-xf', archive, '-C', source]);
  const sourceFingerprint = dependencyFingerprints(await readFile(join(source, 'package-lock.json'), 'utf8'));
  const candidateFingerprint = dependencyFingerprints(await readFile(join(root, 'package-lock.json'), 'utf8'));
  dependencyLockSha256 = candidateFingerprint.lockSha256;
  baselineDependencyLockSha256 = sourceFingerprint.lockSha256;
  dependencyGraphSha256 = candidateFingerprint.graphSha256;
  if (sourceFingerprint.graphSha256 !== dependencyGraphSha256) throw Error('Baseline and candidate resolved dependency graphs differ; provision matching runtimes before comparing them');
  await symlink(join(root, 'node_modules'), join(source, 'node_modules'), 'dir');
  before = await runCorpus(source, 'baseline', baseline);
  after = await runCorpus(root, 'candidate', candidate);
  if (!args.includes('--skip-native')) {
    const log = join(directory, 'native.log');
    try {
      const execution = await exec(process.execPath, ['scripts/native-fixture.mjs'], { cwd: root, env, timeout: 120000, maxBuffer: 500000 });
      await writeFile(log, (execution.stdout + execution.stderr).replace(/\?token=\S+/g, '?token=[redacted]'));
      const fixture = (await readFile(join(root, '.data/native-fixture-location.txt'), 'utf8')).trim();
      const snapshot = JSON.parse(await readFile(join(fixture, 'result.json'), 'utf8'));
      const fix = snapshot.jobs.find(j => j.kind === 'fix'), triage = snapshot.jobs.find(j => j.kind === 'triage');
      const evidence = fix?.result?.evidence.filter(e => e.source.startsWith('Harness')) ?? [];
      if (fix?.status !== 'awaiting_review' || triage?.status !== 'completed' || !evidence.some(e => e.detail.includes('REGRESSION_PASSED'))) throw Error('Native evidence incomplete');
      native = { ...native, status: 'passed', host: snapshot.capabilities.host, coveredStages: ['fix', 'triage'], fixStatus: fix.status, triageStatus: triage.status, metadataHasWorktree: !!triage.worktree, patch: fix.patch, toolEvidence: evidence };
    } catch (error) {
      const captured = String(error.stdout ?? '') + String(error.stderr ?? '') + '\n' + error.message;
      await writeFile(log, captured.replace(/\?token=\S+/g, '?token=[redacted]'));
      native = { ...native, status: 'failed', error: 'Native run failed; see native.log' };
    }
  }
  await writeFile(join(directory, 'native.json'), JSON.stringify(native, null, 2) + '\n');
} finally { await rm(scratch, { recursive: true, force: true }); }
const corpusHash = createHash('sha256').update(await readFile(join(root, 'tests/evaluation/corpus.ts'))).update(await readFile(join(root, 'tests/evaluation/run.ts'))).digest('hex');
const rows = after.cases.map(result => ({ id: result.id, title: result.title, category: result.category, baseline: before.cases.find(old => old.id === result.id)?.expectationSatisfied ?? null, candidate: result.expectationSatisfied, baselineMs: before.cases.find(old => old.id === result.id)?.durationMs ?? null, candidateMs: result.durationMs }));
const comparison = { schemaVersion: 1, generatedAt: new Date().toISOString(), corpusVersion: after.corpusVersion, corpusSha256: corpusHash, dependencyLockSha256, baselineDependencyLockSha256, dependencyGraphSha256, baselineCommit: baseline, candidateCommit: candidate, candidateHasUncommittedChanges: dirty, pinnedHarnessVersion: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).devDependencies['@deepseek-ai/dsh'], mode: after.mode, baseline: before.metrics, candidate: after.metrics, cases: rows, native, realModelEvaluation: { status: 'not_run', reason: 'Requires separately approved provider, model/reasoning, credential destination and spending budget', tokens: null, apiCostUsd: null, humanAcceptanceRate: null, falsePositiveRate: null }, limitations: after.limitations };
await writeFile(join(directory, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
const markdown = ['# Maintainer workflow evaluation', '', '**Deterministic contract checks, not a model-quality benchmark.**', '', `Baseline: ${baseline}`, `Candidate: ${candidate}${dirty ? ' (working tree had changes)' : ''}`, `Corpus SHA-256: ${corpusHash}`, '', `Workflow expectations: baseline ${before.metrics.passed}/${before.metrics.cases}; candidate ${after.metrics.passed}/${after.metrics.cases}`, `Native Harness integration: ${native.status} (real agent/tools, local scripted model; fix and triage only)`, '', '| Case | Baseline | Candidate |', '|---|---|---|', ...rows.map(row => `| ${row.id} | ${row.baseline ? 'PASS' : 'FAIL'} | ${row.candidate ? 'PASS' : 'FAIL'} |`), '', 'Detailed observed states, local command outputs, elapsed times and patches are in baseline.json and candidate.json. Single-run elapsed times include fixture setup and are not speed comparisons.', '', 'Real model acceptance, false-positive rate, tokens and API cost are not measured. Fixture cases and responses must not be presented as real model performance.', '', 'Paid API requests: 0. No external GitHub writes. Original fixtures are MIT-licensed; runtime/resource attribution remains in THIRD_PARTY_NOTICES.md.', ''];
await writeFile(join(directory, 'SUMMARY.md'), markdown.join('\n'));
console.log(`\nSaved evaluation: ${directory}\nContracts: ${before.metrics.passed}/${before.metrics.cases} → ${after.metrics.passed}/${after.metrics.cases}; native: ${native.status}; real model: not run`);
if (after.metrics.passed !== after.metrics.cases || native.status === 'failed') process.exitCode = 1;
