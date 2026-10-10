import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { git } from '../src/core/git.ts';
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
    llm: { listProviders: () => [{ id: selection.provider }, {id:'configured'}], listModels:async()=>[{id:'cheap'},{id:'advanced'}], resolveModelInfo:async()=>({reasoning:{defaultEffort:'medium',efforts:[{id:'medium'},{id:'high'}]}}) },
    agentPresets: { defaultId: 'host-standard', resolve: async (id?: string) => ({ id: id ?? 'host-standard' }), mount: async (_: unknown, id: string) => { calls.at(-1).preset = id; } },
    permissionPresets: { resolve: (p: string) => permissions.push(p), set: () => {} },
    workspaceRegistry: { archiveSession:async(id:string)=>{calls.at(-1).archived=id;}, create: async (path: string) => ({ path, attachSession: async () => {} }) },
    on: (_: string, fn: any) => { listener = fn; return () => {}; },
    agents: { create: async (options: any) => { calls.push(options); await options.setup({ tools: { register: () => () => {}, schemas: () => [], restrict: (v: unknown) => { calls.at(-1).restriction = v; }, guard: () => {} } }); return { dispose: async () => {}, agent: { session: {}, cancel: () => {}, whenIdle: async () => {}, followup: (message: unknown) => { texts.push(JSON.stringify(message)); queueMicrotask(() => { listener({ id: options.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ schemaVersion:1, stage:'triage', summary:'triage', coverage:'metadata', evidence:[], nextSteps:[], responseDraft:'draft', category:'bug', priority:'P2', labels:[], module:'unknown', impact:'unknown', missingInfo:[], duplicateOf:null, duplicateReason:'', route:'investigate', routeReason:'needs evidence' }).replace(',"category":', '],"category":') }] } } }); listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }); }); } } }; } }
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
  assert.equal(calls[0].archived,`maintainer-${store.jobs()[0].id}`); assert.equal(calls[0].preset, undefined); assert.deepEqual(calls[0].restriction, {allow:[]}); assert.deepEqual(store.jobs()[0].result?.tests, []);
  assert.ok(store.jobs()[0].rawOutput?.includes('],"category":'));
  assert.ok(store.audits().some(a => a.detail.includes('已修复模型结果')));
  assert.ok(store.jobs()[0].analysisPath); assert.equal(store.jobs()[0].worktree, undefined);
  selection = { provider: 'host-b', model: 'model-b', reasoningEffort: 'low' };
  assert.equal(w.snapshot().capabilities.host?.model, 'model-b');
  w.enqueue([store.issues()[1].id], 'triage'); w.pump(); await w.drain();
  assert.deepEqual(calls[1].agentOptions, { ...selection, maxTokens: 1800 });
  assert.ok(texts.every(t => t.includes('Metadata routing only') && t.includes('sourceCodeRead')));
  w.updateSettings({...store.settings(),nativeDefaultModel:{provider:'configured',model:'cheap'},stageModels:{}});
  w.enqueue([issue.id],'triage',{forceNew:true}); w.pump();await w.drain();
  assert.deepEqual(calls[2].agentOptions,{provider:'configured',model:'cheap',reasoningEffort:'medium',maxTokens:1800});
  w.updateSettings({...store.settings(),stageModels:{triage:{provider:'configured',model:'advanced',reasoningEffort:'high'}}});
  w.enqueue([issue.id],'triage',{forceNew:true});w.pump();await w.drain();
  assert.deepEqual(calls[3].agentOptions,{provider:'configured',model:'advanced',reasoningEffort:'high',maxTokens:1800});
  assert.deepEqual(permissions, ['read-only', 'read-only','read-only','read-only']);
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

test('format recovery creates a tool-free session and never reruns implementation', async t=>{
  const root=await mkdtemp(join(tmpdir(),'mw-format-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await git(root,['init','-b','main']);await writeFile(join(root,'fix.txt'),'before');await git(root,['add','.']);await git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','baseline']);
  const sha=await git(root,['rev-parse','HEAD']);await writeFile(join(root,'fix.txt'),'after');
  let listener:any;let mounted=0;let restricted=0;let count=0;
  const ctx={agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},llm:{listProviders:()=>[{id:'p'}]},agentPresets:{resolve:async()=>({id:'standard'}),mount:async()=>{mounted++;}},permissionPresets:{defaultPreset:'workspace-write',resolve:()=>{},set:()=>{}},workspaceRegistry:{create:async(path:string)=>({path,attachSession:async()=>{}})},on:(_:string,fn:any)=>{listener=fn;return()=>{};},agents:{create:async(options:any)=>{count++;await options.setup({tools:{register:()=>()=>{},schemas:()=>[],restrict:()=>{restricted++;},guard:()=>{}}});return{dispose:async()=>{},agent:{session:{},cancel:()=>{},whenIdle:async()=>{},followup:()=>{const callback=listener;queueMicrotask(()=>{const text=count===1?'broken result':JSON.stringify({schemaVersion:1,stage:'fix',summary:'recorded change',coverage:'recorded only',evidence:[],nextSteps:[],responseDraft:'',changes:['recorded change'],acceptanceCriteria:[],limitations:['checks unavailable'],tests:[]});callback({id:options.sessionId},{type:'assistant/message',data:{message:{content:[{type:'text',text}]}}});callback({id:options.sessionId},{type:'turn/end',data:{reason:{kind:'completed'}}});});}}};}}} as unknown as Context;
  const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue=store.issues()[0];const now=new Date().toISOString();
  const output=await harnessRunner(ctx,new GitHub('',async()=>Response.json([])))({repo,issue,related:[],job:{id:'format-test',repoId:repo.id,issueId:issue.id,kind:'fix',status:'running',revision:'r',baseSha:sha,issueSnapshot:issue,attempt:1,createdAt:now,updatedAt:now,worktree:root},settings:store.settings(),signal:new AbortController().signal,progress:()=>{}});
  assert.equal(count,2);assert.equal(mounted,1);assert.equal(restricted,1);assert.equal(output.artifact?.stage,'fix');store.close();
});

test('native docs loop stops model requests and keeps the specific blocker without implementation retry', async () => {
  const root=await mkdtemp(join(tmpdir(),'maintainer-loop-'));
  const store=new Store(':memory:');seedFixture(store);
  let turns=0, disposed=false;
  const listeners=new Map<string,any>();const guards:((e:any)=>string|undefined)[]=[];
  const ctx={
    agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},
    llm:{listProviders:()=>[{id:'p'}]},
    agentPresets:{resolve:async()=>({id:'standard'}),mount:async()=>{}},
    permissionPresets:{defaultPreset:'workspace-write',resolve:()=>{},set:()=>{}},
    workspaceRegistry:{create:async(path:string)=>({path,attachSession:async()=>{}})},
    on:(name:string,fn:any)=>{listeners.set(name,fn);return()=>listeners.delete(name);},
    agents:{create:async(options:any)=>{
      await options.setup({tools:{register:()=>()=>{},schemas:()=>[],restrict:()=>{},guard:(g:any)=>guards.push(g)}});
      return {dispose:async()=>{disposed=true;},agent:{session:{},cancel:()=>{},whenIdle:async()=>{},followup:()=>{
        turns++;
        queueMicrotask(async()=>{
          try {
            const execution={name:'bash',arguments:{command:"grep -nE '^#{1,4} ' AGENTS.md"}};
            for(let i=0;i<4;i++) guards.forEach(g=>g(execution));
            const stream=listeners.get('llm/stream')({sessionId:options.sessionId},()=>{throw Error('Blocked request reached model');});
            const chunks=[];for await(const chunk of stream)chunks.push(chunk);
            assert.equal(chunks[0].reason.failure.code,'WORKBENCH_TOOL_LOOP');
            listeners.get('session/event')({id:options.sessionId},{type:'turn/end',data:{reason:chunks[0].reason}});
          } catch(error) {listeners.get('session/event')({id:options.sessionId},{type:'turn/end',data:{reason:{kind:'error',failure:{message:String(error)}}}});}
        });
      }}};
    }},
  } as unknown as Context;
  try {
    const issue=store.issues()[0],repo=store.repos()[0],now=new Date().toISOString();
    await assert.rejects(harnessRunner(ctx,new GitHub('',async()=>Response.json([])))({repo,issue,related:[],job:{id:'loop-test',repoId:repo.id,issueId:issue.id,kind:'docs',status:'running',revision:'r',baseSha:'a'.repeat(40),issueSnapshot:issue,attempt:1,createdAt:now,updatedAt:now,worktree:root},settings:store.settings(),signal:new AbortController().signal,progress:()=>{}}),/重复工具调用阻塞/);
    assert.equal(turns,1);assert.equal(disposed,true);assert.equal(listeners.size,0);
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

for (const failures of [1,3]) test(`Messages pre-start recovery stays inside one native request and ${failures===1?'recovers':'stops at its limit'}`,async()=>{
 const listeners=new Map<string,any>();let followups=0,downstream=0;const progress:string[]=[];let diagnostics:any;
 const ctx={
  agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},llm:{listProviders:()=>[{id:'p'}]},
  agentPresets:{resolve:async()=>({id:'standard'})},permissionPresets:{resolve:()=>{},set:()=>{}},workspaceRegistry:{archiveSession:async()=>{}},
  on:(name:string,fn:any)=>{listeners.set(name,fn);return()=>listeners.delete(name);},
  agents:{create:async(options:any)=>{
   await options.setup({tools:{schemas:()=>[],restrict:()=>{},guard:()=>{}}});
   return {dispose:async()=>{},agent:{session:{},cancel:()=>{},whenIdle:async()=>{},followup:()=>{
    followups++;
    queueMicrotask(async()=>{
     try{
      let terminal=false;
      for(let i=0;i<failures;i++){
       const stream=listeners.get('llm/stream')({sessionId:options.sessionId},async function*(){throw Object.assign(new Error('DeepSeek Messages stream: event precedes message_start'),{code:'MALFORMED_RESPONSE'});});
       const chunks=[];for await(const chunk of stream)chunks.push(chunk);
       assert.equal(chunks.length,1);assert.equal(chunks[0].type,'finish');
       const action=await listeners.get('agent/request-error')({agent:{session:{id:options.sessionId}},turn:1,step:1,signal:new AbortController().signal,failure:chunks[0].reason.failure},async()=>{downstream++;});
       if(!action){terminal=true;break;}
      }
      if(terminal){listeners.get('session/event')({id:options.sessionId},{type:'turn/end',data:{reason:{kind:'error',error:{code:'MALFORMED_RESPONSE',message:'DeepSeek Messages stream: event precedes message_start'}}}});return;}
      const report={schemaVersion:1,stage:'triage',summary:'triage',coverage:'metadata',evidence:[],nextSteps:[],responseDraft:'',category:'bug',priority:'P2',labels:[],module:'unknown',impact:'unknown',missingInfo:[],duplicateOf:null,duplicateReason:'',route:'investigate',routeReason:'needs evidence'};
      listeners.get('session/event')({id:options.sessionId},{type:'assistant/message',data:{message:{content:[{type:'text',text:JSON.stringify(report)}]}}});
      listeners.get('session/event')({id:options.sessionId},{type:'turn/end',data:{reason:{kind:'completed'}}});
     }catch(e){listeners.get('session/event')({id:options.sessionId},{type:'turn/end',data:{reason:{kind:'error',error:{message:String(e)}}}});}
    });
   }}};
  }},
 } as unknown as Context;
 const store=new Store(':memory:');seedFixture(store);const issue=store.issues()[0],repo=store.repos()[0],now=new Date().toISOString();
 try{
  const run=harnessRunner(ctx,new GitHub('',async()=>Response.json([])))({repo,issue,related:[],job:{id:'stream-test',repoId:repo.id,issueId:issue.id,kind:'triage',status:'running',revision:'r',baseSha:repo.headSha,issueSnapshot:issue,attempt:1,createdAt:now,updatedAt:now,analysisPath:'/tmp'},settings:store.settings(),signal:new AbortController().signal,progress:m=>progress.push(m),recordDiagnostics:d=>{diagnostics=d;}});
  if(failures===1)assert.equal((await run).artifact?.stage,'triage');else await assert.rejects(run,/有限重试已用尽/);
  assert.equal(followups,1);assert.equal(downstream,0);assert.equal(diagnostics.calls,0);assert.equal(diagnostics.protocolRecovery.attempts,failures===1?1:2);assert.equal(listeners.size,0);
  assert.ok(progress.some(m=>m.includes('恢复同一次请求')));
 }finally{store.close();}
});
