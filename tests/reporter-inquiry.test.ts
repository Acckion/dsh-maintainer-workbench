import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Store} from '../src/core/store.ts';
import {Workbench} from '../src/core/workbench.ts';
import {GitHub} from '../src/core/github.ts';
import {revision} from '../src/core/revision.ts';
import {asAnalysis,artifactSchemas} from '../src/core/artifacts.ts';
import {seedFixture} from './support/fixtures.ts';
import {ProcessingInput,ReporterInquiryStatus} from '../src/client/ProcessingInput.tsx';
import {receiveReplies} from '../src/core/issue-flow.ts';
import type {Job,Issue} from '../src/core/types.ts';

const artifact=artifactSchemas.triage.parse({schemaVersion:1,stage:'triage',summary:'需要报告者资料',coverage:'Issue 描述',evidence:[],nextSteps:[],responseDraft:'',category:'bug',priority:'P2',labels:[],module:'import',impact:'未知',missingInfo:['环境与日志'],duplicateOf:null,duplicateReason:'',route:'needs_info',routeReason:'缺少资料',inputRequest:{reason:'等待报告者',fields:[{id:'environment',question:'使用哪个版本？',actor:'reporter',purpose:'information'},{id:'logs',question:'是否有错误日志？',actor:'reporter',purpose:'information'}]}});
function setup(manual=true){
 const store=new Store(':memory:');seedFixture(store);const issue={...store.issues()[0],updatedAt:'2026-10-28T01:00:00Z'},repo=store.repos()[0];store.put('issues',issue);
 let posts=0,denied=false,lose=false,rows:any[]=[];
 const github=new GitHub('fixture',async(input,init)=>{
  const url=String(input);
  if(init?.method==='POST'){posts++;if(denied)return Response.json({message:'Forbidden'},{status:403});const row={html_url:`https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-123`,body:JSON.parse(String(init.body)).body,created_at:'2026-10-28T01:00:01Z'};rows.push(row);if(lose){lose=false;throw Error('lost response');}return Response.json(row);}
  if(url.includes('/comments?'))return Response.json(rows);
  if(url.endsWith(`/issues/${issue.number}`))return Response.json({updated_at:rows.length?'2026-10-28T01:00:01Z':issue.updatedAt});
  throw Error('Unexpected read '+url);
 });
 const wb=new Workbench(store,'/tmp/reporter-inquiry-tests',async()=>({artifact,result:asAnalysis(artifact),engine:'fixture'}),github,false);
 const job:Job={id:crypto.randomUUID(),repoId:repo.id,issueId:issue.id,issueSnapshot:issue,caseId:store.processing.current(issue.id)!.id,kind:'triage',status:'waiting_input',revision:revision(issue,repo,'triage'),baseSha:repo.headSha,attempt:1,createdAt:issue.updatedAt,updatedAt:issue.updatedAt,artifact,result:asAnalysis(artifact)};
 if(manual){store.put('jobs',job);wb.processing.requestInput(issue.id,artifact.inputRequest,job.id);}
 return {store,wb,issue,repo,job,github,posts:()=>posts,deny:()=>{denied=true;},allow:()=>{denied=false;},lose:()=>{lose=true;},rows:()=>rows};
}

test('Agent reporter questions publish once, preserve the report and become external waits',async()=>{
 const f=setup();try{
  const result=await f.wb.askReporter(f.job.id);assert.ok(result.url);assert.equal(f.posts(),1);assert.match(f.rows()[0].body,/@/);assert.match(f.rows()[0].body,/使用哪个版本/);
  const job=f.store.get<Job>('jobs',f.job.id)!,issue=f.store.get<Issue>('issues',f.issue.id)!;
  assert.equal(job.status,'completed');assert.deepEqual(job.artifact,artifact);assert.equal(issue.informationRequests?.[0].source,'published_comment');assert.equal(issue.processing?.waits.find(w=>w.requestedByRunId===job.id)?.state,'cancelled');assert.ok(issue.processing?.waits.some(w=>w.type==='reporter_reply'&&w.state==='open'));
  await f.wb.askReporter(job.id);assert.equal(f.posts(),1);
  const ui=renderToStaticMarkup(React.createElement(ReporterInquiryStatus,{job,issue,busy:false,act:async()=>{}}));assert.match(ui,/已向报告者提问/);assert.doesNotMatch(ui,/<textarea|<select/);
 }finally{await f.wb.close();}
});

test('permission failure retains questions; lost-response retry recovers without another POST',async()=>{
 const f=setup();try{
  f.deny();const fail=await f.wb.askReporter(f.job.id);assert.ok(fail.error);assert.equal(f.store.get<Job>('jobs',f.job.id)?.status,'waiting_input');assert.equal(f.store.get<Issue>('issues',f.issue.id)?.informationRequests,undefined);
  f.allow();f.lose();assert.ok((await f.wb.askReporter(f.job.id)).error);assert.equal(f.posts(),2);
  assert.ok((await f.wb.askReporter(f.job.id)).url);assert.equal(f.posts(),2);
 }finally{await f.wb.close();}
});

test('maintainer decisions never publish as reporter questions and stale inputs cannot post',async()=>{
 for(const mode of ['maintainer','stale'] as const){const f=setup();try{
  if(mode==='maintainer'){const state=f.store.processing.current(f.issue.id)!;f.wb.processing.cancelWait(f.issue.id,state.waits.at(-1)!.id,'replaced',state.version);f.wb.processing.requestInput(f.issue.id,{reason:'选择范围',fields:[{id:'scope',question:'允许修改哪里？',actor:'maintainer',purpose:'decision'}]},f.job.id);await assert.rejects(f.wb.askReporter(f.job.id),/没有可向/);}
  else{f.store.put('issues',{...f.store.get<Issue>('issues',f.issue.id)!,body:'changed externally'});await assert.rejects(f.wb.askReporter(f.job.id),/当前任务|版本/);}
  assert.equal(f.posts(),0);
 }finally{await f.wb.close();}}
});

test('reporter-only waiting UI shows a publish action instead of maintainer input boxes',async()=>{
 const f=setup();try{const ui=renderToStaticMarkup(React.createElement(ProcessingInput,{job:f.job,issue:f.store.get<Issue>('issues',f.issue.id)!,runId:f.job.id,busy:false,act:async()=>{}}));assert.match(ui,/向 Issue 报告者提问/);assert.doesNotMatch(ui,/<textarea|<select/);
 const request={id:'q',questions:['版本？'],state:'asked' as const,waitingFor:f.issue.author,askedAt:'2026-10-28T01:00:00Z',baselineComments:0,source:'published_comment' as const,questionUrl:'https://github.com/fixture/q#issuecomment-123',replies:[]};
 const next=receiveReplies(request,[{id:123,author:f.issue.author,url:request.questionUrl,body:'own question',createdAt:'2026-10-28T01:00:01Z'}],false);assert.equal(next.state,'asked');
 }finally{await f.wb.close();}
});


test('opted-in triage automatically asks reporter; explicit no-publication scope remains local',async()=>{
 for(const forbidden of [false,true]){const f=setup(false);try{
  f.store.put('repos',{...f.repo,policy:{autoTriage:false,syncIntervalMinutes:0,timeoutMs:60000,maxTokens:4000,autoAskReporter:true}});
  const id=f.wb.enqueue([f.issue.id],'triage',{instructions:forbidden?'不要修改文件、发布评论':'仅分诊，资料不足时向报告者提问'}).created[0];
  f.wb.pump();await f.wb.drain();
  assert.equal(f.posts(),forbidden?0:1);
  assert.equal(f.store.get<Job>('jobs',id)?.status,forbidden?'waiting_input':'completed');
 }finally{await f.wb.close();}}
});

test('syncing a reporter reply queues exactly one fresh reassessment, never a repair',async()=>{
 const f=setup();try{
  await f.wb.askReporter(f.job.id);
  f.github.sync=async()=>({repo:f.repo,issues:[{...f.issue,comments:2,updatedAt:'2026-10-28T02:00:00Z'}]});
  f.github.informationReplies=async()=>({partial:false,replies:[{id:456,author:f.issue.author,url:`https://github.com/${f.repo.fullName}/issues/${f.issue.number}#issuecomment-456`,body:'版本 1.0，日志暂时找不到',createdAt:'2026-10-28T02:00:00Z'}]});
  await f.wb.sync(f.repo.fullName);
  const next=f.store.jobs().filter(j=>j.id!==f.job.id);assert.equal(next.length,1);assert.equal(next[0].kind,'triage');assert.equal(next[0].status,'queued');
  assert.ok(f.store.get<Issue>('issues',f.issue.id)?.informationRequests?.[0].reassessmentJobId);
  await f.wb.sync(f.repo.fullName);assert.equal(f.store.jobs().length,2);assert.equal(f.posts(),1);
 }finally{await f.wb.close();}
});
