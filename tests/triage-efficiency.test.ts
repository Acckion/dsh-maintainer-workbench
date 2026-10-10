import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/core/store.ts';
import {Workbench} from '../src/core/workbench.ts';
import {GitHub} from '../src/core/github.ts';
import {revision} from '../src/core/revision.ts';
import {triageInput} from '../src/core/triage-input.ts';
import {seedFixture,fixtureRunner} from './support/fixtures.ts';

test('classifications survive process restart and unchanged sync without a model call',async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'triage-cache-')),'store.sqlite');
 let store=new Store(path);seedFixture(store);let wb=new Workbench(store,'/tmp/triage',fixtureRunner);
 const issue=store.issues()[0], repo=store.repos()[0];const id=wb.enqueue([issue.id],'triage').created[0];await wb.drain();
 assert.ok(store.triage(issue.id,revision(issue,repo)));await wb.close();
 store=new Store(path);wb=new Workbench(store,'/tmp/triage',fixtureRunner,undefined,false);
 assert.deepEqual(wb.enqueue([issue.id],'triage'),{created:[],reused:[id]});
 assert.ok(store.get('issues',issue.id));assert.equal(store.jobs().length,1);
 store.put('issues',{...issue,title:'new version'});assert.equal(wb.enqueue([issue.id],'triage').created.length,1);
 assert.ok(store.triage(issue.id,revision(issue,repo)));await wb.close();
});

test('manual sync auto-classifies within queue cap, reuses results and never loops failures',async()=>{
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issues=store.issues();
 const github=new GitHub();github.sync=async()=>({repo:{...repo,syncedAt:new Date().toISOString()},issues:structuredClone(issues)});
 const wb=new Workbench(store,'/tmp/triage',fixtureRunner,github,false);
 wb.updateSettings({...store.settings(),autoTriage:true,maxJobsPerBatch:2,syncIntervalMinutes:0});
 await wb.sync(repo.fullName);assert.equal(store.jobs().length,2);await wb.poll();assert.equal(store.jobs().length,2);
 wb.pump();await wb.drain();await wb.sync(repo.fullName);assert.ok(store.issues()[0].analysis);assert.equal(store.jobs().length,4);
 wb.pump();await wb.drain();await wb.poll();assert.equal(store.jobs().length,4);
 assert.ok(store.jobs().every(j=>j.status==='completed'));await wb.close();
 const failed=new Store(':memory:');seedFixture(failed);const bad=new Workbench(failed,'/tmp/triage',async()=>{throw Error('offline');});
 bad.updateSettings({...failed.settings(),autoTriage:true});await bad.poll();await bad.drain();const count=failed.jobs().length;await bad.poll();await bad.drain();assert.equal(failed.jobs().length,count);await bad.close();
});

test('triage payload strips stored results, bounds bodies and candidates, preserves coverage',()=>{
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue=store.issues()[0];
 const input=triageInput(repo,{...issue,body:'a'.repeat(20000),comments:80},Array(25).fill({...issue,body:'b'.repeat(20000)}),JSON.stringify({comments:Array(30).fill({body:'c'.repeat(20000),user:{login:'person',private:'secret'}})}));
 assert.equal(input.related.length,6);assert.equal(input.comments.length,5);assert.equal(input.coverage.bodyTruncated,true);
 const size=JSON.stringify(input).length;assert.ok(size<15000);assert.ok(!JSON.stringify(input).includes('secret'));store.close();
});

test('PR automation is independently controlled, persistent and refreshes changed heads only',async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'pr-auto-')),'store.sqlite');
 let store=new Store(path);seedFixture(store);let repo=store.repos()[0];
 const pr={...store.issues()[0],type:'pr' as const,headSha:'a'.repeat(40),prBaseSha:'b'.repeat(40)};store.put('issues',pr);
 const github=new GitHub();github.pullRequest=async()=>({headSha:store.get<import('../src/core/types.ts').Issue>('issues',pr.id)!.headSha!,baseSha:pr.prBaseSha,headRef:'topic',headRepo:repo.fullName,baseRef:'main',draft:false,merged:false,mergeable:null,checks:null,reviews:[],warnings:[]});
 let calls=0;const runner:import('../src/core/types.ts').Runner=async args=>{calls++;assert.equal(args.settings.maxTokens,6000);return fixtureRunner(args);};
 let wb=new Workbench(store,'/tmp/pr-auto',runner,github,false);
 await wb.poll();assert.equal(store.jobs().length,0);
 wb.updateSettings({...store.settings(),autoPreflight:true,autoTriage:false});await wb.poll();assert.equal(store.jobs().length,1);assert.equal(store.jobs()[0].kind,'preflight');
 wb.pump();await wb.drain();assert.equal(calls,1);await wb.poll();assert.equal(store.jobs().length,1);await wb.close();
 store=new Store(path);repo=store.repos()[0];wb=new Workbench(store,'/tmp/pr-auto',runner,github,false);await wb.poll();assert.equal(store.jobs().length,1);
 store.put('issues',{...pr,headSha:'c'.repeat(40)});await wb.poll();assert.equal(store.jobs().length,2);wb.pump();await wb.drain();assert.equal(calls,2);
 wb.updatePolicy(repo.id,{autoTriage:false,autoPreflight:false,syncIntervalMinutes:0,timeoutMs:600000,maxTokens:6000});store.put('issues',{...pr,headSha:'d'.repeat(40)});await wb.poll();assert.equal(store.jobs().length,2);await wb.close();
});
