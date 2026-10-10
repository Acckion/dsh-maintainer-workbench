import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/core/git.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactSchemas } from '../src/core/artifacts.ts';
import { reviewPromptHandoff } from '../src/core/review-context.ts';
import { harnessRunner } from '../src/plugin/native-runner.ts';
import { GitHub } from '../src/core/github.ts';
import { Store } from '../src/core/store.ts';
import { seedFixture } from './support/fixtures.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { Job } from '../src/core/types.ts';

test('review handoff preserves followup identities without reusable tool references or coverage claims', () => {
  const sourceEvidence = { executionId: 'call_oldRead', path: 'src/chunk.ts', line: 8, quote: 'return items.slice(0, size - 1);' };
  const artifact = artifactSchemas.review.parse({ schemaVersion: 1, stage: 'review', summary: 'Historical claim call_oldRead', coverage: 'Already inspected all tests', evidence: [{ source: 'maintainer-old:19', detail: 'old output' }], nextSteps: [], responseDraft: '', inspectedSources: [sourceEvidence], findings: [{ id: 'F1', title: 'Drops items', severity: 'P2', path: 'src/chunk.ts', line: 8, trigger: 'size=2', evidence: 'historical source', recommendation: 'Restore bound', sourceEvidence, reproduction: { input: '[1,2]', expected: '[1,2]', actual: '[1]', basis: 'executed', executionId: 'maintainer-old:19' } }], verdict: 'changes_requested', blockers: [] });
  const handoff: Job['handoff'] = [{ id: 'old-job', kind: 'review', revision: 'sha', stale: false, artifact, feedback: 'Check call_oldRead', findings: { F1: 'needs_evidence' } }];
  const before = JSON.stringify(handoff);
  const projected = reviewPromptHandoff(handoff)!;
  assert.equal(projected[0].sourceJobId, 'old-job');
  assert.equal(projected[0].findings[0].id, 'F1');
  assert.equal(projected[0].findings[0].decision, 'needs_evidence');
  assert.equal(projected[0].evidenceStatus, 'historical_unverified');
  assert.equal(projected[0].findings[0].line, 8);
  assert.doesNotMatch(JSON.stringify(projected), /call_oldRead|maintainer-old:19|Already inspected|executionId|sourceEvidence|reproduction/);
  assert.equal(JSON.stringify(handoff), before);
  assert.equal(reviewPromptHandoff(undefined), undefined);
});

for (const [kind, denied, patched] of [['review', false, false], ['fix', false, false], ['fix', true, false], ['fix', false, true], ['validate', false, false], ['validate', true, false]] as const) test(`default native ${kind} uses sanitized handoff and bounded completion (denied=${denied}, patched=${patched})`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mw-review-repair-')); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']); await writeFile(join(root, 'chunk.ts'), 'source\n'); await git(root, ['add', '.']); await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
  const sha = await git(root, ['rev-parse', 'HEAD']);
  const store = new Store(':memory:'); seedFixture(store);
  let listener: any; let busy = false; const requestTexts: string[] = [];
  const artifact = artifactSchemas.review.parse({ schemaVersion: 1, stage: 'review', summary: 'Historical report', coverage: 'Old source read', evidence: [], nextSteps: [], responseDraft: '', findings: [], inspectedSources: [{ executionId: 'call_oldRead', path: 'src/chunk.ts', line: 8, quote: 'source' }], verdict: 'incomplete', blockers: ['fixture only'] });
  const outputArtifact = kind === 'review' ? artifact : kind === 'validate' ? artifactSchemas.validate.parse({ schemaVersion: 1, stage: 'validate', summary: 'Claim only fixture', coverage: '', evidence: [], nextSteps: [], responseDraft: '', environment: 'fixture', tests: [], blockers: [] }) : artifactSchemas.fix.parse({ schemaVersion: 1, stage: 'fix', summary: 'Claim only fixture', coverage: '', evidence: [], nextSteps: [], responseDraft: '', changes: ['claimed edit'], acceptanceCriteria: [], limitations: [], tests: [] });
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    llm: { listProviders: () => [{ id: 'fixture' }] },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => {} },
    permissionPresets: { resolve: () => {}, set: () => {} },
    workspaceRegistry: { create: async (path: string) => ({ path, attachSession: async () => {} }) },
    on: (name: string, callback: any) => { if (name === 'session/event') listener = callback; return () => {}; },
    agents: { create: async (options: any) => {
      await options.setup({ tools: { register: () => () => {}, schemas: () => [{ name: 'read' }], get: (name: string) => name === 'read' ? { name } : undefined, restrict: (filter: { allow: string[] }) => { assert.ok(filter.allow.every(name => name === 'read')); }, guard: () => {} } });
      return { dispose: async () => {}, agent: { session: {}, cancel: () => {}, whenIdle: () => new Promise<void>(resolve => setImmediate(() => { busy = false; resolve(); })), followup: (message: any) => {
        assert.equal(busy, false, 'followup must wait for host driver idle, not just turn/end'); busy = true;
        requestTexts.push(message.content[0].text);
        queueMicrotask(async () => {
          if (patched && requestTexts.length === 1) await writeFile(join(root, 'chunk.ts'), 'fixed source\n');
          if (denied) listener({ id: options.sessionId }, { type: 'approval/decided', data: { outcome: 'rejected' } });
          listener({ id: options.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify(outputArtifact) }] } } });
          listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
        });
      } } };
    } },
  } as unknown as Context;
  try {
    const repo = store.repos()[0], issue = store.issues()[0];
    const job = { id: 'default-review', issueSnapshot: issue, attempt: 1, kind, worktree: root, baseSha: sha, reviewRequiredSources: ['chunk.ts'], handoff: [{ id: 'old-job', kind: 'review', revision: 'sha', artifact }] } as Job;
    await harnessRunner(ctx, new GitHub('', async () => Response.json([])))({ repo, issue, related: [], job, settings: store.settings(), signal: new AbortController().signal, progress: () => {} });
    assert.equal(requestTexts.length, kind === 'review' ? 2 : denied || patched ? 2 : 3, 'at most one completion; permission rejection prevents implementation retry');
    if (!denied && !patched) assert.match(requestTexts[1], kind === 'review' ? /EVIDENCE REPAIR, one attempt only/ : kind === 'validate' ? /VALIDATION EXECUTION, one attempt only/ : /IMPLEMENTATION COMPLETION, one attempt only/);
    if (kind === 'fix' || kind === 'validate') {
      assert.match(requestTexts.at(-1)!, /REPORT PHASE/);
      if (patched) assert.match(requestTexts.at(-1)!, /an actual worktree patch/);
      assert.doesNotMatch(requestTexts[0], /stage:\s*"fix"/);
      assert.match(requestTexts[0], /EXECUTION PHASE/);
    }
    const requestText = requestTexts[0];
    if (kind === 'review') assert.match(requestText, /Session maintainer-default-review/);
    assert.match(requestText, kind === 'review' ? /changed source, and relevant existing tests/ : kind === 'validate' ? /supplied patch already applied/ : /actual edits in the dedicated worktree/);
    const input = JSON.parse(requestText.split('UNTRUSTED_INPUT_JSON:\n')[1]);
    if (kind !== 'validate') assert.equal(input.handoff[0].sourceJobId, 'old-job');
    if (kind !== 'validate') assert.equal(input.handoff[0].evidenceStatus, 'historical_unverified');
    assert.equal(input.instructions, undefined);
    assert.doesNotMatch(requestText, /call_oldRead|Old source read/);
  } finally { store.close(); }
});
