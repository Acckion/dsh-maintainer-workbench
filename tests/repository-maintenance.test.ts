import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.ts';
import {Workbench} from '../src/core/workbench.ts';
import {git} from '../src/core/git.ts';
import {seedFixture,fixtureRunner} from './support/fixtures.ts';
import type {Job} from '../src/core/types.ts';
import {findingFingerprint,scopeFingerprint} from '../src/core/maintenance.ts';
import type {MaintenanceInventory,MaintenanceFindingInput} from '../src/domain/maintenance.ts';
const input:MaintenanceFindingInput={key:'setup-command',domain:'docs',kind:'contradiction',title:'启动命令不一致',paths:['README.md'],dependencies:['package.json'],impact:'无法启动',evidence:[{source:'package.json',detail:'declared script'}],recommendation:'更新 README'};
function inventory(repoId:string,files:Record<string,string>):MaintenanceInventory{return {repoId,revision:'a',fingerprint:'inventory',files,assets:[],complete:true,source:'commit',dirty:false,warnings:[],scannedAt:new Date().toISOString()};}
function scanned(store:Store,id:string,findings=[input],options:{complete?:boolean;blocked?:boolean;state?:string;at?:string}={}){
 const inv=store.maintenance.inventory('r')!;
 const at=options.at??'2026-10-19T10:00:00Z';
 store.maintenance.saveScan({id,jobId:id,repoId:'r',revision:inv.revision,scope:['README.md'],fingerprint:scopeFingerprint(inv,['README.md']),inventoryFiles:inv.files,createdAt:at,state:'pending',checkedPaths:[],complete:false});
 store.put('jobs',{id,repoId:'r',issueId:'unused',issueSnapshot:{},kind:'investigate',status:options.state??'completed',updatedAt:at,finishedAt:at,artifact:{stage:'investigate',summary:'Repository check',blockers:options.blocked?['unread source']:[],maintenance:{findings,checkedPaths:['README.md'],complete:options.complete??true}}} as unknown as Job);
}
test('repository findings persist decisions, deduplicate, re-open only on relevant evidence, and require a complete recheck to resolve',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mw-maintenance-state-')),path=join(dir,'state.sqlite');let store=new Store(path);
 store.maintenance.saveInventory(inventory('r',{'README.md':'1','package.json':'2','src/unrelated.ts':'3'}));scanned(store,'first');
 const first=store.maintenance.snapshot('r').findings[0];assert.equal(first.decision,'open');
 store.maintenance.decide('r',first.id,'ignored','历史内容，有意保留',first.fingerprint);
 scanned(store,'same',[input],{at:'2026-10-19T10:01:00Z'});assert.equal(store.maintenance.snapshot('r').findings.length,1);assert.equal(store.maintenance.snapshot('r').findings[0].decision,'ignored');
 store.close();store=new Store(path);assert.equal(store.maintenance.snapshot('r').findings[0].decision,'ignored');
 let inv=store.maintenance.inventory('r')!;inv={...inv,files:{...inv.files,'src/unrelated.ts':'4'}};store.maintenance.saveInventory(inv);assert.equal(store.maintenance.snapshot('r').findings[0].stale,false);
 inv={...inv,files:{...inv.files,'package.json':'changed'}};store.maintenance.saveInventory(inv);assert.equal(store.maintenance.snapshot('r').findings[0].stale,true);
 scanned(store,'changed',[input],{at:'2026-10-19T10:02:00Z'});assert.equal(store.maintenance.snapshot('r').findings[0].decision,'open');
 scanned(store,'partial',[],{complete:false,at:'2026-10-19T10:03:00Z'});assert.equal(store.maintenance.snapshot('r').findings[0].decision,'open');
 scanned(store,'blocked',[],{blocked:true,at:'2026-10-19T10:04:00Z'});assert.equal(store.maintenance.snapshot('r').findings[0].decision,'open');
 scanned(store,'fixed',[],{at:'2026-10-19T10:05:00Z'});assert.equal(store.maintenance.snapshot('r').findings[0].decision,'resolved');
 scanned(store,'late',[input],{at:'2026-10-19T10:00:00Z'});assert.equal(store.maintenance.snapshot('r').findings[0].decision,'resolved');store.close();
});
test('local inventory pins committed content, skips symlinks and does not execute declared commands; scans reuse compatible evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mw-maintenance-inventory-'));await git(dir,['init','-b','main']);
 await writeFile(join(dir,'README.md'),'# Committed\n');await writeFile(join(dir,'package.json'),JSON.stringify({scripts:{test:'touch should-never-exist'}}));await symlink('/etc/passwd',join(dir,'unsafe.md'));await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','initial']);
 const store=new Store(':memory:');seedFixture(store);const original=store.repos()[0];const repo={...original,mode:'local' as const,localKind:'git' as const,localPath:dir,headSha:await git(dir,['rev-parse','HEAD'])};store.put('repos',repo);
 const w=new Workbench(store,await mkdtemp(join(tmpdir(),'mw-maintenance-data-')),fixtureRunner,undefined,false);
 try {
  await writeFile(join(dir,'README.md'),'# Dirty\n');const inv=await w.maintenance.inventory(repo.id);assert.ok(inv.dirty);assert.ok(!inv.files['unsafe.md']);assert.match((await w.maintenance.asset(repo.id,'README.md')).content,/Committed/);assert.equal(await readFile(join(dir,'README.md'),'utf8'),'# Dirty\n');
  const first=await w.maintenance.audit(repo.id,['README.md']);const duplicate=await w.maintenance.audit(repo.id,['README.md']);assert.equal(duplicate.reused[0],first.created[0]);
  await assert.rejects(w.maintenance.audit(repo.id,['../outside']),/不存在/);await assert.rejects(w.maintenance.asset(repo.id,'unsafe.md'),/清单/);
  const old=store.get<Job>('jobs',first.created[0])!;store.put('jobs',{...old,status:'completed',artifact:{schemaVersion:1,stage:'investigate',summary:'No findings',coverage:'README',evidence:[],nextSteps:[],responseDraft:'',facts:[],hypotheses:[],reproduction:'',rootCause:'',impact:'',proposedChanges:[],acceptanceCriteria:[],blockers:[],maintenance:{complete:true,checkedPaths:['README.md'],findings:[]}}});
  assert.equal((await w.maintenance.audit(repo.id,['README.md'])).reused[0],old.id);
  const forced=await w.maintenance.audit(repo.id,['README.md'],'',true);assert.equal(forced.created.length,1);
 }finally{await w.close();}
});

test('confirmed maintenance plans execute once, enforce path bounds, and retain dirty developer files',async()=>{
 const {artifactSchemas,asAnalysis}=await import('../src/core/artifacts.ts');
 const dir=await mkdtemp(join(tmpdir(),'mw-maintenance-plan-'));await git(dir,['init','-b','main']);await writeFile(join(dir,'README.md'),'# Before\n');await writeFile(join(dir,'other.txt'),'original\n');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','initial']);
 const store=new Store(':memory:');seedFixture(store);const repo={...store.repos()[0],mode:'local' as const,localKind:'git' as const,localPath:dir,headSha:await git(dir,['rev-parse','HEAD'])};store.put('repos',repo);
 const common={schemaVersion:1 as const,summary:'Controlled change',coverage:'README',evidence:[],nextSteps:[],responseDraft:''};
 const w=new Workbench(store,await mkdtemp(join(tmpdir(),'mw-maintenance-plan-data-')),async({job})=>{if(job.kind==='docs'){await writeFile(join(job.worktree!,'README.md'),'# Updated\n');await writeFile(join(job.worktree!,'other.txt'),'out of scope\n');}const artifact=artifactSchemas.docs.parse({...common,stage:'docs',changes:['README'],acceptanceCriteria:[],limitations:[],tests:[]});return {artifact,result:asAnalysis(artifact),engine:'fixture'};},undefined,false);
 try {
  await writeFile(join(dir,'README.md'),'# Developer edits\n');
  const plan=await w.maintenance.plan({repoId:repo.id,mode:'docs',paths:['README.md'],goal:'Update README',acceptanceCriteria:['README matches the implementation']});
  const first=await w.maintenance.startPlan(plan.id,plan.stamp,w),again=await w.maintenance.startPlan(plan.id,plan.stamp,w);assert.equal(again.reused[0],first.created[0]);
  w.pump();await w.drain();const done=store.get<Job>('jobs',first.created[0])!;assert.equal(done.status,'failed');assert.match(done.error??'',/超出已确认范围/);assert.ok(done.patch);assert.equal(store.jobs().filter(j=>j.kind==='validate').length,0);
  assert.equal(await readFile(join(dir,'README.md'),'utf8'),'# Developer edits\n');
  await writeFile(join(dir,'other.txt'),'new baseline\n');await git(dir,['add','other.txt']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','baseline']);
  await assert.rejects(w.maintenance.startPlan(plan.id,plan.stamp,w),/版本已变化/);
  await assert.rejects(w.maintenance.plan({repoId:repo.id,mode:'ci',paths:['../outside'],goal:'CI',acceptanceCriteria:['check']}),/仓库内/);
 }finally{await w.close();}
});

test('CI maintenance proceeds through real isolated implementation, validation and review without publishing',async()=>{
 const {artifactSchemas,asAnalysis}=await import('../src/core/artifacts.ts');
 const dir=await mkdtemp(join(tmpdir(),'mw-maintenance-ci-'));await git(dir,['init','-b','main']);await writeFile(join(dir,'README.md'),'# Repository\n');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','initial']);
 const store=new Store(':memory:');seedFixture(store);const repo={...store.repos()[0],mode:'local' as const,localKind:'git' as const,localPath:dir,headSha:await git(dir,['rev-parse','HEAD']),githubName:undefined};store.put('repos',repo);
 const common={schemaVersion:1 as const,summary:'Controlled result',coverage:'Workflow',evidence:[],nextSteps:[],responseDraft:''};
 const kinds:string[]=[];
 const w=new Workbench(store,await mkdtemp(join(tmpdir(),'mw-maintenance-ci-data-')),async({job})=>{kinds.push(job.kind);let artifact;
  if(job.kind==='fix'){await mkdir(join(job.worktree!,'.github/workflows'),{recursive:true});await writeFile(join(job.worktree!,'.github/workflows/check.yml'),'name: Checks\non: push\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo fixture\n');artifact=artifactSchemas.fix.parse({...common,stage:'fix',changes:['Workflow'],acceptanceCriteria:[],limitations:[],tests:[]});}
  else if(job.kind==='validate')artifact=artifactSchemas.validate.parse({...common,stage:'validate',environment:'fixture',tests:[{command:'fixture-check',status:'passed',output:'Controlled test only'}],blockers:[]});
  else artifact=artifactSchemas.review.parse({...common,stage:'review',findings:[],verdict:'no_findings',blockers:[]});
  return {artifact,result:asAnalysis(artifact),engine:'fixture'};
 },undefined,false);
 try{
  const plan=await w.maintenance.plan({repoId:repo.id,mode:'ci',paths:['.github/workflows/check.yml'],goal:'Add checks',acceptanceCriteria:['Minimal read-only workflow']});
  await w.maintenance.startPlan(plan.id,plan.stamp,w);w.pump();await w.drain();assert.deepEqual(kinds,['fix','validate','review']);
  const issue=store.get<import('../src/core/types.ts').Issue>('issues',plan.issueId)!;assert.equal(issue.orchestration?.run?.status,'review');assert.equal(store.jobs().filter(j=>j.publications).length,0);assert.equal(await readFile(join(dir,'README.md'),'utf8'),'# Repository\n');
  assert.equal(store.maintenance.snapshot(repo.id).findings.length,0,'implementation must not fabricate or resolve audit findings');
 }finally{await w.close();}
});

for(const mode of ['docs','agents'] as const)test(`${mode} maintenance uses the real document checker and hands the same patch to independent review`,async()=>{
 const {artifactSchemas,asAnalysis}=await import('../src/core/artifacts.ts');const {collectPatch}=await import('../src/core/git.ts');const {documentCheckCommand}=await import('../src/core/document-acceptance.ts');const {createHash}=await import('node:crypto');const {promisify}=await import('node:util');const {execFile}=await import('node:child_process');const {resolve}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'mw-maintenance-docs-'));await git(dir,['init','-b','main']);await writeFile(join(dir,'README.md'),'# Repository\n\nExisting instructions.\n');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','initial']);
 const store=new Store(':memory:');seedFixture(store);const repo={...store.repos()[0],mode:'local' as const,localKind:'git' as const,localPath:dir,headSha:await git(dir,['rev-parse','HEAD'])};store.put('repos',repo);
 const common={schemaVersion:1 as const,summary:'Controlled result',coverage:'Current patch',evidence:[],nextSteps:[],responseDraft:''};
 const target=mode==='docs'?'README.md':'AGENTS.md';
 const w=new Workbench(store,await mkdtemp(join(tmpdir(),'mw-maintenance-doc-data-')),async({job,progress,recordExecution})=>{let artifact;
  if(job.kind==='docs'){await writeFile(join(job.worktree!,target),mode==='docs'?'# Repository\n\nExisting instructions.\n\nRead the actual package manifest before running commands.\n':'# Development\n\nRead [README](README.md) for repository instructions.\n');artifact=artifactSchemas.docs.parse({...common,stage:'docs',changes:[target],acceptanceCriteria:[],limitations:[],tests:[]});}
  else if(job.kind==='validate'){
   const session='document-fixture-'+job.id;progress('run real document checks',session);const {stdout}=await promisify(execFile)(process.execPath,[resolve('scripts/verify-document-patch.mjs'),job.worktree!,job.baseSha],{cwd:job.worktree});const patch=await collectPatch(job.worktree!,job.baseSha);
   recordExecution?.({id:session+':1',sessionId:session,callId:'1',tool:'bash',command:documentCheckCommand(job),cwd:job.worktree!,checkoutSha:job.baseSha,patchHash:createHash('sha256').update(patch).digest('hex'),exitCode:0,isError:false,recordedAt:new Date().toISOString(),output:stdout,truncated:false},stdout);
   artifact=artifactSchemas.validate.parse({...common,stage:'validate',environment:'real local checker',tests:[],blockers:[]});
  }else artifact=artifactSchemas.review.parse({...common,stage:'review',findings:[],verdict:'no_findings',blockers:[]});
  return {artifact,result:asAnalysis(artifact),engine:'scripted fixture, no model'};
 },undefined,false);
 try{
  const plan=await w.maintenance.plan({repoId:repo.id,mode,paths:[target],goal:'Update '+target,acceptanceCriteria:['Accurate text and valid references']});await w.maintenance.startPlan(plan.id,plan.stamp,w);w.pump();await w.drain();
  const jobs=store.jobs();assert.deepEqual(jobs.map(j=>j.kind),['docs','validate','review']);const validation=jobs[1];assert.equal(validation.artifact?.stage,'validate');if(validation.artifact?.stage==='validate'){assert.deepEqual(validation.artifact.blockers,[]);assert.equal(validation.artifact.tests[0].status,'passed');}
  assert.equal(jobs[0].patch,jobs[1].patch);assert.equal(jobs[1].patch,jobs[2].patch);assert.notEqual(jobs[0].worktree,jobs[1].worktree);assert.notEqual(jobs[1].worktree,jobs[2].worktree);assert.equal(store.get<import('../src/core/types.ts').Issue>('issues',plan.issueId)?.orchestration?.run?.status,'review');
 }finally{await w.close();}
});

test('PR impact checks share the original item, isolate findings, reuse pinned inputs and reject stale plan previews',async()=>{
 const {GitHub}=await import('../src/core/github.ts');
 const dir=await mkdtemp(join(tmpdir(),'mw-maintenance-pr-'));await git(dir,['init','-b','main']);await git(dir,['remote','add','origin','https://github.com/fixture/queue.git']);await writeFile(join(dir,'README.md'),'# Repository\n');await writeFile(join(dir,'package.json'),'{}\n');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','initial']);const base=await git(dir,['rev-parse','HEAD']);
 await writeFile(join(dir,'README.md'),'# Repository\n\nNew behavior.\n');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','topic']);const head=await git(dir,['rev-parse','HEAD']);
 const store=new Store(':memory:');seedFixture(store);const repo={...store.repos()[0],localPath:dir,headSha:base};store.put('repos',repo);const pr={...store.issues()[0],id:'fixture/queue#42',type:'pr' as const,number:42,headSha:head,prBaseSha:base};store.put('issues',pr);
 const gh=new GitHub('fixture',async()=>{throw Error('Unexpected network');});let currentHead=head,currentBase=base;
 gh.pullRequest=async()=>({headSha:currentHead,baseSha:currentBase,headRef:'topic',headRepo:repo.fullName,baseRef:'main',draft:false,merged:false,mergeable:true,checks:[],reviews:[],warnings:[]});
 const w=new Workbench(store,await mkdtemp(join(tmpdir(),'mw-maintenance-pr-data-')),fixtureRunner,gh,false);
 try{
  const result=await w.maintenance.audit(repo.id,['README.md'],'',false,pr.id),job=store.get<Job>('jobs',result.created[0])!;
  assert.equal(job.issueId,pr.id);assert.equal(store.maintenance.scanByJob(job.id)?.revision,head);assert.equal(store.maintenance.inventory(repo.id),undefined,'PR inventory must not replace the repository inventory');
  const artifact={schemaVersion:1 as const,stage:'investigate' as const,summary:'Documentation impact',coverage:'README',evidence:[],nextSteps:[],responseDraft:'',facts:[],hypotheses:[],reproduction:'',rootCause:'',impact:'',proposedChanges:[],acceptanceCriteria:[],blockers:[],maintenance:{complete:true,checkedPaths:['README.md'],findings:[input]}};
  store.put('jobs',{...job,status:'completed',prContext:await gh.pullRequest(repo,42),artifact});
  const f=store.maintenance.snapshot(repo.id).findings[0];assert.equal(f.pr?.issueId,pr.id);assert.equal(f.stale,false);
  assert.equal((await w.maintenance.audit(repo.id,['README.md'],'',false,pr.id)).reused[0],job.id);
  const plan=await w.maintenance.plan({repoId:repo.id,prId:pr.id,mode:'docs',paths:['README.md'],findingIds:[f.id],goal:'Synchronize README',acceptanceCriteria:['Reflect actual public changes']});assert.equal(plan.issueId,pr.id);assert.equal(plan.revision,head);
  currentBase='b'.repeat(40);await assert.rejects(w.maintenance.startPlan(plan.id,plan.stamp,w),/PR 版本已变化/);assert.equal(store.maintenance.snapshot(repo.id).findings[0].stale,true);
  currentBase=base;const started=await w.maintenance.startPlan(plan.id,plan.stamp,w);const original=store.get<import('../src/core/types.ts').Issue>('issues',pr.id)!;assert.equal(original.body,pr.body);assert.equal(original.title,pr.title);assert.equal(original.origin,undefined);assert.equal(store.get<Job>('jobs',started.created[0])?.issueId,pr.id);
  assert.equal((await w.maintenance.startPlan(plan.id,plan.stamp,w)).reused[0],started.created[0]);
  assert.match(store.get<Job>('jobs',started.created[0])?.instructions??'',/actual base\/head diff/);
 }finally{await w.close();}
});

test('a complete PR recheck cannot resolve baseline findings, and incomplete coverage is never accepted as complete',()=>{
 const store=new Store(':memory:');store.maintenance.saveInventory(inventory('r',{'README.md':'1','docs/setup.md':'2','package.json':'3'}));scanned(store,'baseline');
 const baseline=store.maintenance.snapshot('r').findings[0];
 const pr={issueId:'r#1',number:1,headSha:'head',baseSha:'base'};
 store.put('issues',{id:'r#1',repoId:'r',type:'pr',number:1,title:'PR',body:'',author:'test',labels:[],state:'open',comments:0,updatedAt:'now',url:'',headSha:pr.headSha,prBaseSha:pr.baseSha});
 const scan={id:'pr',repoId:'r',jobId:'pr',pr,revision:'head',scope:['README.md'],fingerprint:'pr',inventoryFiles:{'README.md':'1'},createdAt:'2026-10-19T20:00:00Z',state:'pending' as const,checkedPaths:[],complete:false};store.maintenance.saveScan(scan);
 const report={stage:'investigate',summary:'No PR issues',blockers:[],maintenance:{findings:[],checkedPaths:['README.md'],complete:true}};
 store.put('jobs',{id:'pr',repoId:'r',issueId:'r#1',issueSnapshot:{},kind:'investigate',status:'completed',updatedAt:scan.createdAt,prContext:{headSha:'head',baseSha:'base'},artifact:report} as unknown as Job);
 assert.equal(store.maintenance.snapshot('r').findings.find(f=>f.id===baseline.id)?.decision,'open');
 store.maintenance.saveScan({...scan,id:'incomplete',jobId:'incomplete',pr:undefined,scope:[],inventoryFiles:store.maintenance.inventory('r')!.files});
 store.put('jobs',{id:'incomplete',repoId:'r',issueId:'unused',issueSnapshot:{},kind:'investigate',status:'completed',updatedAt:scan.createdAt,artifact:report} as unknown as Job);
 assert.equal(store.maintenance.scanByJob('incomplete')?.state,'partial');assert.equal(store.maintenance.snapshot('r').findings.find(f=>f.id===baseline.id)?.decision,'open');store.close();
});

test('retrying a failed audit retains scan tracking, while dependent source edits invalidate cached checks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mw-maintenance-retry-'));await git(dir,['init','-b','main']);await mkdir(join(dir,'src'));await writeFile(join(dir,'README.md'),'# Repository\n');await writeFile(join(dir,'src/api.ts'),'export const version=1;\n');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','initial']);
 const store=new Store(':memory:');seedFixture(store);const repo={...store.repos()[0],mode:'local' as const,localKind:'git' as const,localPath:dir,headSha:await git(dir,['rev-parse','HEAD'])};store.put('repos',repo);const w=new Workbench(store,await mkdtemp(join(tmpdir(),'mw-maintenance-retry-data-')),fixtureRunner,undefined,false);
 try {
  const id=(await w.maintenance.audit(repo.id,['README.md'])).created[0];const job=store.get<Job>('jobs',id)!;store.put('jobs',{...job,status:'failed',error:'Controlled interruption'});
  const retry=w.retry(id).created[0];assert.ok(store.maintenance.scanByJob(retry));assert.equal(store.maintenance.scanByJob(retry)?.state,'pending');
  store.put('jobs',{...store.get<Job>('jobs',retry)!,status:'completed',artifact:{schemaVersion:1,stage:'investigate',summary:'No drift',coverage:'README + API',evidence:[],nextSteps:[],responseDraft:'',facts:[],hypotheses:[],reproduction:'',rootCause:'',impact:'',proposedChanges:[],acceptanceCriteria:[],blockers:[],maintenance:{complete:true,checkedPaths:['README.md','src/api.ts'],findings:[]}}});
  assert.equal((await w.maintenance.audit(repo.id,['README.md'])).reused[0],retry);
  await writeFile(join(dir,'src/api.ts'),'export const version=2;\n');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','API change']);
  assert.equal((await w.maintenance.audit(repo.id,['README.md'])).created.length,1,'source dependency change must invalidate even a no-findings report');
 }finally{await w.close();}
});
