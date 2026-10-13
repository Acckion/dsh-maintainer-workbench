import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceEligibility,reviewEvidence} from '../src/client/review-evidence.ts';
import {prReviewValidation} from '../src/core/pr-review-validation.ts';
import type {Gap} from '../src/domain/gaps.ts';
import type {Job} from '../src/core/types.ts';
const gap:Gap={id:'test',kind:'system_check',summary:'测试未跑',status:'not_checked',blocks:['validate'],resolution:'运行范围测试',sources:[],checks:['test']};
const review={id:'review',kind:'review',status:'awaiting_review',createdAt:'2026-10-12T00:00:00Z',repoId:'repo',issueId:'repo#1',caseId:'case',revision:'revision',baseSha:'head',patchSha256:'digest',issueSnapshot:{type:'pr'},prContext:{headSha:'head',baseSha:'base',headRef:'feature',headRepo:'fork',baseRef:'main'},artifact:{stage:'review',gaps:[gap]}} as unknown as Job;
const validation={...review,id:'validation',kind:'validate',sourceJobId:'review',sessionId:'s',worktree:'/tmp/check',executionRecords:[{id:'s:1',callId:'call',sessionId:'s',cwd:'/tmp/check',checkoutSha:'head',patchHash:'digest',command:'test',exitCode:0,isError:false,output:'PASS'}],createdAt:'2026-10-12T01:00:00Z',attempt:1,status:'completed',artifact:{stage:'validate',tests:[{command:'test',status:'passed',output:'PASS',executionId:'s:1'}],blockers:[],gaps:[{...gap,status:'resolved',resolution:'已通过',sources:['s:1']}]}} as unknown as Job;
test('PR acceptance requires the exact review target and latest successful explicit validation',()=>{
 assert.equal(prReviewValidation(review,[]).passed,false);
 assert.equal(prReviewValidation(review,[validation]).passed,true);
 for(const changed of [{sourceJobId:'foreign'},{revision:'old'},{baseSha:'old'},{patchSha256:'other'},{caseId:'old'},{artifactState:'stale'},{prContext:{...validation.prContext!,headRef:'renamed'}}])
  assert.equal(prReviewValidation(review,[{...validation,...changed}]).passed,false);
 for(const status of ['failed','cancelled','rejected','queued','running','waiting_environment'] as const)
  assert.equal(prReviewValidation(review,[validation,{...validation,id:'later',createdAt:'2026-10-12T02:00:00Z',status}]).passed,false);
 assert.equal(prReviewValidation(review,[{...validation,artifact:{...validation.artifact!,gaps:[gap]}}]).passed,false);
});

test('final-review display includes downstream PR validation and disables premature acceptance',()=>{
 assert.equal(acceptanceEligibility(review,[]).allowed,false);
 assert.equal(acceptanceEligibility(review,[validation]).allowed,true);
 assert.deepEqual(reviewEvidence(review,[review,validation]).validations.map(j=>j.id),['validation']);
 assert.equal(reviewEvidence(validation,[review,validation]).review?.id,review.id);
 assert.equal(reviewEvidence(review,[review,{...validation,patchSha256:'foreign'}]).validations.length,0);
});

test('mandatory checks require explicit per-gap current execution evidence',()=>{
 const extra={...gap,id:'types',checks:['typecheck']};
 const two={...review,artifact:{...review.artifact!,gaps:[gap,extra]}};
 assert.equal(prReviewValidation(two,[validation]).passed,false,'one covered gap cannot cover another');
 const unrelated={...validation,executionRecords:validation.executionRecords!.map(r=>({...r,command:'echo ok'})),artifact:{...validation.artifact!,stage:'validate' as const,tests:[{command:'echo ok',status:'passed' as const,output:'ok',executionId:'s:1'}],gaps:[{...gap,status:'resolved' as const,sources:['s:1']}],environment:'',blockers:[]}};
 assert.equal(prReviewValidation(review,[unrelated]).passed,false,'unrelated passing command is insufficient');
 for(const field of ['sessionId','cwd','checkoutSha','patchHash'] as const)
  assert.equal(prReviewValidation(review,[{...validation,executionRecords:validation.executionRecords!.map(r=>({...r,[field]:'foreign'}))}]).passed,false,field);
 assert.equal(prReviewValidation(review,[{...validation,artifact:{...validation.artifact!,gaps:[]}}]).passed,false,'omitted gap cannot pass');
 const second={...validation.executionRecords![0],id:'s:2',callId:'typecheck',command:'typecheck'};
 const all={...validation,executionRecords:[...validation.executionRecords!,second],artifact:{...validation.artifact!,stage:'validate' as const,environment:'',tests:[{command:'test',status:'passed' as const,output:'PASS',executionId:'s:1'},{command:'typecheck',status:'passed' as const,output:'PASS',executionId:'s:2'}],blockers:[],gaps:[{...gap,status:'resolved' as const,sources:['s:1']},{...extra,status:'resolved' as const,resolution:'通过',sources:['s:2']}]}};
 assert.equal(prReviewValidation(two,[all]).passed,true);
});

test('current manual completion/skip overrides handoff without changing historical evidence',()=>{
 for(const mode of ['complete','skip'] as const) {
  const state={id:'case',manualSteps:[{stage:'validate',mode}]} as unknown as import('../src/domain/processing.ts').ProcessingCase;
  assert.equal(prReviewValidation(review,[],state).passed,true);
  assert.equal(acceptanceEligibility(review,[],state).allowed,true);
  assert.equal(prReviewValidation(review,[],{...state,id:'old-case'}).passed,false);
  assert.equal(review.artifact?.gaps?.[0].status,'not_checked');
 }
});

for(const kind of ['fix','docs'] as const)test(`additional PR validation preserves ${kind} implementation chain`,()=>{
 const patch='diff --git a/x b/x\n';
 const implementation={...review,id:'implementation',kind,patch};
 const earlier={...validation,id:'earlier',sourceJobId:implementation.id,patch};
 const linked={...review,sourceJobId:earlier.id,patch};
 const direct={...validation,patch};
 const jobs=[implementation,earlier,linked,direct];
 for(const selected of [linked,direct]){
  const evidence=reviewEvidence(selected,jobs);
  assert.equal(evidence.implementation?.id,implementation.id);
  assert.equal(evidence.review?.id,linked.id);
  assert.deepEqual(new Set(evidence.validations.map(j=>j.id)),new Set(['earlier','validation']));
  assert.deepEqual(new Set(evidence.reviewSourceValidationIds),new Set(['earlier','validation']));
  assert.equal(evidence.warnings.some(w=>w.includes('未被此审查引用')),false);
 }
});
