import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.ts';
import {Workbench} from '../src/core/workbench.ts';
import {seedFixture,fixtureRunner} from './support/fixtures.ts';
import {GitHub} from '../src/core/github.ts';
test('item drafts survive restart, merge fields and remain isolated from accepted plans and other items',()=>{
 const dir=mkdtempSync(join(tmpdir(),'item-drafts-'));const path=join(dir,'state.db');
 try{let store=new Store(path);seedFixture(store);const issue=store.issues()[0],before=JSON.stringify(issue);
 store.saveDraft(issue.id,{reply:'draft A',plan:{goal:'unconfirmed'}});store.saveDraft(issue.id,{view:'activity'});store.saveDraft('second',{reply:'draft B'});
 assert.equal(JSON.stringify(store.get('issues',issue.id)),before);assert.equal(store.jobs().length,0);store.close();store=new Store(path);
 assert.deepEqual(store.draft(issue.id),{reply:'draft A',plan:{goal:'unconfirmed'},view:'activity'});assert.deepEqual(store.draft('second'),{reply:'draft B'});store.saveDraft(issue.id,{reply:''});assert.equal(store.draft(issue.id).reply,'');assert.equal(store.draft(issue.id).view,'activity');store.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a running task blocks confirmation of a changed plan without destroying the draft',async()=>{
 const store=new Store(':memory:');seedFixture(store);const issue=store.issues()[0],repo=store.repos()[0];const w=new Workbench(store,tmpdir(),fixtureRunner,new GitHub('',async()=>{throw Error('no network');}),false);
 const plan={category:'feature',goal:'new goal',scope:'scope',reproduction:'',expected:'',actual:'',acceptanceCriteria:['check'],decision:'accepted'};
 store.saveDraft(issue.id,{plan});store.put('jobs',{id:'active',repoId:repo.id,issueId:issue.id,issueSnapshot:issue,kind:'fix',status:'running'});
 assert.throws(()=>w.savePlan(issue.id,plan),/先停止任务/);assert.equal(store.get<import('../src/core/types.ts').Issue>('issues',issue.id)?.plan,undefined);assert.deepEqual(store.draft(issue.id).plan,plan);await w.close();
});
