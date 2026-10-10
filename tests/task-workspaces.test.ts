import test from 'node:test';
import assert from 'node:assert/strict';
import type {Context} from '@deepseek-ai/cordis';
import type {Job} from '../src/core/types.ts';
import {organizeTaskWorkspaces,taskWorkspaceTitle,taskDatabaseAvailable} from '../src/plugin/task-workspaces.ts';
import {Store} from '../src/core/store.ts';
import {seedFixture} from './support/fixtures.ts';

test('completed run registrations are removed for every stage; foreign and repository main areas stay',async()=>{
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue=store.issues()[0];
 const job:Job={id:'owned',repoId:repo.id,issueId:issue.id,issueSnapshot:issue,kind:'triage',status:'completed',analysisPath:'/tmp/analysis/owned',revision:'v',baseSha:repo.headSha,attempt:1,createdAt:'',updatedAt:''};
 const removed:string[]=[],archived:string[]=[],named:string[]=[];
 const workspace=(id:string,path:string,sessions:string[])=>({id,path,sessionIds:sessions,setTitle:async(title:string)=>{named.push(title);}});
 const ctx={workspaceRegistry:{list:()=>[workspace('owned','/tmp/analysis/owned',['maintainer-owned']),workspace('foreign','/tmp/foreign',['human']),workspace('complex','/tmp/worktrees/complex',['maintainer-complex']),workspace('shared','/tmp/shared',['human']),workspace('main','/tmp/repository',['maintainer-main','human','maintainer-category-other'])],archiveSession:async(id:string)=>{archived.push(id);},delete:async(id:string)=>{removed.push(id);}}} as unknown as Context;
 await organizeTaskWorkspaces(ctx,[job,{...job,id:'complex',kind:'fix',analysisPath:undefined,worktree:'/tmp/worktrees/complex'},{...job,id:'shared',analysisPath:'/tmp/shared'},{...job,id:'main',analysisPath:'/tmp/repository'}],[repo]);
 assert.deepEqual(removed,['owned','complex']);assert.deepEqual(archived,['maintainer-owned','maintainer-complex','maintainer-main']);assert.deepEqual(named,[]);
 assert.ok(!taskWorkspaceTitle(repo,job).includes(job.id));store.close();
});

test('running registrations and unproven maintainer-prefixed sessions are never removed',async()=>{
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue=store.issues()[0];
 const job:Job={id:'active',repoId:repo.id,issueId:issue.id,issueSnapshot:issue,kind:'review',status:'running',worktree:'/tmp/worktrees/active',revision:'v',baseSha:repo.headSha,attempt:1,createdAt:'',updatedAt:''};
 const archived:string[]=[],removed:string[]=[];
 const ctx={workspaceRegistry:{list:()=>[
  {id:'active',path:job.worktree,sessionIds:['maintainer-active']},
  {id:'mixed',path:'/tmp/worktrees/mixed',sessionIds:['maintainer-mixed','maintainer-unknown','human']},
 ],archiveSession:async(id:string)=>{archived.push(id);},delete:async(id:string)=>{removed.push(id);}}} as unknown as Context;
 await organizeTaskWorkspaces(ctx,[job,{...job,id:'mixed',status:'completed',worktree:'/tmp/worktrees/mixed'}],[repo]);
 assert.deepEqual(archived,['maintainer-mixed']);assert.deepEqual(removed,[]);store.close();
});


test('optional historical databases allow local SQLite and reject missing or empty files',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(join(tmpdir(),'task-database-'));try {
  const empty=join(dir,'empty.sqlite');await writeFile(empty,'');
  assert.equal(taskDatabaseAvailable(empty),false);assert.equal(taskDatabaseAvailable(dir),false);assert.equal(taskDatabaseAvailable(join(dir,'missing.sqlite')),false);
  const local=join(dir,'local.sqlite');const store=new Store(local);assert.equal(taskDatabaseAvailable(local),true);store.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('optional historical databases skip cloud-like unallocated files on filesystems reporting allocation',async(t)=>{
 const {mkdtemp,open,stat,writeFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(join(tmpdir(),'task-sparse-database-'));try {
  const cold=join(dir,'cold.sqlite');const handle=await open(cold,'w');await handle.truncate(4096);await handle.close();
  if((await stat(cold)).blocks!==0){t.skip('Filesystem does not report sparse allocation via stat.blocks');return;}
  assert.equal(taskDatabaseAvailable(cold),false);
  const local=join(dir,'local.sqlite');await writeFile(local,'allocated fixture');assert.equal(taskDatabaseAvailable(local),true);
  const companion=await open(local+'-shm','w');await companion.truncate(32768);await companion.close();assert.equal(taskDatabaseAvailable(local),false);
  await rm(local+'-shm');assert.equal(taskDatabaseAvailable(local),true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
