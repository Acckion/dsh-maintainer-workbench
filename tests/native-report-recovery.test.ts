import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { harnessRunner } from '../src/plugin/native-runner.ts';
import { ArtifactFormatError } from '../src/core/execution-errors.ts';
import { git } from '../src/core/git.ts';
import { GitHub } from '../src/core/github.ts';
import { Store } from '../src/core/store.ts';
import { seedFixture } from './support/fixtures.ts';
import type { Job } from '../src/core/types.ts';
import { executionRecord } from '../src/core/execution-evidence.ts';

const review = { schemaVersion: 1, stage: 'review', summary: '尚未完成源码核验', coverage: '没有源码执行证据', evidence: [], nextSteps: [], responseDraft: '', inspectedSources: [], findings: [], followups: [], verdict: 'incomplete', blockers: ['源码证据不足'] };

test('native saved-report retry exposes original IDs and rejects aliases before concluding the report', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mw-saved-report-'));
  await git(root, ['init', '-b', 'main']); await writeFile(join(root, 'core.ts'), 'export const sum = 1;\n');
  await git(root, ['add', '.']); await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
  const store = new Store(':memory:'); seedFixture(store);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const issue = { ...store.issues()[0], comments: 0 }, repo = store.repos()[0], now = new Date().toISOString();
  const job: Job = { id: 'saved-report', repoId: repo.id, issueId: issue.id, issueSnapshot: issue, kind: 'review', status: 'running', revision: 'r', baseSha: await git(root, ['rev-parse', 'HEAD']), attempt: 2, createdAt: now, updatedAt: now, worktree: root, formatOnly: true, sessionId: 'original-session', patchSha256: 'patch', rawOutput: '{}' };
  const record = executionRecord(job, 'original-session', 24, { name: 'read', arguments: '{"path":"core.ts"}' }, { message: { toolCallId: 'call-source', content: [{ text: '1: export const sum = 1;' }] } }, 'patch');
  job.executionRecords = [record];
  const listeners = new Set<any>(); let tool: any, concluded = 0, sessions = 0;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, llm: { listProviders: () => [{ id: 'p' }] },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => { throw Error('no execution tools in format retry'); } },
    permissionPresets: { resolve: () => {}, set: () => {} }, workspaceRegistry: { archiveSession: async () => {} },
    on: (name: string, fn: any) => { if (name === 'session/event') listeners.add(fn); return () => listeners.delete(fn); },
    agents: { create: async (options: any) => {
      sessions++;
      await options.setup({ tools: { register: (definition: any) => { tool = definition; }, schemas: () => [], restrict: () => {}, guard: () => {} } });
      return { dispose: async () => {}, agent: { session: {}, cancel: () => {}, whenIdle: async () => {}, followup: (message: any) => queueMicrotask(async () => {
        try {
          assert.match(message.content[0].text, /original-session:24/);
          const report = { reportFormat: 'compact-v1', summary: '部分审查', coverage: 'core', inspectedSources: [{ executionId: 'read-core-src', path: 'core.ts', line: 1, quote: 'export const sum = 1;' }], findings: [], verdict: 'incomplete', blockers: ['未完成'] };
          const exec = { signal: new AbortController().signal, concludeTurn: () => { concluded++; } };
          await assert.rejects(tool.execute({ report }, exec), error => error instanceof Error && /read-core-src/.test(error.message) && /original-session:24/.test(error.message));
          assert.equal(concluded, 0);
          report.inspectedSources[0].executionId = record.id;
          await tool.execute({ report }, exec);
          for (const listener of [...listeners]) listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
        } catch (error) { for (const listener of [...listeners]) listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'error', error: String(error) } } }); }
      }) } };
    } },
  } as unknown as Context;
  const output = await harnessRunner(ctx, new GitHub('', async () => Response.json([])))({ repo, issue, related: [], job, settings: store.settings(), signal: new AbortController().signal, progress: () => {} });
  assert.equal(output.artifact?.stage === 'review' && output.artifact.inspectedSources?.[0].executionId, record.id);
  assert.equal(sessions, 1); assert.equal(concluded, 1);
});

for (const kind of ['triage', 'investigate', 'fix'] as const) test(`native output-limit recovery distinguishes report generation from execution: ${kind}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mw-native-truncation-'));
  if (kind === 'fix') { await git(root, ['init', '-b', 'main']); await writeFile(join(root, 'value.txt'), 'before'); await git(root, ['add', '.']); await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'baseline']); }
  const store = new Store(':memory:'); seedFixture(store);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const listeners = new Set<any>(); let sessions = 0;
  const triage = { schemaVersion: 1, stage: 'triage', summary: '需要调查', coverage: '仅元数据', evidence: [], nextSteps: [], responseDraft: '', category: 'bug', priority: 'P2', labels: [], module: 'unknown', impact: 'unknown', missingInfo: [], duplicateOf: null, duplicateReason: '', route: 'investigate', routeReason: '需要源码证据' };
  const report = kind === 'investigate' ? { schemaVersion: 1, stage: 'investigate', summary: '仍需源码证据', coverage: '没有本地源码证据', evidence: [], nextSteps: [], responseDraft: '', facts: [], hypotheses: [], reproduction: '未复现', rootCause: 'unknown', impact: 'unknown', proposedChanges: [], acceptanceCriteria: [], blockers: ['源码证据不足'] } : triage;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, llm: { listProviders: () => [{ id: 'p' }] },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => {} }, permissionPresets: { resolve: () => {}, set: () => {} },
    workspaceRegistry: { create: async () => ({ attachSession: async () => {} }), archiveSession: async () => {} },
    on: (name: string, fn: any) => { if (name === 'session/event') listeners.add(fn); return () => listeners.delete(fn); },
    agents: { create: async (options: any) => {
      const first = ++sessions === 1;
      await options.setup({ tools: { register: () => () => {}, schemas: () => [], restrict: () => {}, guard: () => {} } });
      return { dispose: async () => {}, agent: { session: {}, cancel: () => {}, whenIdle: async () => {}, followup: () => queueMicrotask(() => {
        for (const listener of [...listeners]) {
          listener({ id: options.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: kind === 'fix' ? '实施尚未完成' : JSON.stringify(report) }] } } });
          listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: first ? 'max-tokens' : 'completed' } } });
        }
      }) } };
    } },
  } as unknown as Context;
  const issue = { ...store.issues()[0], comments: 0 }, repo = store.repos()[0], now = new Date().toISOString();
  const job: Job = { id: 'native-truncated', repoId: repo.id, issueId: issue.id, issueSnapshot: issue, kind, status: 'running', revision: 'r', baseSha: kind === 'fix' ? await git(root, ['rev-parse', 'HEAD']) : '', attempt: 1, createdAt: now, updatedAt: now, ...(kind === 'fix' ? { worktree: root } : { analysisPath: root }) };
  const run = () => harnessRunner(ctx, new GitHub('', async () => Response.json([])))({ repo, issue, related: [], job, settings: store.settings(), signal: new AbortController().signal, progress: () => {} });
  if (kind === 'fix') { await assert.rejects(run(), error => error instanceof Error && !(error instanceof ArtifactFormatError)); assert.equal(sessions, 1); assert.equal(await readFile(join(root, 'value.txt'), 'utf8'), 'before'); }
  else { const output = await run(); assert.equal(output.artifact?.stage, kind); assert.equal(sessions, 2); }
});

for (const initialBroken of [false, true]) test(`native evidence-repair report shares the initial format budget: initial broken ${initialBroken}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mw-native-report-'));
  await git(root, ['init', '-b', 'main']); await writeFile(join(root, 'value.txt'), 'before'); await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'baseline']);
  const sha = await git(root, ['rev-parse', 'HEAD']);
  const store = new Store(':memory:'); seedFixture(store);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const listeners = new Set<any>();
  let sessions = 0, originalTurns = 0, formatTurns = 0, restricted = 0;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, llm: { listProviders: () => [{ id: 'p' }] },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => {} },
    permissionPresets: { resolve: () => {}, set: () => {} },
    workspaceRegistry: { create: async () => ({ attachSession: async () => {} }), archiveSession: async () => {} },
    on: (name: string, fn: any) => { if (name === 'session/event') listeners.add(fn); return () => listeners.delete(fn); },
    agents: { create: async (options: any) => {
      const original = ++sessions === 1;
      await options.setup({ tools: { register: () => () => {}, schemas: () => [{ name: 'read' }], restrict: (value: any) => { assert.deepEqual(value, { allow: [] }); restricted++; }, guard: () => {} } });
      return { dispose: async () => {}, agent: { session: {}, cancel: () => {}, whenIdle: async () => {}, followup: () => {
        const text = original ? (++originalTurns === 1 && !initialBroken ? JSON.stringify(review) : '{}') : (++formatTurns, JSON.stringify(review));
        queueMicrotask(() => { for (const listener of [...listeners]) { listener({ id: options.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }); listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }); } });
      } } };
    } },
  } as unknown as Context;
  const issue = { ...store.issues()[0], comments: 0 }, repo = store.repos()[0], now = new Date().toISOString();
  const job: Job = { id: 'native-report', repoId: repo.id, issueId: issue.id, issueSnapshot: issue, kind: 'review', status: 'running', revision: 'r', baseSha: sha, attempt: 1, createdAt: now, updatedAt: now, worktree: root, reviewRequiredSources: [] };
  const run = () => harnessRunner(ctx, new GitHub('', async () => Response.json([])))({ repo, issue, related: [], job, settings: store.settings(), signal: new AbortController().signal, progress: () => {} });
  if (initialBroken) await assert.rejects(run(), error => error instanceof ArtifactFormatError && error.failure.repairAttempts === 1);
  else { const output = await run(); assert.equal(output.artifact?.stage, 'review'); assert.equal(output.artifact?.summary, review.summary); }
  assert.equal(originalTurns, 2); assert.equal(formatTurns, 1); assert.equal(sessions, 2); assert.equal(restricted, 1);
  assert.equal(await readFile(join(root, 'value.txt'), 'utf8'), 'before');
  assert.equal(listeners.size, 0);
});
