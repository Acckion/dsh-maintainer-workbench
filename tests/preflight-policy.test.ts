import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePreflight,unmetRequiredCI} from '../src/core/preflight-policy.ts';
import {artifactSchemas} from '../src/core/artifacts.ts';
import type {PRContext} from '../src/core/types.ts';
const pr:PRContext={headSha:'a'.repeat(40),baseSha:'b'.repeat(40),headRef:'feature',baseRef:'main',headRepo:'fixture/repo',draft:false,merged:false,mergeable:true,checks:null,reviews:[],commitStatus:null,warnings:[]};
const gap={id:'ci',kind:'environment',summary:'CI 状态未知，无检查记录',status:'unknown',blocks:['review','delivery'],resolution:'等待 CI',sources:[]};
const artifact=artifactSchemas.preflight.parse({schemaVersion:1,stage:'preflight',summary:'可以审查，计划待确认',coverage:'metadata only',evidence:[],nextSteps:[],responseDraft:'',intent:'Review feature',risks:[],readiness:'draft',blockers:[],gaps:[gap],planDraft:{category:'feature',goal:'review feature',scope:'two changed files',acceptanceCriteria:['reverse only outer chunks'],reproduction:'',expected:'',actual:'',route:'review',sources:[],missingInfo:[],gaps:[gap]}});
for(const checks of [null,{check_runs:[]},{check_runs:[{name:'test',status:'queued'}]},{check_runs:[{name:'test',status:'completed',conclusion:'failure'}]}]) {
 test(`CI coverage does not block local review (${JSON.stringify(checks)})`,()=>{
  const result=normalizePreflight(artifact,{...pr,checks});
  assert.equal(result.stage,'preflight');if(result.stage!=='preflight')return;
  assert.equal(result.readiness,'review');
  assert.deepEqual(result.gaps?.[0].blocks,[]);
  assert.deepEqual(result.planDraft?.gaps?.[0].blocks,[]);
  assert.equal(result.gaps?.[0].status,'unknown');
  assert.equal(artifact.readiness,'draft');
 });
}
test('real draft PRs and non-CI local blockers remain blocked or draft',()=>{
 assert.equal((normalizePreflight(artifact,{...pr,draft:true}) as typeof artifact).readiness,'draft');
 const result=normalizePreflight({...artifact,blockers:['缺少可读取的目标版本']},pr) as typeof artifact;
 assert.equal(result.readiness,'blocked');assert.deepEqual(result.blockers,['缺少可读取的目标版本']);
});
test('confirmed required CI only blocks delivery, while optional failures do not establish a gate',()=>{
 const required={...pr,branchRules:[{type:'required_status_checks',parameters:{required_status_checks:[{context:'test',integration_id:42}]}}]};
 const result=normalizePreflight(artifact,required) as typeof artifact;
 assert.equal(result.readiness,'review');assert.deepEqual(result.gaps?.at(-1)?.blocks,['delivery']);
 const pass={...required,checks:{check_runs:[{name:'test',head_sha:pr.headSha,status:'completed',conclusion:'success',app:{id:42}}]}};
 assert.deepEqual(unmetRequiredCI(pass),[]);
 assert.deepEqual((normalizePreflight(artifact,pass) as typeof artifact).gaps?.at(-1)?.blocks,[]);
 assert.deepEqual(unmetRequiredCI({...pass,checks:{check_runs:[{name:'test',head_sha:pr.baseSha,status:'completed',conclusion:'success',app:{id:42}}]}}),['test']);
 assert.deepEqual(unmetRequiredCI({...pass,checks:{check_runs:[{name:'test',head_sha:pr.headSha,status:'completed',conclusion:'success',app:{id:43}}]}}),['test']);
});

test('preflight worker completes with unknown CI and does not request human input or start review',async()=>{
 const {Store}=await import('../src/core/store.ts');
 const {Workbench}=await import('../src/core/workbench.ts');
 const {GitHub}=await import('../src/core/github.ts');
 const {seedFixture}=await import('./support/fixtures.ts');
 const {asAnalysis}=await import('../src/core/artifacts.ts');
 const store=new Store(':memory:');seedFixture(store);
 const issue=store.issues()[0],repo=store.repos()[0];
 store.put('issues',{...issue,type:'pr',headSha:pr.headSha,prBaseSha:pr.baseSha});
 const github=new GitHub();github.pullRequest=async()=>pr;github.context=async()=>'';
 const wb=new Workbench(store,'/tmp/preflight-ci-policy',async()=>({artifact,result:asAnalysis(artifact),engine:'fixture'}),github,false);
 try {
  wb.enqueue([issue.id],'preflight');wb.pump();await wb.drain();
  const job=store.jobs()[0];
  assert.equal(job.status,'completed',job.error);
  assert.equal((job.artifact as typeof artifact).readiness,'review');
  assert.equal(store.issues()[0].orchestration?.run,undefined);
  assert.equal(store.issues()[0].processing?.waits.filter(w=>w.state==='open' && ['user_input','environment_ready','ci_completion'].includes(w.type)).length,0);
  assert.equal(store.jobs().length,1);
 }finally{await wb.close();}
});

for (const name of ['Node.js CI', 'Node 20 CI', 'npm CI failed', 'pnpm CI unavailable']) test(`ecosystem CI name remains coverage: ${name}`,()=>{
 const report=artifactSchemas.preflight.parse({...artifact,blockers:[name],gaps:[{...gap,summary:name}],planDraft:{...artifact.planDraft!,gaps:[{...gap,summary:name}]}});
 const result=normalizePreflight(report,pr);
 assert.equal(result.stage,'preflight');if(result.stage!=='preflight')return;
 assert.equal(result.readiness,'review');assert.deepEqual(result.blockers,[]);assert.deepEqual(result.gaps?.[0].blocks,[]);
});
for (const detail of ['CI：本地 Node 版本不满足要求', 'CI：node_modules missing', 'CI：pnpm command not found']) test(`concrete local environment remains blocking: ${detail}`,()=>{
 const result=normalizePreflight({...artifact,blockers:[detail]},pr);
 assert.equal(result.stage,'preflight');if(result.stage!=='preflight')return;
 assert.equal(result.readiness,'blocked');assert.deepEqual(result.blockers,[detail]);
});
test('satisfied required gate is resolved for the pinned head, unresolved only gates delivery',()=>{
 const context={...pr,branchProtection:{required_status_checks:{contexts:['Node.js CI']}},checks:{check_runs:[{name:'Node.js CI',head_sha:pr.headSha,status:'completed',conclusion:'success'}]}};
 const pass=normalizePreflight(artifact,context);
 assert.equal(pass.gaps?.find(g=>g.id==='host_required_ci')?.status,'resolved');
 const pending=normalizePreflight(artifact,{...context,checks:null});
 assert.equal(pending.gaps?.find(g=>g.id==='host_required_ci')?.status,'pending');assert.deepEqual(pending.gaps?.find(g=>g.id==='host_required_ci')?.blocks,['delivery']);
});
