import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeReport, reportRecoveryBudget } from '../src/core/report-finalizer.ts';
import { ArtifactFormatError } from '../src/core/execution-errors.ts';
import { parseArtifact } from '../src/core/artifacts.ts';
import { modelRunner } from '../src/core/intelligence.ts';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { seedFixture } from './support/fixtures.ts';
import type { Job, Runner } from '../src/core/types.ts';

const triage = { schemaVersion: 1, stage: 'triage', summary: '需要调查', coverage: '仅元数据', evidence: [], nextSteps: [], responseDraft: '', category: 'bug', priority: 'P2', labels: [], module: 'unknown', impact: 'unknown', missingInfo: [], duplicateOf: null, duplicateReason: '', route: 'investigate', routeReason: '需要源码证据' };
const signal = new AbortController().signal;

test('report finalization repairs punctuation locally and supplies only the host envelope', async () => {
  const { schemaVersion, stage, ...body } = triage;
  const raw = JSON.stringify(body).replace(',"category":', '],"category":');
  let requests = 0;
  const artifact = await finalizeReport({ kind: 'triage', text: raw, budget: reportRecoveryBudget(), signal, progress: () => {}, recover: async () => { requests++; throw Error('unexpected request'); } });
  assert.deepEqual(artifact, triage);
  assert.equal(requests, 0);
});

test('initial and subsequent reports share one format recovery allowance', async () => {
  const budget = reportRecoveryBudget();
  let requests = 0;
  const finish = (text: string) => finalizeReport({ kind: 'triage' as const, text, budget, signal, progress: () => {}, recover: async () => { requests++; return parseArtifact('triage', triage); } });
  await finish('{"summary":"unfinished');
  await assert.rejects(finish('{"summary":"unfinished again'), error => error instanceof ArtifactFormatError && error.failure.kind === 'truncated' && error.failure.repairAttempts === 1);
  assert.equal(requests, 1);
});

test('failed recovery and formatting-only jobs cannot recursively request recovery', async () => {
  let requests = 0;
  await assert.rejects(finalizeReport({ kind: 'triage', text: '{}', budget: reportRecoveryBudget(), signal, progress: () => {}, recover: async () => { requests++; return {} as any; } }), ArtifactFormatError);
  assert.equal(requests, 1);
  await assert.rejects(finalizeReport({ kind: 'triage', text: '{}', budget: reportRecoveryBudget(true), signal, progress: () => {}, recover: async () => { requests++; return parseArtifact('triage', triage); } }), ArtifactFormatError);
  assert.equal(requests, 1);
});

test('truncated but syntactically valid responses are regenerated, and cancelled recovery stays cancelled', async () => {
  let failure: string | undefined;
  await finalizeReport({ kind: 'triage', text: JSON.stringify(triage), truncated: true, budget: reportRecoveryBudget(), signal, progress: () => {}, recover: async (_, kind) => { failure = kind; return parseArtifact('triage', triage); } });
  assert.equal(failure, 'truncated');
  const abort = new AbortController();
  const reason = new Error('user stopped task');
  await assert.rejects(finalizeReport({ kind: 'triage', text: '{}', budget: reportRecoveryBudget(), signal: abort.signal, progress: () => {}, recover: async () => { abort.abort(reason); throw reason; } }), error => error === reason);
});

test('invalid verdicts and conflicting envelope fields remain invalid after local parsing', async () => {
  for (const body of [{ ...triage, stage: 'fix' }, { ...triage, schemaVersion: 7 }, { ...triage, route: 'merge' }]) {
    await assert.rejects(finalizeReport({ kind: 'triage', text: JSON.stringify(body), budget: reportRecoveryBudget(true), signal, progress: () => {}, recover: async () => { throw Error('unexpected'); } }), error => error instanceof ArtifactFormatError && error.failure.kind === 'schema');
  }
});

for (const scenario of ['local', 'schema', 'truncated', 'invalid', 'http'] as const) test(`remote model report recovery is bounded and preserves original output: ${scenario}`, async t => {
  const store = new Store(':memory:'); seedFixture(store); t.after(() => store.close());
  const oldKey = process.env.MAINTAINER_API_KEY, oldFetch = globalThis.fetch;
  process.env.MAINTAINER_API_KEY = 'test-only';
  t.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.MAINTAINER_API_KEY; else process.env.MAINTAINER_API_KEY = oldKey; });
  const raw = scenario === 'local' ? JSON.stringify(triage).replace(',"category":', '],"category":') : scenario === 'truncated' ? JSON.stringify(triage) : '{}';
  const requests: any[] = [];
  globalThis.fetch = async (_, init) => {
    requests.push(JSON.parse(init!.body as string));
    if (scenario === 'http') return new Response('', { status: 503 });
    return Response.json({ choices: [{ message: { content: requests.length === 1 ? raw : scenario === 'invalid' ? '{}' : JSON.stringify(triage) }, finish_reason: requests.length === 1 && scenario === 'truncated' ? 'length' : 'stop' }], usage: { total_tokens: 9 } });
  };
  const issue = { ...store.issues()[0], comments: 0 };
  const now = new Date().toISOString();
  const job: Job = { id: 'remote', repoId: issue.repoId, issueId: issue.id, kind: 'triage', status: 'running', revision: 'r', baseSha: '', issueSnapshot: issue, attempt: 1, createdAt: now, updatedAt: now };
  const outputs: string[] = [];
  const input: Parameters<Runner>[0] = { repo: store.repos()[0], issue, related: [], job, settings: store.settings(), signal, progress: () => {}, recordOutput: text => outputs.push(text) };
  if (scenario === 'invalid') await assert.rejects(modelRunner(input), error => error instanceof ArtifactFormatError && error.failure.repairAttempts === 1);
  else if (scenario === 'http') await assert.rejects(modelRunner(input), /HTTP 503/);
  else { const result = await modelRunner(input); assert.equal(result.artifact?.stage, 'triage'); assert.equal(result.tokens, scenario === 'local' ? 9 : 18); }
  assert.equal(requests.length, scenario === 'local' || scenario === 'http' ? 1 : 2);
  assert.deepEqual(outputs, scenario === 'http' ? [] : [raw]);
  if (requests[1]) { assert.equal(requests[1].tools, undefined); assert.match(requests[1].messages[0].content, /FORMAT RECOVERY ONLY/); assert.ok(requests[1].messages[0].content.includes(raw)); }
});

test('remote failed report can be retried without refetching discussion or replaying the task', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mw-remote-report-'));
  const store = new Store(':memory:'); seedFixture(store);
  const issue = { ...store.issues()[0], comments: 0 }; store.put('issues', issue);
  store.put('repos', { ...store.repos()[0], mode: 'github', localPath: '' });
  const oldKey = process.env.MAINTAINER_API_KEY, oldFetch = globalThis.fetch;
  process.env.MAINTAINER_API_KEY = 'test-only';
  const requests: any[] = [];
  globalThis.fetch = async (_, init) => {
    requests.push(JSON.parse(init!.body as string));
    return Response.json({ choices: [{ message: { content: requests.length < 3 ? '{}' : JSON.stringify(triage) }, finish_reason: 'stop' }] });
  };
  const github = new GitHub('', async () => { throw Error('unexpected GitHub fetch'); });
  const w = new Workbench(store, root, undefined, github, false);
  t.after(async () => { await w.close(); await rm(root, { recursive: true, force: true }); globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.MAINTAINER_API_KEY; else process.env.MAINTAINER_API_KEY = oldKey; });
  w.enqueue([issue.id], 'triage'); w.pump(); await w.drain();
  const failed = store.jobs().at(-1)!;
  assert.equal(failed.status, 'failed'); assert.equal(failed.formatRecovery?.reason, 'schema'); assert.equal(failed.formatRecovery?.repairAttempts, 1);
  assert.equal(failed.analysisPath, undefined);
  w.retry(failed.id); w.pump(); await w.drain();
  const recovered = store.jobs().at(-1)!;
  assert.equal(recovered.status, 'completed', recovered.error); assert.equal(recovered.formatOnly, true); assert.equal(recovered.formatRecovery, undefined);
  assert.equal(requests.length, 3); assert.match(requests[2].messages[0].content, /FORMAT RECOVERY ONLY/); assert.equal(requests[2].messages.length, 1);
  assert.equal(store.get<Job>('jobs', failed.id)!.rawOutput, '{}');
});
