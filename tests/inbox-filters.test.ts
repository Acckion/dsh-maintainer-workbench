import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultInboxFacets as defaults, filterItems, itemLabels } from '../src/client/issue-filters.ts';
import { classifyArtifact, classificationRevision } from '../src/core/classification.ts';
import { artifactPrompt, parseArtifact } from '../src/core/artifacts.ts';
import type { Issue } from '../src/core/types.ts';
const base: Issue={id:'r#1',repoId:'r',number:1,type:'issue',title:'Broken sync',body:'Details',author:'a',labels:['Platform:Mac'],state:'open',comments:0,updatedAt:'2026-10-19T00:00:00Z',url:''};
function item(id:number,category:'bug'|'feature',priority:'P0'|'P1'|'P2'|'P3',labels:string[]=[],changes:Partial<Issue>={}):Issue{return {...base,id:`r#${id}`,number:id,classification:{category,priority,labels,jobId:`j${id}`,updatedAt:base.updatedAt,revision:'r'},...changes};}

test('Issue/PR facets combine category, priority, labels and state, without manufacturing a default classification',()=>{
 const items=[item(1,'bug','P1',['crash']),item(2,'feature','P2',['sync'],{type:'pr'}),item(3,'bug','P1',['crash'],{state:'closed'}),{...base,id:'r#4',number:4},item(5,'bug','P0',[],{origin:'repository'})];
 assert.deepEqual(filterItems(items,{...defaults,category:'bug',priority:'P1',labels:['platform:mac','crash']},'all','').map(i=>i.number),[1]);
 assert.deepEqual(filterItems(items,{...defaults,category:'feature'},'pr','').map(i=>i.number),[2]);
 assert.deepEqual(filterItems(items,{...defaults,priority:'unset'},'all','').map(i=>i.number),[4]);
 assert.deepEqual(filterItems(items,{...defaults,state:'closed'},'all','').map(i=>i.number),[3]);
 assert.equal(filterItems(items,{...defaults,state:'all'},'all','').length,4);
 assert.deepEqual(filterItems(items,defaults,'all','CRASH').map(i=>i.number),[1]);
});
test('multiple labels support any/all, use case-insensitive identity and distinguish remote and local suggestions',()=>{
 const value=item(1,'bug','P1',['platform:mac','crash']);
 assert.deepEqual(itemLabels(value),[{name:'Platform:Mac',source:'github'},{name:'crash',source:'suggested'}]);
 assert.equal(filterItems([value],{...defaults,labels:['crash','missing']},'all','').length,0);
 assert.equal(filterItems([value],{...defaults,labels:['crash','missing'],labelMode:'any'},'all','').length,1);
});
test('stale results remain findable but do not participate in category, priority or suggested label filters',()=>{
 const stale=item(1,'bug','P1',['crash']);stale.classification!.stale=true;
 assert.equal(filterItems([stale],{...defaults,analysis:'stale'},'all','').length,1);
 for(const f of [{category:'bug'},{priority:'P1'},{labels:['crash']},{analysis:'triaged' as const}])assert.equal(filterItems([stale],{...defaults,...f},'all','').length,0);
 assert.equal(filterItems([stale],{...defaults,priority:'unset'},'all','').length,1);
});
test('priority sorting puts unknown last, with updated time as a stable tie breaker',()=>{
 const items=[item(2,'bug','P2'),{...base,id:'r#3',number:3},item(4,'feature','P0'),item(5,'bug','P2')];
 assert.deepEqual(filterItems(items,{...defaults,sort:'priority'},'all','').map(i=>i.number),[4,5,2,3]);
});
test('PR classification is optional for old reports, explicit for new reports, and never sourced from review severity',()=>{
 const old={schemaVersion:1,stage:'preflight',summary:'Intent',coverage:'metadata',evidence:[],nextSteps:[],responseDraft:'',intent:'Add sync',risks:[],readiness:'review',blockers:[]};
 const artifact=parseArtifact('preflight',old);assert.equal(classifyArtifact(artifact,base,'old'),undefined);
 const classified=parseArtifact('preflight',{...old,category:'feature',priority:'P2',labels:['sync','Sync',' docs ']});
 const result=classifyArtifact(classified,base,'new')!;assert.deepEqual(result.labels,['Sync','docs']);assert.equal(result.category,'feature');
 assert.match(artifactPrompt('preflight'),/category:bug\|feature/);
 assert.notEqual(classificationRevision({...base,headSha:'a'}),classificationRevision({...base,headSha:'b'}));
 assert.equal(classificationRevision(base),classificationRevision({...base,state:'closed',updatedAt:'2026-10-20T00:00:00Z'}),'closing or status-only updates preserve classification');
 assert.notEqual(classificationRevision(base),classificationRevision({...base,labels:['new']}));
});

test('PR classification persists through restart and sync, while changed metadata invalidates only its current projection',async()=>{
 const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {Store}=await import('../src/core/store.ts');const {Workbench}=await import('../src/core/workbench.ts');const {GitHub}=await import('../src/core/github.ts');const {seedFixture,fixtureAnalysis}=await import('./support/fixtures.ts');
 const path=join(await mkdtemp(join(tmpdir(),'classification-')),'state.sqlite');let store=new Store(path);seedFixture(store);
 const repo=store.repos()[0], original={...store.issues()[0],type:'pr' as const,headSha:'a'.repeat(40),prBaseSha:'b'.repeat(40)};store.put('issues',original);
 const github=new GitHub();github.pullRequest=async()=>({headSha:original.headSha,baseSha:original.prBaseSha,headRef:'topic',headRepo:repo.fullName,baseRef:'main',draft:false,merged:false,mergeable:true,checks:null,reviews:[],warnings:[]});
 github.sync=async()=>({repo:{...repo,syncedAt:new Date().toISOString()},issues:[{...original}]});
 let calls=0;
 const runner:import('../src/core/types.ts').Runner=async({issue})=>{calls++;return {result:fixtureAnalysis(issue,'preflight'),artifact:parseArtifact('preflight',{schemaVersion:1,stage:'preflight',summary:'Add sync',coverage:'metadata',evidence:[],nextSteps:[],responseDraft:'',category:'feature',priority:'P2',labels:['sync'],intent:'Add sync',risks:[],readiness:'review',blockers:[]}),engine:'test-only'};};
 let wb=new Workbench(store,'/tmp/classification-test',runner,github,false);
 try {
  const jobId=wb.enqueue([original.id],'preflight').created[0];wb.pump();await wb.drain();assert.equal(calls,1);
  assert.equal(store.get<Issue>('issues',original.id)?.classification?.category,'feature');
  assert.equal(wb.snapshot().issues.find(i=>i.id===original.id)?.classification?.stale,false);
  assert.deepEqual(wb.enqueue([original.id],'preflight'),{created:[],reused:[jobId]});
  await wb.close();store=new Store(path);wb=new Workbench(store,'/tmp/classification-test',runner,github,false);
  await wb.sync(repo.fullName);const current=wb.snapshot().issues.find(i=>i.id===original.id)!;
  assert.equal(current.classification?.priority,'P2');assert.deepEqual(current.classification?.labels,['sync']);assert.equal(calls,1);
  store.put('issues',{...store.get<Issue>('issues',original.id)!,headSha:'c'.repeat(40)});
  const stale=wb.snapshot().issues.find(i=>i.id===original.id)!;assert.equal(stale.classification?.stale,true);
  assert.equal(filterItems([stale],{...defaults,category:'feature'},'pr','').length,0);
  assert.equal(store.get<Issue>('issues',original.id)?.classification?.category,'feature','history is retained');
 } finally {await wb.close();}
});


test('explicit GitHub classification and priority outrank AI suggestions without implying that triage ran',()=>{
 const value=item(10,'bug','P2',[],{labels:['enhancement','priority:P1']});
 assert.equal(filterItems([value],{...defaults,category:'feature',priority:'P1'},'all','').length,1);
 const untriaged={...base,labels:['bug','P0']};
 assert.equal(filterItems([untriaged],{...defaults,category:'bug',priority:'P0',analysis:'untriaged'},'all','').length,1);
 assert.equal(filterItems([{...value,labels:['P0','P1']}],{...defaults,priority:'unset'},'all','').length,1);
});
