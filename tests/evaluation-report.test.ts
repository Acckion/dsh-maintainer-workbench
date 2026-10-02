import test from 'node:test';
import assert from 'node:assert/strict';
import { corpus, corpusVersion } from './evaluation/corpus.ts';
import { validateReport } from './evaluation/report.ts';
function report() {
  return { schemaVersion: 1, corpusVersion, generatedAt: '2026-10-02T00:00:00Z', sourceCommit: 'a'.repeat(40), mode: 'deterministic-workflow-contracts', corpusDescription: 'scripted contracts, not quality', metrics: { cases: corpus.length, passed: corpus.length, paidApiRequests: 0, realModelTokens: null, realApiCostUsd: null, humanAcceptanceRate: null, realModelFalsePositiveRate: null }, cases: corpus.map(c => ({ ...c, expectationSatisfied: true, durationMs: 1, runnerInvocations: 1, testCommands: [], observations: {}, jobs: [] })), limitations: ['not model quality'] };
}
test('evaluation reports require complete unique cases and counts matching observed results', () => {
  assert.equal(validateReport(report()).metrics.passed, corpus.length);
  const duplicate = report(); duplicate.cases[1] = duplicate.cases[0]; assert.throws(() => validateReport(duplicate), /exactly once/);
  const inconsistent = report(); inconsistent.metrics.passed--; assert.throws(() => validateReport(inconsistent), /does not match/);
  const missing = report(); missing.cases.pop(); assert.throws(() => validateReport(missing));
});
test('deterministic evidence cannot silently become real-model cost or accuracy data', () => {
  for (const field of ['realModelTokens', 'realApiCostUsd', 'humanAcceptanceRate', 'realModelFalsePositiveRate']) {
    const sample = report(); Object.assign(sample.metrics, { [field]: 0.99 }); assert.throws(() => validateReport(sample));
  }
  const sample = report(); sample.metrics.paidApiRequests = 1; assert.throws(() => validateReport(sample));
});
test('failed evaluation cases keep evidence and cannot report impossible elapsed times', () => {
  const sample = report(); sample.cases[0].expectationSatisfied = false; sample.metrics.passed--;
  assert.throws(() => validateReport(sample), /retain the observed error/);
  Object.assign(sample.cases[0], { error: 'Observed forbidden artifact' }); assert.equal(validateReport(sample).metrics.passed, corpus.length - 1);
  sample.cases[0].durationMs = -1; assert.throws(() => validateReport(sample));
});

test('fixture subprocesses never inherit real provider, cloud, or GitHub credentials', async () => {
  const { fixtureEnvironment } = await import('./evaluation/environment.ts');
  const env = fixtureEnvironment({ PATH: '/owned/bin', HOME: '/real/home', GITHUB_TOKEN: 'sensitive-example', OPENAI_API_KEY: 'sensitive-example', AWS_SECRET_ACCESS_KEY: 'sensitive-example', UNRECOGNIZED_SECRET: 'sensitive-example', HTTP_PROXY: 'http://private-proxy.invalid' }, '/tmp/owned-fixture');
  assert.equal(env.PATH, '/owned/bin'); assert.equal(env.HOME, '/tmp/owned-fixture/home');
  assert.equal(env.GITHUB_TOKEN, 'deterministic-fixture-only');
  for (const key of ['OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'UNRECOGNIZED_SECRET', 'HTTP_PROXY']) assert.equal(env[key], undefined);
  assert.ok(!Object.values(env).includes('sensitive-example'));
});
