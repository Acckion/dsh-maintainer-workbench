import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GitHub} from '../src/core/github.ts';
import {Store} from '../src/core/store.ts';
import {Workbench} from '../src/core/workbench.ts';
import {seedFixture,fixtureRunner} from './support/fixtures.ts';
import {prNumber,remoteBlockers,type RemotePR,type ActionsSnapshot} from '../src/core/remote-progress.ts';
import {RemoteProgress} from '../src/client/RemoteProgress.tsx';
const sha='a'.repeat(40), other='b'.repeat(40), url='https://github.com/fixture/queue/pull/135';
const progress:RemotePR={url,number:135,headSha:sha,baseSha:other,state:'OPEN',draft:false,review:'APPROVED',mergeState:'CLEAN',mergedAt:null,checks:[{name:'test',status:'COMPLETED',conclusion:'SUCCESS'}],closingIssues:[],partial:false,syncedAt:'2026-10-04T00:00:00Z'};
const snapshot:ActionsSnapshot={headSha:sha,syncedAt:progress.syncedAt,jobs:[{id:10,runId:2,attempt:1,headSha:sha,name:'tests',url,status:'completed',conclusion:'failure',steps:[{name:'regression',number:2,status:'completed',conclusion:'failure'}]}],warnings:[]};
function setup(github=new GitHub('',async()=>{throw Error('unexpected network');})) {const store=new Store(':memory:');seedFixture(store);const issue={...store.issues()[0],linkedPullRequests:[url]};store.put('issues',issue);return{store,issue,repo:store.repos()[0],w:new Workbench(store,'/tmp/remote-progress-test',fixtureRunner,github,false),github};}
const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json'}});
test('remote blockers distinguish review, CI, conflict, partial and merged but open Issue',()=>{
 assert.match(remoteBlockers({...progress,mergedAt:progress.syncedAt},'open').join(),/仍开放/);
 assert.match(remoteBlockers({...progress,state:'CLOSED'},'open').join(),/未合并/);
 const blockers=remoteBlockers({...progress,draft:true,review:'CHANGES_REQUESTED',mergeState:'DIRTY',partial:true,checks:[{name:'test',status:'COMPLETED',conclusion:'FAILURE'}]},'open').join();
 for(const phrase of ['草稿','要求修改','CI','冲突','部分']) assert.match(blockers,new RegExp(phrase));
 assert.match(remoteBlockers({...progress,error:'403'},'closed').join(),/旧快照/);
 assert.match(remoteBlockers({...progress,checks:[]},'open').join(),/未覆盖/);
 assert.match(remoteBlockers({...progress,checks:[{name:'test',status:'COMPLETED',conclusion:null}]},'open').join(),/未覆盖/);
 assert.throws(()=>prNumber('https://github.com/other/repo/pull/135','fixture/queue'));
 assert.throws(()=>prNumber('https://github.com.evil/fixture/queue/pull/135','fixture/queue'));
});
test('regular sync refreshes linked PRs and exact Issue state without treating merge as close; errors retain snapshot',async()=>{
 const {w,store,repo,issue,github}=setup();
 github.sync=async()=>({repo,issues:[issue]});github.remotePR=async()=>({...progress,mergedAt:progress.syncedAt});github.request=async()=>({number:issue.number,state:'open'});
 try {await w.sync(repo.fullName);assert.equal(store.get<typeof issue>('issues',issue.id)?.state,'open');assert.equal(store.issues()[0].remotePRs?.[0].mergedAt,progress.syncedAt);
 github.remotePR=async()=>{throw Error('denied');};await w.syncRemote(issue.id);assert.equal(store.issues()[0].remotePRs?.[0].headSha,sha);assert.match(store.issues()[0].remotePRs?.[0].error ?? '',/denied/);
 }finally{await w.close();}
});
test('Actions UI target must belong to linked PR and changed remote head cannot replace evidence',async()=>{
 const {w,store,issue,github}=setup();let calls=0;
 github.pullRequest=async()=>({headSha:++calls===1?sha:other,baseSha:other,headRef:'f',baseRef:'main',headRepo:'fixture/queue',draft:false,merged:false,mergeable:true,checks:[],reviews:[],warnings:[]});github.actions=async()=>structuredClone(snapshot);
 try{await assert.rejects(w.syncActions(issue.id,999),/关联范围/);assert.equal(calls,0);await assert.rejects(w.syncActions(issue.id,135),/已更新/);assert.equal(store.issues()[0].actions,undefined);}finally{await w.close();}
});
test('Actions lists attempts separately, rejects other head jobs and exposes partial/error coverage',async()=>{
 const paths:string[]=[];
 const github=new GitHub('',async(input)=>{const path=String(input);paths.push(path);if(path.includes('/actions/runs?')) return json({total_count:21,workflow_runs:[{id:2,head_sha:sha,run_attempt:4}]});if(path.includes('/attempts/3/'))return new Response('',{status:403});return json({total_count:101,jobs:[{id:path.includes('/attempts/2/')?10:12,run_id:2,head_sha:sha,name:'tests',html_url:url,status:'completed',conclusion:'failure',steps:[]},{id:99,run_id:2,head_sha:other,name:'foreign',html_url:url,status:'completed',conclusion:'success'}]});});
 const {repo,w}=setup(github);try{const result=await github.actions(repo,sha);assert.deepEqual(result.jobs.map(j=>j.attempt),[4,2]);assert.ok(result.warnings.length>=5);assert.equal(paths.some(p=>p.includes('/attempts/1/')),false);}finally{await w.close();}
});
test('signed Actions log download never forwards credentials, caps output and rejects unknown or foreign jobs',async()=>{
 const calls:{url:string;init?:RequestInit}[]=[];
 const github=new GitHub('fixture-secret',async(input,init)=>{const target=String(input);calls.push({url:target,init});if(target.endsWith('/jobs/10'))return json({id:10,run_id:2,head_sha:sha});if(target.endsWith('/logs'))return new Response(null,{status:302,headers:{location:'https://logs.blob.core.windows.net/log.txt?signed=fixture'}});return new Response('x'.repeat(600000));});
 const {repo,w}=setup(github);try{await assert.rejects(github.actionLog(repo,snapshot,999),/范围/);assert.equal(calls.length,0);const log=await github.actionLog(repo,snapshot,10);assert.equal(log.attempt,1);assert.equal(Buffer.byteLength(log.text),512*1024);assert.equal(log.truncated,true);assert.equal(calls[2].init?.headers,undefined);assert.equal(calls[2].init?.redirect,'error');}finally{await w.close();}
});
test('Actions logs reject foreign host, foreign run and unavailable logs',async()=>{
 for(const mode of ['foreign-host','foreign-run','expired']){
 const github=new GitHub('',async(input)=>String(input).endsWith('/logs') ? mode==='expired'?new Response('',{status:410}):new Response(null,{status:302,headers:{location:'https://evil.example/log'}}):json({id:10,run_id:mode==='foreign-run'?999:2,head_sha:sha}));
 const {repo,w}=setup(github);try{await assert.rejects(github.actionLog(repo,snapshot,10),mode==='foreign-host'?/不受支持/:mode==='foreign-run'?/目标已变化/:/不可读取/);}finally{await w.close();}}
});
test('GraphQL remote progress projects status contexts and check runs without inventing missing coverage',async()=>{
 const github=new GitHub('',async()=>json({data:{repository:{pullRequest:{url,number:135,headRefOid:sha,baseRefOid:other,state:'OPEN',isDraft:false,reviewDecision:null,mergeStateStatus:'UNKNOWN',mergedAt:null,closingIssuesReferences:{pageInfo:{hasNextPage:false},nodes:[]},commits:{nodes:[{commit:{statusCheckRollup:{contexts:{pageInfo:{hasNextPage:true},nodes:[{__typename:'StatusContext',context:'legacy',state:'PENDING'},{__typename:'CheckRun',name:'test',status:'COMPLETED',conclusion:'FAILURE'}]}}}}]}}}}}));
 const {repo,w}=setup(github);try{const result=await github.remotePR(repo,url);assert.equal(result.partial,true);assert.equal(result.checks[0].status,'IN_PROGRESS');assert.equal(result.checks[1].conclusion,'FAILURE');}finally{await w.close();}
});
test('remote UI shows individual PR blockers, exact attempts, failed steps and missing coverage',async()=>{
 const {issue,w}=setup();try{const html=renderToStaticMarkup(React.createElement(RemoteProgress,{issue:{...issue,remotePRs:[{...progress,mergedAt:progress.syncedAt}],actions:{...snapshot,warnings:['partial']}},busy:false,act:async()=>({})}));for(const text of ['Issue 仍开放','第 1 次','regression','job 10','partial','单次失败'])assert.ok(html.includes(text));}finally{await w.close();}
});
test('CI task persists exact Actions evidence and bounded failed-job logs before runner execution',async()=>{
 const store=new Store(':memory:');seedFixture(store);const issue=store.issues()[0],repo=store.repos()[0],github=new GitHub('',async()=>{throw Error('fixture network unavailable');});
 const pr={...issue,type:'pr' as const,number:135,id:'fixture/queue#135',headSha:sha,prBaseSha:other,url};store.put('issues',pr);
 github.pullRequest=async()=>({headSha:sha,baseSha:other,headRef:'f',baseRef:'main',headRepo:repo.fullName,draft:false,merged:false,mergeable:true,checks:[],reviews:[],warnings:[]});
 github.actions=async()=>structuredClone(snapshot);github.actionLog=async()=>({jobId:10,runId:2,attempt:1,headSha:sha,text:'e'.repeat(20000),truncated:false,fetchedAt:progress.syncedAt});
 let observed=false;
 const w=new Workbench(store,'/tmp/remote-ci-input-test',async({job,issue})=>{observed=true;assert.equal(job.ciEvidence?.logs[0].attempt,1);assert.equal(job.ciEvidence?.logs[0].text.length,16000);assert.equal(job.ciEvidence?.logs[0].truncated,true);return {result:{...(await fixtureRunner({repo,issue,related:[],job,settings:store.settings(),signal:new AbortController().signal,progress:()=>{}})).result},artifact:{schemaVersion:1,stage:'ci',summary:'unknown',coverage:'fixture',evidence:[],nextSteps:[],responseDraft:'',classification:'unknown',facts:[],hypotheses:[],proposedChanges:[],blockers:[]},engine:'fixture'};},github,false);
 // Input wiring test: no clone, checkout or real model; the runner has no tools.
 w.prepareRepository=async()=>{};
 try{const id=w.enqueue([pr.id],'ci').created[0];w.pump();await w.drain();assert.ok(observed);assert.equal(store.jobs().find(j=>j.id===id)?.ciEvidence?.snapshot.headSha,sha);}finally{await w.close();}
});
