import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceEligibility,reviewEvidence} from '../src/client/review-evidence.ts';
import {prReviewValidation} from '../src/core/pr-review-validation.ts';
import type {Gap} from '../src/domain/gaps.ts';
import type {Job} from '../src/core/types.ts';
const gap:Gap={id:'test',kind:'system_check',summary:'测试未跑',status:'not_checked',blocks:['validate'],resolution:'运行范围测试',sources:[]};
const review={id:'review',kind:'review',status:'awaiting_review',createdAt:'2026-10-12T00:00:00Z',repoId:'repo',issueId:'repo#1',caseId:'case',revision:'revision',baseSha:'head',patchSha256:'digest',issueSnapshot:{type:'pr'},prContext:{headSha:'head',baseSha:'base',headRef:'feature',headRepo:'fork',baseRef:'main'},artifact:{stage:'review',gaps:[gap]}} as unknown as Job;
const validation={...review,id:'validation',kind:'validate',sourceJobId:'review',createdAt:'2026-10-12T01:00:00Z',attempt:1,status:'completed',artifact:{stage:'validate',tests:[{command:'test',status:'passed',output:'PASS'}],blockers:[]}} as unknown as Job;
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
