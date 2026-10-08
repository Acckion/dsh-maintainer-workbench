import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { hostStatus, harnessRunner } from '../src/plugin/native-runner.ts';
import { Credentials } from '../src/core/credentials.ts';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { fixtureAnalysis, seedFixture, fixtureRunner } from './support/fixtures.ts';

test('new native jobs inherit changing host model/reasoning and default preset, including metadata-only work', async () => {
  let selection = { provider: 'host-a', model: 'model-a', reasoningEffort: 'high' };
  const calls: any[] = []; let listener: any; const texts: string[] = []; const permissions: string[] = [];
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ ...selection }) },
    llm: { listProviders: () => [{ id: selection.provider }] },
    agentPresets: { defaultId: 'host-standard', resolve: async (id?: string) => ({ id: id ?? 'host-standard' }), mount: async (_: unknown, id: string) => { calls.at(-1).preset = id; } },
    permissionPresets: { resolve: (p: string) => permissions.push(p), set: () => {} },
    workspaceRegistry: { create: async (path: string) => ({ path, attachSession: async () => {} }) },
    on: (_: string, fn: any) => { listener = fn; return () => {}; },
    agents: { create: async (options: any) => { calls.push(options); await options.setup({ tools: { restrict: (v: unknown) => { calls.at(-1).restriction = v; }, guard: () => {} } }); return { dispose: async () => {}, agent: { session: {}, cancel: () => {}, followup: (message: unknown) => { texts.push(JSON.stringify(message)); queueMicrotask(() => { listener({ id: options.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ schemaVersion:1, stage:'triage', summary:'triage', coverage:'metadata', evidence:[], nextSteps:[], responseDraft:'draft', category:'bug', priority:'P2', labels:[], module:'unknown', impact:'unknown', missingInfo:[], duplicateOf:null, duplicateReason:'', route:'investigate', routeReason:'needs evidence' }).replace(',"category":', '],"category":') }] } } }); listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }); }); } } }; } }
  } as unknown as Context;
  const dir = await mkdtemp(join(tmpdir(), 'maintainer-inherit-')); const store = new Store(':memory:');
  const github = new GitHub('', async () => Response.json([]));
  const w = new Workbench(store, dir, harnessRunner(ctx, github), github, false, () => hostStatus(ctx)); seedFixture(store);
  const issue = store.issues()[0], repo = store.repos()[0], result = fixtureAnalysis(issue, 'triage');
  store.put('repos', { ...repo, mode: 'github', localPath: '' });
  w.updateSettings({ ...store.settings(), provider: 'wrong-provider', model: 'wrong-model', agentPreset: 'inherit' });
  w.enqueue([issue.id], 'triage'); w.pump(); await w.drain();
  assert.equal(store.jobs()[0].status, 'completed');
  assert.deepEqual(calls[0].agentOptions, { ...selection, maxTokens: 1800 });
  assert.equal(calls[0].preset, undefined); assert.deepEqual(calls[0].restriction, {allow:[]}); assert.deepEqual(store.jobs()[0].result?.tests, []);
  assert.ok(store.jobs()[0].rawOutput?.includes('],"category":'));
  assert.ok(store.audits().some(a => a.detail.includes('已修复模型结果')));
  assert.ok(store.jobs()[0].analysisPath); assert.equal(store.jobs()[0].worktree, undefined);
  selection = { provider: 'host-b', model: 'model-b', reasoningEffort: 'low' };
  assert.equal(w.snapshot().capabilities.host?.model, 'model-b');
  w.enqueue([store.issues()[1].id], 'triage'); w.pump(); await w.drain();
  assert.deepEqual(calls[1].agentOptions, { ...selection, maxTokens: 1800 });
  assert.ok(texts.every(t => t.includes('Metadata routing only') && t.includes('sourceCodeRead')));
  assert.deepEqual(permissions, ['read-only', 'read-only']);
  await w.close();
});

test('native credential loading cannot override host provider environment from stale plugin keys', async () => {
  const names = ['MAINTAINER_API_KEY', 'DEEPSEEK_API_KEY', 'MAINTAINER_BASE_URL', 'GITHUB_TOKEN'];
  const before = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    for (const n of names) delete process.env[n];
    const dir = await mkdtemp(join(tmpdir(), 'maintainer-creds-native-'));
    await writeFile(join(dir, 'credentials.json'), JSON.stringify({ apiKey: 'stale-plugin-key', baseUrl: 'https://unused.example', githubToken: 'fixture-github' }));
    const c = new Credentials(dir, 'github-only'); await c.load();
    assert.equal(process.env.DEEPSEEK_API_KEY, undefined); assert.equal(process.env.MAINTAINER_API_KEY, undefined); assert.equal(process.env.MAINTAINER_BASE_URL, undefined);
    assert.equal(process.env.GITHUB_TOKEN, 'fixture-github');
    await assert.rejects(c.save({ apiKey: 'unexpected' }), /Harness/);
  } finally { for (const n of names) { if (before[n] === undefined) delete process.env[n]; else process.env[n] = before[n]; } }
});

test('format recovery creates a tool-free session and never reruns implementation', async()=>{
  let listener:any;let mounted=0;let restricted=0;let count=0;
  const ctx={agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},llm:{listProviders:()=>[{id:'p'}]},agentPresets:{resolve:async()=>({id:'standard'}),mount:async()=>{mounted++;}},permissionPresets:{defaultPreset:'workspace-write',resolve:()=>{},set:()=>{}},workspaceRegistry:{create:async(path:string)=>({path,attachSession:async()=>{}})},on:(_:string,fn:any)=>{listener=fn;return()=>{};},agents:{create:async(options:any)=>{count++;await options.setup({tools:{restrict:()=>{restricted++;},guard:()=>{}}});return{dispose:async()=>{},agent:{session:{},cancel:()=>{},followup:()=>{const callback=listener;queueMicrotask(()=>{const text=count===1?'broken result':JSON.stringify({schemaVersion:1,stage:'fix',summary:'recorded change',coverage:'recorded only',evidence:[],nextSteps:[],responseDraft:'',changes:['recorded change'],acceptanceCriteria:[],limitations:['checks unavailable'],tests:[]});callback({id:options.sessionId},{type:'assistant/message',data:{message:{content:[{type:'text',text}]}}});callback({id:options.sessionId},{type:'turn/end',data:{reason:{kind:'completed'}}});});}}};}}} as unknown as Context;
  const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue=store.issues()[0];const now=new Date().toISOString();
  const output=await harnessRunner(ctx,new GitHub('',async()=>Response.json([])))({repo,issue,related:[],job:{id:'format-test',repoId:repo.id,issueId:issue.id,kind:'fix',status:'running',revision:'r',baseSha:repo.headSha,issueSnapshot:issue,attempt:1,createdAt:now,updatedAt:now,worktree:'/tmp/owned-fixture'},settings:store.settings(),signal:new AbortController().signal,progress:()=>{}});
  assert.equal(count,2);assert.equal(mounted,1);assert.equal(restricted,1);assert.equal(output.artifact?.stage,'fix');store.close();
});
