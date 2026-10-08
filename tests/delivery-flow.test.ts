import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../src/core/store.ts';
import { Workbench, revision } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { git } from '../src/core/git.ts';
import { artifactSchemas, asAnalysis } from '../src/core/artifacts.ts';
import { validationState } from '../src/core/workflow-state.ts';
import { resolveDelivery } from '../src/core/delivery.ts';
import { publish } from '../src/core/publish.ts';
import { Attention } from '../src/client/Attention.tsx';
import { WorkflowPanel } from '../src/client/WorkflowPanel.tsx';
import { seedFixture } from './support/fixtures.ts';
import type { Job, Runner } from '../src/core/types.ts';
const common = { schemaVersion:1, summary:'controlled result', coverage:'owned fixture', evidence:[], nextSteps:[], responseDraft:'' };
const validation = (status:'passed'|'failed'|'not_run') => artifactSchemas.validate.parse({ ...common, stage:'validate', environment:'owned fixture', tests:[{command:'node test.cjs',status,output:'fixture report'}], blockers:[] });
async function setup(t:TestContext, validationStatus:'passed'|'failed'|'not_run'='passed') {
  const dir=await mkdtemp(join(tmpdir(),'mw-delivery-')),path=join(dir,'repo');await mkdir(path);
  await git(path,['init','-b','main']);await git(path,['remote','add','origin','https://github.com/fixture/queue.git']);await writeFile(join(path,'value.txt'),'before\n');await git(path,['add','.']);await git(path,['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','initial']);const sha=await git(path,['rev-parse','HEAD']);
  const store=new Store(':memory:');seedFixture(store);store.put('repos',{...store.repos()[0],headSha:sha,localPath:path});const issue=store.issues()[0];let remoteSha=sha, writes=0;
  const gh=new GitHub('fixture',async(_url,init)=>{if(init?.method&&init.method!=='GET'){writes++;throw Error('No external writes in this test');}return Response.json({sha:remoteSha});});
  const runner:Runner=async({job})=>{let artifact;if(job.kind==='fix'){await writeFile(join(job.worktree!,'value.txt'),'after\n');artifact=artifactSchemas.fix.parse({...common,stage:'fix',changes:['value'],acceptanceCriteria:[],limitations:[],tests:[]});}else if(job.kind==='validate')artifact=validation(validationStatus);else artifact=artifactSchemas.review.parse({...common,stage:'review',findings:[],verdict:'no_findings',blockers:[]});return{artifact,result:asAnalysis(artifact),engine:'controlled test'};};
  const w=new Workbench(store,dir,runner,gh,false);
  const run=async(kind:Job['kind'],sourceJobId?:string)=>{const id=w.enqueue([issue.id],kind,{sourceJobId}).created[0];w.pump();await w.drain();const job=store.get<Job>('jobs',id)!;assert.notEqual(job.status,'failed',job.error);return job;};
  const fix=await run('fix'),check=await run('validate',fix.id);
  t.after(async()=>{await w.close();await rm(dir,{recursive:true,force:true});});
  return{store,w,gh,fix,check,issue,repo:store.repos()[0],run,setRemote:(value:string)=>{remoteSha=value;},writes:()=>writes};
}

test('failed or incomplete validation stays in attention and routes back to corrective work',async t=>{
  const f=await setup(t,'failed');const state=f.w.snapshot();const item=state.issues.find(i=>i.id===f.issue.id)!;
  assert.equal(f.check.status,'completed');assert.equal(item.workflow?.stage,'blocked');assert.match(item.workflow?.reason??'',/验证失败/);
  assert.match(renderToStaticMarkup(React.createElement(Attention,{state,open:()=>{}})),/1 个需要判断/);
  const markup=renderToStaticMarkup(React.createElement(WorkflowPanel,{issue:item,job:f.check,history:state.jobs,busy:false,act:async()=>{}}));
  assert.match(markup,/下一步：实施变更/);assert.doesNotMatch(markup,/下一步：代码审查/);
  assert.equal(validationState(validation('not_run'))?.state,'incomplete');assert.equal(validationState(validation('passed'))?.state,'passed');
  // Legacy saved workflow labels also stay visible when the latest validation failed.
  const legacy={...state,issues:state.issues.map(i=>i.id===item.id?{...i,workflow:{stage:'validate',reason:'legacy label',updatedAt:'now'}}:i)};
  assert.match(renderToStaticMarkup(React.createElement(Attention,{state:legacy,open:()=>{}})),/1 个需要判断/);
});

test('a failed exact-patch validation blocks direct acceptance of its implementation without rewriting history',async t=>{
  const f=await setup(t,'failed');
  for (const note of ['first blocked approval','repeated blocked approval']) await assert.rejects(f.w.review(f.fix.id,'approve',note),/最新.*验证|完整验证/);
  assert.equal(f.store.get<Job>('jobs',f.fix.id)?.status,'awaiting_review');
  assert.equal(f.writes(),0);
});

test('approved independent review returns the exact implementation without approving or publishing it',async t=>{
  const f=await setup(t);const review=await f.run('review',f.check.id);const result=await f.w.review(review.id,'approve','reviewed the recorded patch');
  assert.equal(result.delivery?.implementationJobId,f.fix.id);assert.equal(result.delivery?.validationJobId,f.check.id);
  const target=f.store.get<Job>('jobs',f.fix.id)!;assert.equal(target.status,'awaiting_review');assert.equal(target.deliveryReviewId,review.id);assert.equal(f.writes(),0);assert.equal(target.publications,undefined);
  assert.equal((await resolveDelivery(f.store,f.repo,review.id,f.gh)).implementationJobId,f.fix.id);
});

for(const status of ['failed','not_run'] as const)test(`${status} validation cannot be handed off as publication-ready`,async t=>{
  const f=await setup(t,status);const review=await f.run('review',f.check.id);const result=await f.w.review(review.id,'approve','accepted report only');
  assert.equal(result.delivery,undefined);assert.match(result.deliveryBlockedReason??'',/验证尚未通过/);assert.equal(f.store.get<Job>('jobs',f.fix.id)?.deliveryReviewId,undefined);assert.equal(f.writes(),0);
});

for(const change of ['implementation-patch','review-patch','branch','head','source-version','remote-base','cross-item','revoke-review','review-target','shared-workspace'] as const)test(`delivery rejects ${change} drift`,async t=>{
  const f=await setup(t);const review=await f.run('review',f.check.id);await f.w.review(review.id,'approve','accepted');
  if(change==='implementation-patch')await writeFile(join(f.fix.worktree!,'value.txt'),'tampered\n');
  if(change==='review-patch')await writeFile(join(review.worktree!,'value.txt'),'tampered review\n');
  if(change==='branch')await git(f.fix.worktree!,['branch','-m','unrelated-branch']);
  if(change==='head')await git(f.fix.worktree!,['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','unreviewed history']);
  if(change==='source-version')f.store.put('issues',{...f.issue,updatedAt:'changed'});
  if(change==='remote-base')f.setRemote('b'.repeat(40));
  if(change==='cross-item')f.store.put('jobs',{...f.store.get<Job>('jobs',f.check.id)!,issueId:'another-item'});
  if(change==='revoke-review')f.store.put('jobs',{...f.store.get<Job>('jobs',review.id)!,status:'rejected'});
  if(change==='shared-workspace')f.store.put('jobs',{...f.store.get<Job>('jobs',review.id)!,worktree:f.fix.worktree,branch:f.fix.branch});
  if(change==='review-target')f.store.put('jobs',{...f.store.get<Job>('jobs',review.id)!,sourceJobId:f.fix.id});
  await assert.rejects(resolveDelivery(f.store,f.repo,review.id,f.gh));assert.equal(f.writes(),0);
});

test('publication rechecks its review binding after implementation approval and performs no write when revoked',async t=>{
  const f=await setup(t);const review=await f.run('review',f.check.id);await f.w.review(review.id,'approve','review complete');await f.w.review(f.fix.id,'approve','implementation accepted');
  f.store.put('jobs',{...f.store.get<Job>('jobs',review.id)!,status:'rejected'});
  const token=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture';try{await assert.rejects(publish(f.store,f.store.get<Job>('jobs',f.fix.id)!,f.repo,'pr',f.gh),/审查尚未批准/);}finally{if(token===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=token;}
  assert.equal(f.writes(),0);
});

test('same SHA on a renamed PR branch cannot reuse a review bound to the previous target',async t=>{
  const f=await setup(t);const review=await f.run('review',f.check.id);
  const issue={...f.issue,type:'pr' as const,headSha:f.repo.headSha,prBaseSha:f.repo.headSha};f.store.put('issues',issue);
  const pr={headSha:f.repo.headSha,baseSha:f.repo.headSha,headRef:'topic',headRepo:f.repo.fullName,baseRef:'main',draft:false,merged:false,mergeable:true,checks:[],reviews:[],warnings:[]};
  for(const prior of [f.fix,f.check,review]){const current=f.store.get<Job>('jobs',prior.id)!;f.store.put('jobs',{...current,issueSnapshot:issue,revision:revision(issue,f.repo,current.kind),prContext:pr,...(prior.id===review.id?{status:'approved' as const}:{})});}
  f.gh.pullRequest=async()=>({...pr,headRef:'renamed-topic'});
  await assert.rejects(resolveDelivery(f.store,f.repo,review.id,f.gh),/目标分支已变化/);assert.equal(f.writes(),0);
});

test('review revoked during a later freshness await cannot produce a comment POST',async t=>{
  const f=await setup(t);const review=await f.run('review',f.check.id);await f.w.review(review.id,'approve','accepted');await f.w.review(f.fix.id,'approve','accepted');
  const impl=f.store.get<Job>('jobs',f.fix.id)!;f.store.put('jobs',{...impl,result:{...impl.result!,responseDraft:'Reviewed delivery update'}});
  const original=f.gh.request.bind(f.gh);let posts=0;
  f.gh.request=async(path,init)=>{if(init?.method==='POST'){posts++;return{html_url:'https://github.com/fixture/queue/issues/128#comment'};}if(path.endsWith('/issues/128')){f.store.put('jobs',{...f.store.get<Job>('jobs',review.id)!,status:'rejected'});return{updated_at:f.issue.updatedAt};}if(path.includes('/comments?'))return[];return original(path,init);};
  const token=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture';try{await assert.rejects(publish(f.store,f.store.get<Job>('jobs',f.fix.id)!,f.repo,'comment',f.gh),/发布前已变化/);}finally{if(token===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=token;}
  assert.equal(posts,0);assert.equal(f.store.get<Job>('jobs',review.id)?.status,'rejected');
});

test('approval does not overwrite a concurrent finding disposition during its async checks',async t=>{
  const f=await setup(t);const review=await f.run('review',f.check.id);
  const issue={...f.issue,type:'pr' as const,headSha:f.repo.headSha,prBaseSha:f.repo.headSha};f.store.put('issues',issue);
  const pr={headSha:f.repo.headSha,baseSha:f.repo.headSha,headRef:'topic',headRepo:f.repo.fullName,baseRef:'main',draft:false,merged:false,mergeable:true,checks:[],reviews:[],warnings:[]};
  for(const old of [f.fix,f.check,review]){const current=f.store.get<Job>('jobs',old.id)!;f.store.put('jobs',{...current,issueSnapshot:issue,revision:revision(issue,f.repo,current.kind),prContext:pr});}
  const artifact=artifactSchemas.review.parse({...common,stage:'review',verdict:'changes_requested',blockers:[],findings:[{id:'f1',title:'needs a decision',severity:'P2',path:'value.txt',line:1,trigger:'fixture',evidence:'fixture',recommendation:'inspect'}]});
  f.store.put('jobs',{...f.store.get<Job>('jobs',review.id)!,artifact,result:asAnalysis(artifact),findingDecisions:{f1:'dismissed'}});
  f.gh.pullRequest=async()=>{f.w.finding(review.id,'f1','needs_evidence');return pr;};
  await assert.rejects(f.w.review(review.id,'approve','old decision'),/审核期间产物状态/);
  assert.equal(f.store.get<Job>('jobs',review.id)?.findingDecisions?.f1,'needs_evidence');assert.equal(f.store.get<Job>('jobs',review.id)?.status,'awaiting_review');
});

test('bound PR update can reconcile its own saved commit after a lost confirmation without a second commit',async t=>{
  const f=await setup(t);const review=await f.run('review',f.check.id);
  const issue={...f.issue,type:'pr' as const,headSha:f.repo.headSha,prBaseSha:f.repo.headSha,url:'https://github.com/fixture/queue/pull/128'};f.store.put('issues',issue);
  const pr={headSha:f.repo.headSha,baseSha:f.repo.headSha,headRef:'topic',headRepo:f.repo.fullName,baseRef:'main',draft:false,merged:false,mergeable:true,checks:[],reviews:[],warnings:[]};
  for(const old of [f.fix,f.check,review]){const current=f.store.get<Job>('jobs',old.id)!;f.store.put('jobs',{...current,issueSnapshot:issue,revision:revision(issue,f.repo,current.kind),prContext:pr});}
  let head=pr.headSha,remoteUpdatedAt=issue.updatedAt,loseConfirmation=false,pushes=0,posts=0;
  f.gh.pullRequest=async()=>{if(loseConfirmation){loseConfirmation=false;throw Error('lost confirmation');}return{...pr,headSha:head};};
  f.gh.request=async(_path,init)=>{if(init?.method==='POST')posts++;return{updated_at:remoteUpdatedAt};};
  await f.w.review(review.id,'approve','reviewed');await f.w.review(f.fix.id,'approve','implementation approved');
  const remote=join(f.repo.localPath,'..','remote.git');await git(f.repo.localPath,['init','--bare',remote]);await git(f.repo.localPath,['push',remote,'HEAD:refs/heads/topic']);
  const push:typeof git=async(cwd,args)=>{pushes++;await git(cwd,['push',remote,args[2]]);head=await git(cwd,['rev-parse','HEAD']);if(pushes===1){loseConfirmation=true;remoteUpdatedAt='2026-10-06T00:00:00Z';}return'';};
  const token=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture';try{
    await assert.rejects(publish(f.store,f.store.get<Job>('jobs',f.fix.id)!,f.repo,'update_pr',f.gh,push),/lost confirmation/);
    const committed=f.store.get<Job>('jobs',f.fix.id)!.publishedCommit;assert.equal(committed,head);
    const urls=await publish(f.store,f.store.get<Job>('jobs',f.fix.id)!,f.repo,'update_pr',f.gh,push);
    assert.deepEqual(urls,[issue.url]);assert.equal(f.store.get<Job>('jobs',f.fix.id)!.publishedCommit,committed);assert.equal(await git(remote,['rev-parse','refs/heads/topic']),committed);assert.equal(posts,0);assert.equal(pushes,1);assert.equal(f.store.get<Job>('jobs',f.fix.id)?.publications?.update_pr?.remoteUpdatedAt,remoteUpdatedAt);
  }finally{if(token===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=token;}
});

test('ordinary PR review cannot publish stale findings changed during the final review-list await',async()=>{
  const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue={...store.issues()[0],type:'pr' as const,url:'https://github.com/fixture/queue/pull/128'};
  const artifact=artifactSchemas.review.parse({...common,stage:'review',verdict:'changes_requested',blockers:[],findings:[{id:'f1',title:'candidate finding',severity:'P2',path:'value.txt',line:1,trigger:'fixture',evidence:'fixture',recommendation:'inspect'}]});
  const pr={headSha:repo.headSha,baseSha:repo.headSha,headRef:'topic',headRepo:repo.fullName,baseRef:'main',draft:false,merged:false,mergeable:true,checks:[],reviews:[],warnings:[]};
  const job:Job={id:'ordinary-review',repoId:repo.id,issueId:issue.id,issueSnapshot:issue,kind:'review',status:'approved',revision:revision(issue,repo,'review'),baseSha:repo.headSha,attempt:1,createdAt:'now',updatedAt:'now',artifact,result:asAnalysis(artifact),findingDecisions:{f1:'accepted'},prContext:pr};store.put('issues',issue);store.put('jobs',job);let posts=0;
  const gh=new GitHub('fixture',async(input,init)=>{const url=String(input);if(init?.method==='POST'){posts++;return Response.json({html_url:issue.url+'#review'});}if(url.endsWith('/pulls/128'))return Response.json({head:{sha:pr.headSha,ref:pr.headRef,repo:{full_name:pr.headRepo}},base:{sha:pr.baseSha,ref:pr.baseRef},draft:false,merged:false,mergeable:true});if(url.endsWith('/issues/128'))return Response.json({updated_at:issue.updatedAt});if(url.includes('/reviews?per_page=100&page='))store.put('jobs',{...store.get<Job>('jobs',job.id)!,status:'awaiting_review',findingDecisions:{f1:'needs_evidence'}});return Response.json([]);});
  const token=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture';try{await assert.rejects(publish(store,job,repo,'review',gh),/审批或产物内容已变化/);assert.equal(posts,0);assert.equal(store.get<Job>('jobs',job.id)?.findingDecisions?.f1,'needs_evidence');}finally{store.close();if(token===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=token;}
});

test('remote base drift during publication checks prevents even a branch push', async t => {
  const f = await setup(t); await f.w.review(f.fix.id, 'approve', 'approve saved implementation');
  let remoteHead = f.repo.headSha, pushes = 0, posts = 0;
  f.gh.request = async (path, init) => {
    if (init?.method === 'POST') { posts++; return { html_url: 'https://github.com/fixture/queue/pull/1' }; }
    if (path.includes('/commits/')) return { sha: remoteHead };
    if (path.endsWith(`/issues/${f.issue.number}`)) { remoteHead = 'b'.repeat(40); return { updated_at: f.issue.updatedAt }; }
    if (path.includes('/pulls?')) return [];
    throw Error('Unexpected fixture request ' + path);
  };
  const token = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'fixture';
  try {
    await assert.rejects(publish(f.store, f.store.get<Job>('jobs', f.fix.id)!, f.repo, 'pr', f.gh, async () => { pushes++; return ''; }), /代码基线.*变化/);
    assert.equal(pushes, 0); assert.equal(posts, 0);
  } finally { if (token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = token; }
});
