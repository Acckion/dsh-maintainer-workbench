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
