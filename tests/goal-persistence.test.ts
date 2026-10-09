import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { git } from '../src/core/git.ts';
import { artifactSchemas, asAnalysis } from '../src/core/artifacts.ts';
import { seedFixture } from './support/fixtures.ts';
import type { Runner } from '../src/core/types.ts';
const common={schemaVersion:1,summary:'Goal fixture',coverage:'owned fixture',evidence:[],nextSteps:[],responseDraft:''};
for (const status of ['passed','failed'] as const) test(`explicit goal resumes after restart and ${status} verification routes correctly`, async t => {
 const dir=await mkdtemp(join(tmpdir(),'mw-goal-')),path=join(dir,'repo'),db=join(dir,'workbench.sqlite');await mkdir(path);
 await git(path,['init','-b','main']);await git(path,['remote','add','origin','https://github.com/fixture/queue.git']);await writeFile(join(path,'value.txt'),'before\n');await git(path,['add','.']);await git(path,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','baseline']);const sha=await git(path,['rev-parse','HEAD']);
 let calls=0;
 const gh=new GitHub('fixture',async (_url,init) => {assert.ok(!init?.method || init.method==='GET');return Response.json({sha});});
 const runner:Runner=async ({job}) => {
  calls++;let artifact;
  if(job.kind==='fix') {await writeFile(join(job.worktree!,'value.txt'),'after\n');artifact=artifactSchemas.fix.parse({...common,stage:'fix',changes:['value'],acceptanceCriteria:[],limitations:[],tests:[]});}
  else if(job.kind==='validate') artifact=artifactSchemas.validate.parse({...common,stage:'validate',environment:'Local',tests:[{command:'node test.cjs',status,output:'controlled'}],blockers:[]});
  else artifact=artifactSchemas.review.parse({...common,stage:'review',findings:[],verdict:'no_findings',blockers:[]});
  return {artifact,result:asAnalysis(artifact),engine:'controlled goal fixture'};
 };
 const first=new Store(db);seedFixture(first);first.put('repos',{...first.repos()[0],headSha:sha,localPath:path});const issue=first.issues()[0];const w=new Workbench(first,dir,runner,gh,false);
 const root=w.enqueue([issue.id],'fix',{goal:'resolve'}).created[0];await w.close();
 const store=new Store(db),resumed=new Workbench(store,dir,runner,gh,false);t.after(async()=>{await resumed.close();await rm(dir,{recursive:true,force:true});});
 resumed.pump();await resumed.drain();const jobs=store.jobs();
 assert.equal(jobs.length,status==='passed'?3:2,JSON.stringify(jobs.map(j=>({kind:j.kind,error:j.error,pause:j.goalPauseReason}))));
 assert.ok(jobs.every(j=>j.goalId===root));assert.ok(jobs.every(j=>!j.publications));
 const latest=jobs.at(-1)!;assert.equal(latest.kind,status==='passed'?'review':'validate');assert.ok(latest.goalPauseReason);
 const before=calls;resumed.pump();await resumed.drain();assert.equal(calls,before);assert.equal(store.jobs().length,jobs.length);
});
