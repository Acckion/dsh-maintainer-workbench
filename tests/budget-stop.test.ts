import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/core/store.ts';
import {Workbench} from '../src/core/workbench.ts';
import {git} from '../src/core/git.ts';
import {seedFixture} from './support/fixtures.ts';
import {BudgetStopError,budgetStopArtifact} from '../src/core/budget-stop.ts';
import {settingsSchema} from '../src/application/tasks.ts';
import type {Job,ExecutionRecord} from '../src/core/types.ts';
const record={id:'read-1',tool:'read',sourcePath:'README.md',isError:false,output:'# Document',exitCode:null} as ExecutionRecord;
test('partial reports retain actual coverage, never resolve findings or claim validation/review success',()=>{
 for(const kind of ['investigate','review','docs','fix','validate','ci'] as const){
  const job={id:'j',kind,maintenanceScope:['README.md'],worktree:'/repo'} as Job;
  const raw=kind==='investigate'?JSON.stringify({schemaVersion:1,stage:kind,summary:'Ready',coverage:'all',evidence:[],nextSteps:[],responseDraft:'publish',facts:[],hypotheses:[],reproduction:'',rootCause:'',impact:'',proposedChanges:[],acceptanceCriteria:[],blockers:[],maintenance:{complete:true,checkedPaths:['README.md','invented.md'],findings:[]}}):'';
  const artifact=budgetStopArtifact(job,'limit',[record],'/repo',raw);
  if(artifact.stage==='investigate'){assert.equal(artifact.maintenance?.complete,false);assert.deepEqual(artifact.maintenance?.checkedPaths,['README.md']);}
  if(artifact.stage==='review')assert.equal(artifact.verdict,'incomplete');
  assert.equal(artifact.responseDraft,'');assert.equal(artifact.inputRequest,undefined);
  if('tests' in artifact)assert.ok(artifact.tests.every(t=>t.status!=='passed'));
 }
});
test('tool allowance migrates old settings and rejects invalid overrides',()=>{
 const store=new Store(':memory:');const defaults=store.settings();assert.equal(settingsSchema.parse(defaults).toolCallLimit,0);
 assert.equal(settingsSchema.parse({...defaults,toolCallLimit:200}).toolCallLimit,200);
 for(const bad of [-1,1,9,1001,1.5])assert.throws(()=>settingsSchema.parse({...defaults,toolCallLimit:bad}));store.close();
});
for(const mode of ['budget','timeout','cancel'])test(`worker saves partial audit and actual checked paths without marking success: ${mode}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mw-budget-stop-'));await git(dir,['init','-b','main']);await writeFile(join(dir,'README.md'),'# Document');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','baseline']);
 const store=new Store(':memory:');seedFixture(store);const repo={...store.repos()[0],localKind:'git' as const,mode:'local' as const,localPath:dir,headSha:await git(dir,['rev-parse','HEAD'])};store.put('repos',repo);
 if(mode==='timeout')store.put('settings',{id:'main',...store.settings(),timeoutMs:300});
 const w=new Workbench(store,dir,async input=>{
  const r={...record,jobId:input.job.id,sessionId:'s',seq:1,callId:'c',cwd:dir,checkoutSha:input.job.baseSha,recordedAt:new Date().toISOString(),truncated:false};input.recordExecution?.(r,'read');
  if(mode==='cancel')setTimeout(()=>w.cancel(input.job.id),30);
  if(mode!=='budget')await new Promise((_,reject)=>{input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});});
  throw new BudgetStopError('查阅额度已到',budgetStopArtifact(input.job,'查阅额度已到',[r],dir));
 },undefined,false);
 try{
  const id=(await w.maintenance.audit(repo.id,['README.md'])).created[0];w.pump();await w.drain();const job=store.get<Job>('jobs',id)!;
  assert.equal(job.status,mode==='cancel'?'cancelled':'failed');assert.equal(job.budgetStopped,true);assert.equal(job.artifact?.stage,'investigate');
  const scan=store.maintenance.scanByJob(id)!;assert.equal(scan.state,'partial');assert.equal(scan.complete,false);assert.deepEqual(scan.checkedPaths,['README.md']);
  assert.ok(job.executionRecords?.length);assert.match(job.artifact!.summary,/未完成/);
 }finally{await w.close();await rm(dir,{recursive:true,force:true});}
});
test('budget-stopped implementation keeps its actual patch and developer edits, with no validation or review continuation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mw-budget-patch-'));await git(dir,['init','-b','main']);await writeFile(join(dir,'README.md'),'# Original');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','baseline']);
 const store=new Store(':memory:');seedFixture(store);const repo={...store.repos()[0],mode:'local' as const,localKind:'git' as const,localPath:dir,headSha:await git(dir,['rev-parse','HEAD'])};store.put('repos',repo);await writeFile(join(dir,'README.md'),'# Developer work');
 const w=new Workbench(store,join(dir,'state'),async input=>{assert.equal(input.job.kind,'docs');await writeFile(join(input.job.worktree!,'README.md'),'# Partial task edit');throw new BudgetStopError('工具预算耗尽',budgetStopArtifact(input.job,'工具预算耗尽',[],input.job.worktree!));},undefined,false);
 try{
  const plan=await w.maintenance.plan({repoId:repo.id,mode:'docs',paths:['README.md'],goal:'Update README',acceptanceCriteria:['Accurate docs']});const id=(await w.maintenance.startPlan(plan.id,plan.stamp,w)).created[0];w.pump();await w.drain();
  const job=store.get<Job>('jobs',id)!;assert.equal(job.status,'failed');assert.equal(job.budgetStopped,true);assert.match(job.patch??'',/Partial task edit/);assert.ok(job.patchSha256);
  assert.equal(store.jobs().filter(j=>['validate','review'].includes(j.kind)).length,0);assert.equal(await readFile(join(dir,'README.md'),'utf8'),'# Developer work');
 }finally{await w.close();await rm(dir,{recursive:true,force:true});}
});
