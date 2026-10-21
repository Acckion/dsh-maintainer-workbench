import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context as CordisContext, type Context } from '@deepseek-ai/cordis';
import { ArtifactFormatError } from '../src/core/execution-errors.ts';
import { harnessRunner } from '../src/plugin/native-runner.ts';
import { Store } from '../src/core/store.ts';
import { seedFixture } from './support/fixtures.ts';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { createScope } from '@deepseek-ai/dsh-scope';
import { reportTool } from '../src/plugin/report-tool.ts';
import { platformShellTool } from '../src/core/shell-tools.ts';
import { git } from '../src/core/git.ts';
import { GitHub } from '../src/core/github.ts';

const report = { reportFormat: 'compact-v1', summary: '需调查', coverage: '仅元数据', category: 'bug', priority: 'P2', labels: [], module: 'tui', impact: 'unknown', missingInfo: [], duplicateOf: null, duplicateReason: '', route: 'investigate', routeReason: '需源码证据', evidence: [{ source: 'Issue body', detail: '用户报告终端主题问题' }] };

for (const mode of ['tool', 'text', 'invalid'] as const) test(`native compact report supports ${mode} submission without mounting coding tools`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mw-report-tool-'));
  const store = new Store(':memory:'); seedFixture(store); t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const issue = { ...store.issues()[0], comments: 0, body: 'const value = "C:\\tmp";\nconst literal = "\\n";' }, repo = store.repos()[0];
  let listener: any, tool: any, stream: any, requestError: any; const guards: any[] = [], texts: string[] = [], raw: string[] = []; let mounted = 0, turns = 0;
  // Exercise actual scoped registry visibility, rather than a permissive tool mock.
  const registryContext = new CordisContext();
  new SystemPrompt(registryContext, SystemPrompt.Config({})); new ToolRuntime(registryContext);
  const key = {}, scope = createScope(registryContext, key);
  const removeInherited = registryContext.tools.register({ ...reportTool('triage', () => {}), name: 'inherited_probe' });
  t.after(async () => { await scope.dispose(); removeInherited(); });
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, llm: { listProviders: () => [{ id: 'p' }] },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => { mounted++; } },
    permissionPresets: { resolve: () => {}, set: () => {} }, workspaceRegistry: { archiveSession: async () => {} },
    on: (name: string, fn: any) => { if (name === 'session/event') listener = fn; if (name === 'llm/stream') stream = fn; if (name === 'agent/request-error') requestError = fn; return () => {}; },
    agents: { create: async (options: any) => {
      await options.setup({ tools: {
        register: (definition: any) => { tool = definition; return scope.ctx.tools.register(definition); },
        schemas: () => scope.ctx.tools.schemas(key),
        restrict: (restriction: any) => { assert.deepEqual(restriction, { allow: [] }); return scope.ctx.tools.restrict(restriction); },
        guard: (guard: any) => { guards.push(guard); return scope.ctx.tools.guard(guard); },
      } });
      assert.deepEqual(scope.ctx.tools.schemas(key).map(tool => tool.name), ['submit_stage_report']);
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
  assert.deepEqual(result.artifact?.evidence, report.evidence);
  assert.equal(mounted, 0); assert.equal(turns, 1); assert.ok(texts[0].includes(issue.body));
  assert.doesNotMatch(texts[0], /UNTRUSTED_INPUT_JSON/); assert.ok(raw[0].includes('compact-v1'));
  assert.equal(tool.parameters.properties.report.oneOf[0].properties.reportFormat.const, 'compact-v1');
  assert.deepEqual(tool.parameters.properties.report.oneOf[1], { type: 'string' });
  assert.ok(guards.some(guard => guard({ name: 'bash', arguments: { command: 'echo forbidden' } })));
});

test('submit_stage_report accepts a JSON-string report argument', async () => {
  let received: unknown;
  const tool: any = reportTool('triage', value => { received = value; });
  let concluded = false;
  const exec = () => ({ signal: new AbortController().signal, concludeTurn: () => { concluded = true; } });
  assert.deepEqual(await tool.execute({ report: JSON.stringify(report) }, exec()), { received: true });
  assert.equal(concluded, true); assert.deepEqual(received, report);
  await assert.rejects(() => tool.execute({ report: '{bad json' }, exec()), /JSON 对象或可解析的 JSON 字符串/);
  await assert.rejects(() => tool.execute({ report: '"just a string"' }, exec()), /解析结果必须是对象/);
});

for (const kind of ['fix', 'docs', 'validate'] as const) test(`${kind} preserves its report tool and budget after premature submissions, with patch-bound checks`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mw-report-phase-'));
  const store = new Store(':memory:'); seedFixture(store);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'before\n');
  await writeFile(join(root, '.gitignore'), 'README.md\n');
  await git(root, ['add', '.gitignore']); await git(root, ['add', '-f', 'README.md']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'baseline']);
  const baseSha = await git(root, ['rev-parse', 'HEAD']);
  if (kind === 'validate') await writeFile(join(root, 'README.md'), 'after\n');
  const listeners = new Map<string, any>(), guards: any[] = [], records: any[] = [];
  let reportDefinition: any, turns = 0, seq = 0, submitted = false;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, llm: { listProviders: () => [{ id: 'p' }] },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => {} },
    permissionPresets: { defaultPreset: 'workspace-write', resolve: () => {}, set: () => {} },
    workspaceRegistry: { create: async (path: string) => ({ path, attachSession: async () => {} }) },
    on: (name: string, fn: any) => { listeners.set(name, fn); return () => listeners.delete(name); },
    agents: { create: async (options: any) => {
      await options.setup({ tools: {
        register: (definition: any) => { if (definition.name === 'submit_stage_report') reportDefinition = definition; return () => {}; },
        schemas: () => [reportDefinition, { name: platformShellTool() }], guard: (guard: any) => guards.push(guard),
        restrict: (restriction: any) => assert.ok(restriction.allow.includes(platformShellTool()) && !restriction.allow.includes('submit_stage_report')),
      } });
      const emit = (event: any) => listeners.get('session/event')({ id: options.sessionId }, event);
      const execute = async (command: string, output = 'PASS', action?: () => Promise<void>) => {
        const callId = `call${++seq}`, args = { command };
        emit({ type: 'tool/call', data: { name: 'bash', callId, arguments: JSON.stringify(args) } });
        const execution = { callId, agent: { session: { id: options.sessionId } }, arguments: args };
        const next = async () => {
          if (kind !== 'validate') assert.equal(await git(root, ['diff', '--cached', '--name-only']), '', 'evidence snapshots must not stage the agent worktree');
          await action?.(); return { value: { exitCode: 0, stdout: { text: output } } }; };
        const result = listeners.has('tools/execute') ? await listeners.get('tools/execute')(execution, next) : await next();
        listeners.get('tools/result')(execution, result);
        emit({ seq, type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: output }] } } });
        return `${options.sessionId}:${seq}`;
      };
      let checkId: string;
      return { dispose: async () => {}, agent: { session: {}, cancel: () => {}, whenIdle: async () => {}, followup: () => {
        turns++;
        queueMicrotask(async () => {
          try {
            if (turns === 1) {
              for (let i = 0; i < 2; i++) assert.match(guards[0]({ name: 'submit_stage_report', arguments: { report: {} } }), /执行阶段尚未结束/);
              let modelRequests = 0;
              for await (const _ of listeners.get('llm/stream')({ sessionId: options.sessionId }, async function* () { modelRequests++; })) {}
              assert.equal(modelRequests, 1, 'phase rejections must not block the next model request');
              if (kind !== 'validate') {
                await execute('node baseline-check');
                await execute('node update-document', 'edited', () => writeFile(join(root, 'README.md'), 'after\n'));
              }
              checkId = await execute('git diff --check');
              if (kind === 'docs') await execute('node link-check', 'DOCUMENT_LINKS_VERIFIED');
            } else {
              const value = { reportFormat: 'compact-v1', summary: '完成', coverage: '当前补丁检查', tests: [{ executionId: checkId }],
                ...(kind === 'validate' ? { environment: 'local', blockers: [] } : { changes: ['更新 README'], acceptanceCriteria: [], limitations: [] }) };
              assert.ok(guards.every(guard => !guard({ name: 'submit_stage_report', arguments: { report: value } })));
              await reportDefinition.execute({ report: value }, { signal: new AbortController().signal, concludeTurn: () => { submitted = true; } });
            }
            emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
          } catch (error) { emit({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: String(error) } } } }); }
        });
      } } };
    } },
  } as unknown as Context;
  const issue = { ...store.issues()[0], comments: 0 }, repo = store.repos()[0], now = new Date().toISOString();
  const output = await harnessRunner(ctx, new GitHub('', async () => Response.json([])))({ repo, issue, related: [],
    job: { id: `phase-${kind}`, repoId: repo.id, issueId: issue.id, issueSnapshot: issue, kind, status: 'running', baseSha, revision: 'r', attempt: 1, createdAt: now, updatedAt: now, worktree: root },
    settings: store.settings(), signal: new AbortController().signal, progress: () => {}, recordExecution: record => records.push(record) });
  assert.equal(turns, 2); assert.equal(submitted, true);
  assert.equal(output.artifact && 'tests' in output.artifact && output.artifact.tests[0].status, 'passed');
  if (kind !== 'validate') {
    assert.ok(records[0].patchHash); assert.ok(records[2].patchHash);
    assert.notEqual(records[0].patchHash, records[2].patchHash, 'baseline evidence is a different patch');
    assert.equal(records[1].patchHash, undefined, 'commands which mutate the patch are not verification');
  }
  assert.equal(listeners.size, 0);
});
