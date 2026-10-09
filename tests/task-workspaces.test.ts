import test from 'node:test';
import assert from 'node:assert/strict';
import type {Context} from '@deepseek-ai/cordis';
import type {Job} from '../src/core/types.ts';
import {organizeTaskWorkspaces,taskWorkspaceTitle,taskDatabaseAvailable} from '../src/plugin/task-workspaces.ts';
import {Store} from '../src/core/store.ts';
import {seedFixture} from './support/fixtures.ts';

test('only owned lightweight workspace registrations are removed; complex work and foreign sessions stay',async()=>{
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue=store.issues()[0];
 const job:Job={id:'owned',repoId:repo.id,issueId:issue.id,issueSnapshot:issue,kind:'triage',status:'completed',analysisPath:'/tmp/owned',revision:'v',baseSha:repo.headSha,attempt:1,createdAt:'',updatedAt:''};
 const removed:string[]=[],archived:string[]=[],named:string[]=[];
 const workspace=(id:string,path:string,sessions:string[])=>({id,path,sessionIds:sessions,setTitle:async(title:string)=>{named.push(title);}});
 const ctx={workspaceRegistry:{list:()=>[workspace('owned','/tmp/owned',['maintainer-owned']),workspace('foreign','/tmp/foreign',['human']),workspace('complex','/tmp/complex',['maintainer-complex']),workspace('shared','/tmp/shared',['human'])],archiveSession:async(id:string)=>{archived.push(id);},delete:async(id:string)=>{removed.push(id);}}} as unknown as Context;
 await organizeTaskWorkspaces(ctx,[job,{...job,id:'complex',kind:'fix',analysisPath:undefined,worktree:'/tmp/complex'},{...job,id:'shared',analysisPath:'/tmp/shared'}],[repo]);
 assert.deepEqual(removed,['owned']);assert.deepEqual(archived,['maintainer-owned']);assert.deepEqual(named,[`${repo.fullName} · Issue #128 · 实施变更`]);
 assert.ok(!taskWorkspaceTitle(repo,job).includes(job.id));store.close();
});


test('optional historical databases skip cloud-like unallocated files while allowing local SQLite',async()=>{
 const {mkdtemp,open,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(join(tmpdir(),'task-database-'));try {
  const cold=join(dir,'cold.sqlite');const handle=await open(cold,'w');await handle.truncate(4096);await handle.close();
  assert.equal(taskDatabaseAvailable(cold),false);assert.equal(taskDatabaseAvailable(join(dir,'missing.sqlite')),false);
  const local=join(dir,'local.sqlite');const store=new Store(local);assert.equal(taskDatabaseAvailable(local),true);store.close();
  const companion=await open(local+'-shm','w');await companion.truncate(32768);await companion.close();assert.equal(taskDatabaseAvailable(local),false);
  await rm(local+'-shm');assert.equal(taskDatabaseAvailable(local),true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
