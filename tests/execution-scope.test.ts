import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { harnessRunner } from '../src/plugin/native-runner.ts';
import { handler, localRejection } from '../src/server/http.ts';
import { seedFixture } from './support/fixtures.ts';
import type { Job } from '../src/core/types.ts';

const claimedValidation = () => ({ schemaVersion: 1, stage: 'validate', summary: 'Model-reported checks', coverage: 'remote only', evidence: [], nextSteps: [], responseDraft: '', environment: 'no local runner', blockers: [], tests: [
  { command: 'npm test', status: 'passed', output: 'model claims success' },
  { command: 'npm run lint', status: 'failed', output: 'model claims failure' },
] });
const assertNotRun = (job: Pick<Job, 'artifact' | 'result'>) => {
  assert.ok(job.artifact && 'tests' in job.artifact);
  assert.deepEqual(job.artifact.tests.map(t => t.status), ['not_run', 'not_run']);
  assert.deepEqual(job.result?.tests.map(t => t.status), ['not_run', 'not_run']);
};

test('standalone test claims stay not_run in storage, JSON export, and stage handoff', async t => {
  const originalFetch = globalThis.fetch;
  const key = process.env.MAINTAINER_API_KEY;
  process.env.MAINTAINER_API_KEY = 'local-fixture-placeholder';
  const dir = await mkdtemp(join(tmpdir(), 'mw-scope-'));
  const store = new Store(':memory:'); seedFixture(store);
  const github = new GitHub('', async () => Response.json([]));
  github.profile = async repo => repo.profile!;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
    if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: JSON.stringify(claimedValidation()) } }] });
    assert.ok(url.startsWith('https://api.github.com/'), `unexpected destination ${url}`);
    return Response.json([]);
  };
  const w = new Workbench(store, dir, undefined, github, false);
  const server = createServer(handler(w, localRejection));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (key === undefined) delete process.env.MAINTAINER_API_KEY; else process.env.MAINTAINER_API_KEY = key;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await w.close(); await rm(dir, { recursive: true, force: true });
  });
  const id = w.enqueue([store.issues()[0].id], 'validate').created[0];
  w.pump(); await w.drain();
  const job = store.get<Job>('jobs', id)!;
  assert.equal(job.status, 'completed', job.error);
  assertNotRun(job);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const exported = await (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/maintainer/api/export/${id}`)).json();
  assertNotRun(exported);
  const next = w.enqueue([job.issueId], 'investigate', { sourceJobId: id }).created[0];
  const inherited = store.get<Job>('jobs', next)!.handoff!.find(h => h.id === id)!.artifact!;
  assert.ok('tests' in inherited);
  assert.deepEqual(inherited.tests.map(t => t.status), ['not_run', 'not_run']);
});

test('native metadata-only recovery normalizes the authoritative artifact before projection', async () => {
  let listener: (session: { id: string }, event: unknown) => void;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    llm: { listProviders: () => [{ id: 'fixture' }] },
    agentPresets: { resolve: async () => ({ id: 'standard' }) },
    permissionPresets: { resolve: () => {}, set: () => {} },
    workspaceRegistry: { create: async (path: string) => ({ path, attachSession: async () => {} }) },
    on: (_: string, fn: typeof listener) => { listener = fn; return () => {}; },
    agents: { create: async (options: any) => {
      await options.setup({ tools: { register: () => () => {}, schemas: () => [], restrict: () => {}, guard: () => {} } });
      return { dispose: async () => {}, agent: { session: {}, cancel: () => {}, whenIdle: async () => {}, followup: () => queueMicrotask(() => {
        listener({ id: options.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify(claimedValidation()) }] } } });
        listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      }) } };
    } },
  } as unknown as Context;
  const store = new Store(':memory:'); seedFixture(store);
  try {
    const repo = store.repos()[0], issue = store.issues()[0];
    const output = await harnessRunner(ctx, new GitHub('', async () => Response.json([])))({ repo, issue, related: [], job: { id: 'scope-native', repoId: repo.id, issueId: issue.id, kind: 'validate', status: 'running', revision: 'r', baseSha: repo.headSha, issueSnapshot: issue, attempt: 1, createdAt: 'now', updatedAt: 'now', analysisPath: '/tmp/scope-owned', formatOnly: true, rawOutput: 'recorded unverified output' }, settings: store.settings(), signal: new AbortController().signal, progress: () => {} });
    assertNotRun(output);
  } finally { store.close(); }
});
