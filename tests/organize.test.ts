import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.ts';
import {Workbench,revision} from '../src/core/workbench.ts';
import {seedFixture,fixtureAnalysis} from './support/fixtures.ts';
import {publish} from '../src/core/publish.ts';
import type {Issue,Job,Runner} from '../src/core/types.ts';

test('repository organization is local, deduplicated and revision-bound; PR scope is validated',async()=>{
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0];
 const runner:Runner=async({issue,job})=>({result:fixtureAnalysis(issue,job.kind),engine:'fixture'});
 const w=new Workbench(store,await mkdtemp(join(tmpdir(),'mw-organize-')),runner,undefined,false);
 const first=w.organize(repo.id,'agents');assert.equal(first.created.length,1);
 assert.equal(w.organize(repo.id,'agents').reused[0],first.created[0]);
 const j=store.get<Job>('jobs',first.created[0])!;assert.equal(j.kind,'docs');assert.equal(j.issueSnapshot.origin,'repository');
 assert.match(j.instructions!,/AGENTS.md/);assert.equal(j.issueSnapshot.url,`https://github.com/${repo.fullName}`);
 assert.notEqual(revision(j.issueSnapshot,repo,j.kind),revision(j.issueSnapshot,{...repo,headSha:'new'},j.kind));
 assert.throws(()=>w.organize(repo.id,'docs','missing'),/同一仓库/);
 const i=store.issues().find(i=>!i.origin)!;const pr:Issue={...i,id:'test-pr',type:'pr',state:'open'};store.put('issues',pr);
 assert.throws(()=>w.organize(repo.id,'ci',pr.id),/仅支持/);
 const p=w.organize(repo.id,'docs',pr.id);assert.equal(store.get<Job>('jobs',p.created[0])!.issueSnapshot.id,pr.id);
 await w.close();
});

test('repository maintenance cannot publish comments or labels to a synthetic Issue number',async()=>{
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0];const issue={...store.issues()[0],origin:'repository' as const,number:0};
 const job={id:'local',status:'approved',issueSnapshot:issue,result:fixtureAnalysis(issue,'docs')} as Job;
 // Reject before credential lookup/network access.
 await assert.rejects(publish(store,job,repo,'labels'),/仓库整理/);
 store.close();
});

test('real isolated organization patch is preserved and no-change runs complete without fake diffs',async()=>{
 const {git}=await import('../src/core/git.ts');const {writeFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'mw-organize-git-'));await git(root,['init']);await git(root,['config','user.name','Test']);await git(root,['config','user.email','test@example.com']);
 await writeFile(join(root,'README.md'),'# Repository\n');await git(root,['add','.']);await git(root,['commit','-m','initial']);
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0];await git(root,['remote','add','origin',`https://github.com/${repo.fullName}.git`]);store.put('repos',{...repo,localPath:root,headSha:await git(root,['rev-parse','HEAD'])});
 const runner:Runner=async({issue,job})=>{if(issue.organizeMode==='agents')await writeFile(join(job.worktree!,'AGENTS.md'),'# Development\nRead README.md.\n');return {result:fixtureAnalysis(issue,job.kind),engine:'local-fixture'};};
 const w=new Workbench(store,await mkdtemp(join(tmpdir(),'mw-organize-data-')),runner,undefined,false);
 const id=w.organize(repo.id,'agents').created[0];w.pump();await w.drain();const done=store.get<Job>('jobs',id)!;assert.equal(done.status,'awaiting_review',done.error);assert.match(done.patch!,/AGENTS.md/);
 await w.review(id,'approve','verified fixture patch');
 const {GitHub}=await import('../src/core/github.ts');const paths:string[]=[];
 const fake:typeof fetch=async(input,init)=>{const url=String(input);paths.push(url);assert.ok(!url.includes('/issues/0'));if(url.includes('/branches/'))return Response.json({commit:{sha:done.baseSha}});if(url.includes('/pulls?'))return Response.json([]);if(url.endsWith('/pulls') && init?.method==='POST'){const body=JSON.parse(String(init.body));assert.ok(!body.body.includes('Refs #0'));return Response.json({html_url:'https://github.com/test/repo/pull/9'});}throw new Error(url);};
 const old=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture';
 try {const urls=await publish(store,store.get<Job>('jobs',id)!,store.repos()[0],'pr',new GitHub('fixture',fake),async()=> 'mock push');assert.equal(urls.length,1);assert.equal(paths.length,3);} finally {if(old===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=old;}
 const noChange=w.organize(repo.id,'docs').created[0];w.pump();await w.drain();assert.equal(store.get<Job>('jobs',noChange)!.status,'completed');assert.equal(store.get<Job>('jobs',noChange)!.patch,'');
 await w.close();
});
