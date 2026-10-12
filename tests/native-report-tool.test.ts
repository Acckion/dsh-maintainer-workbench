import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { ArtifactFormatError } from '../src/core/execution-errors.ts';
import { harnessRunner } from '../src/plugin/native-runner.ts';
import { Store } from '../src/core/store.ts';
import { seedFixture } from './support/fixtures.ts';
import { GitHub } from '../src/core/github.ts';

const report = { reportFormat: 'compact-v1', summary: '需调查', coverage: '仅元数据', category: 'bug', priority: 'P2', labels: [], module: 'tui', impact: 'unknown', missingInfo: [], duplicateOf: null, duplicateReason: '', route: 'investigate', routeReason: '需源码证据' };

for (const mode of ['tool', 'text', 'invalid'] as const) test(`native compact report supports ${mode} submission without mounting coding tools`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mw-report-tool-'));
  const store = new Store(':memory:'); seedFixture(store); t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const issue = { ...store.issues()[0], comments: 0, body: 'const value = "C:\\tmp";\nconst literal = "\\n";' }, repo = store.repos()[0];
  let listener: any, tool: any, stream: any, requestError: any; const guards: any[] = [], texts: string[] = [], raw: string[] = []; let mounted = 0, turns = 0;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, llm: { listProviders: () => [{ id: 'p' }] },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => { mounted++; } },
    permissionPresets: { resolve: () => {}, set: () => {} }, workspaceRegistry: { archiveSession: async () => {} },
    on: (name: string, fn: any) => { if (name === 'session/event') listener = fn; if (name === 'llm/stream') stream = fn; if (name === 'agent/request-error') requestError = fn; return () => {}; },
    agents: { create: async (options: any) => {
      await options.setup({ tools: { register: (definition: any) => { tool = definition; return () => {}; }, schemas: () => [tool], restrict: (restriction: any) => assert.deepEqual(restriction, { allow: [] }), guard: (guard: any) => guards.push(guard) } });
      return { dispose: async () => {}, agent: { session: {}, cancel: () => {}, whenIdle: async () => {}, followup: (message: any) => {
        turns++; texts.push(message.content[0].text);
        queueMicrotask(async () => {
          try {
            listener({ id: options.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: mode === 'tool' ? '' : JSON.stringify(report) }] } } });
            if (mode === 'invalid') {
              for (let attempt = 0; attempt < 2; attempt++) {
                assert.ok(guards.every(guard => !guard({ name: 'submit_stage_report', arguments: { report: {} } })));
                await assert.rejects(tool.execute({ report: {} }, { signal: new AbortController().signal, concludeTurn: () => { throw Error('invalid report concluded'); } }));
              }
              const chunks = [];
              for await (const chunk of stream({ sessionId: options.sessionId }, () => { throw Error('extra model request'); })) chunks.push(chunk);
              assert.equal(chunks[0].reason.failure.code, 'WORKBENCH_REPORT_LIMIT');
              assert.equal(await requestError({ agent: { session: { id: options.sessionId } }, failure: chunks[0].reason.failure }, () => { throw Error('default recovery must not retry report limit'); }), undefined);
              listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: chunks[0].reason } });
              return;
            }
            if (mode === 'tool') {
              const execution = { name: 'submit_stage_report', arguments: { report } };
              assert.ok(guards.every(guard => !guard(execution)));
              let concluded = false;
              const receipt = await tool.execute({ report: { ...report, inputRequest: null } }, { signal: new AbortController().signal, concludeTurn: () => { concluded = true; } });
              assert.deepEqual(receipt, { received: true }); assert.equal(concluded, true);
            }
            listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          } catch (error) { listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: String(error) } } } }); }
        });
      } } };
    } },
  } as unknown as Context;
  const now = new Date().toISOString();
  const run = () => harnessRunner(ctx, new GitHub('', async () => Response.json([])))({ repo, issue, related: [], job: { id: 'report-tool', repoId: repo.id, issueId: issue.id, issueSnapshot: issue, kind: 'triage', status: 'running', baseSha: '', revision: 'r', attempt: 1, createdAt: now, updatedAt: now, analysisPath: root }, settings: store.settings(), signal: new AbortController().signal, progress: () => {}, recordOutput: text => raw.push(text) });
  if (mode === 'invalid') { await assert.rejects(run(), ArtifactFormatError); assert.equal(turns, 1); assert.equal(mounted, 0); assert.equal(raw[0], '{}'); return; }
  const result = await run();
  assert.equal(result.artifact?.stage, 'triage'); assert.equal(result.result.summary, report.summary);
  assert.equal(mounted, 0); assert.equal(turns, 1); assert.ok(texts[0].includes(issue.body));
  assert.doesNotMatch(texts[0], /UNTRUSTED_INPUT_JSON/); assert.ok(raw[0].includes('compact-v1'));
  assert.equal(tool.parameters.properties.report.properties.reportFormat.const, 'compact-v1');
  assert.ok(guards.some(guard => guard({ name: 'bash', arguments: { command: 'echo forbidden' } })));
});
