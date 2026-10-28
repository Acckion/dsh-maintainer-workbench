import test from 'node:test';
import assert from 'node:assert/strict';
import {pushRepository,commentText,assertIssueFresh} from '../src/core/publish.ts';
import {GitHub} from '../src/core/github.ts';
import {Store} from '../src/core/store.ts';
import {seedFixture,fixtureAnalysis} from './support/fixtures.ts';
import type {Job} from '../src/core/types.ts';

test('fork push checks exact source identity and write permission, never grants upstream access',async()=>{
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0];
 const job={prContext:{headRepo:'contributor/fork'}} as Job;
 try{for(const response of [{full_name:'contributor/fork',permissions:{push:false}},{full_name:'contributor/fork'},{full_name:'other/repo',permissions:{push:true}}]){
  const gh=new GitHub('fixture',async()=>Response.json(response));
  await assert.rejects(pushRepository(job,repo,'update_pr',gh),/没有.*推送.*权限/);
 }
 await assert.rejects(pushRepository({prContext:{headRepo:''}} as Job,repo,'update_pr',new GitHub()),/无法确定/);
 }finally{store.close();}
});

test('repair reply ignores an earlier review draft and preserves an explicitly bound edit',()=>{
 const store=new Store(':memory:');seedFixture(store);const issue=store.issues()[0];
 const job={id:'repair',issueId:issue.id,kind:'fix',result:{...fixtureAnalysis(issue,'fix'),summary:'Duplicate notification fixed',responseDraft:''}} as Job;
 try{store.saveDraft(issue.id,{reply:'Please fix duplicate payments'});assert.match(commentText(store,job),/Duplicate notification fixed/);assert.doesNotMatch(commentText(store,job),/Please fix/);
 store.saveDraft(issue.id,{reply:'Verified repair reply',replyJobId:job.id});assert.equal(commentText(store,job),'Verified repair reply');
 assert.doesNotMatch(commentText(store,{...job,id:'another-repair'}),/Verified repair reply/);
 }finally{store.close();}
});

test('only exact confirmed publication in the same source lineage permits updated remote timestamp',()=>{
 const store=new Store(':memory:');seedFixture(store);const issue=store.issues()[0];
 const source={id:'review',repoId:issue.repoId,issueId:issue.id,caseId:'same',publications:{comment:{status:'published',at:'2026-10-28',remoteUpdatedAt:'own-comment',urls:[]}}} as unknown as Job;
 const fix={...source,id:'fix',sourceJobId:source.id,issueSnapshot:issue,publications:undefined} as Job;
 try{store.put('jobs',source);assert.doesNotThrow(()=>assertIssueFresh(store,fix,'own-comment'));
 assert.throws(()=>assertIssueFresh(store,fix,'external-change'),/已更新/);
 assert.throws(()=>assertIssueFresh(store,{...fix,caseId:'other'},'own-comment'),/已更新/);
 store.put('jobs',{...source,publications:{comment:{...source.publications!.comment!,status:'failed'}}});assert.throws(()=>assertIssueFresh(store,fix,'own-comment'),/已更新/);
 }finally{store.close();}
});
