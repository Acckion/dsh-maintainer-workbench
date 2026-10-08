import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverWorkspace,githubRemote} from '../src/core/workspace-discovery.ts';
import {git} from '../src/core/git.ts';
import {Store} from '../src/core/store.ts';
import {Workbench} from '../src/core/workbench.ts';
import {fixtureAnalysis} from './support/fixtures.ts';
import type {Runner} from '../src/core/types.ts';

test('host workspace discovery handles folders, nested git roots, remotes and owned-task exclusion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mw-discover-')),data=join(root,'plugin-data');await mkdir(data);
 assert.equal((await discoverWorkspace(root,data))?.localKind,'folder');
 await git(root,['init']);await git(root,['config','user.name','Test']);await git(root,['config','user.email','test@example.com']);await writeFile(join(root,'README.md'),'hello');await git(root,['add','.']);await git(root,['commit','-m','initial']);await mkdir(join(root,'src'));
 const a=await discoverWorkspace(root,data),b=await discoverWorkspace(join(root,'src'),data);assert.equal(a?.id,b?.id);assert.equal(a?.githubName,undefined);
 await git(root,['remote','add','origin','git@github.com:owner/repo.git']);assert.equal((await discoverWorkspace(root,data))?.githubName,'owner/repo');
 await git(root,['remote','add','upstream','https://github.com/upstream/repo.git']);assert.equal((await discoverWorkspace(root,data))?.githubName,undefined);
 assert.equal(await discoverWorkspace(data,data),undefined);assert.equal(githubRemote('https://token@github.com/owner/repo'),undefined);
});

test('automatic discovery needs no GitHub and read-only local audit uses the actual workspace',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mw-folder-'));await writeFile(join(root,'README.md'),'# Local folder');
 const data=await mkdtemp(join(tmpdir(),'mw-folder-data-'));const store=new Store(':memory:');
 const runner:Runner=async({job,issue})=>{assert.equal(job.analysisPath,await realpath(root));assert.equal(job.worktree,undefined);return {result:fixtureAnalysis(issue,job.kind),engine:'local'};};
 const w=new Workbench(store,data,runner,undefined,false);await w.discover([root,root]);assert.equal(store.repos().length,1);const repo=store.repos()[0];assert.equal(store.jobs().length,0);
 assert.throws(()=>w.organize(repo.id,'agents'),/Git 提交/);
 const id=w.organize(repo.id,'audit').created[0];w.pump();await w.drain();const job=store.jobs().find(j=>j.id===id)!;assert.equal(job.status,'completed',job.error);await w.close();
});
