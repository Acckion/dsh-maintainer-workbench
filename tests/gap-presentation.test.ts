import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Job} from '../src/core/types.ts';
import type {Gap} from '../src/domain/gaps.ts';
import {presentedGaps} from '../src/client/gap-presentation.ts';
import {GapSummary} from '../src/client/GapSummary.tsx';
const gap:Gap={id:'source_review',kind:'system_check',summary:'源码尚未审查',status:'not_checked',blocks:['review'],resolution:'读取源码后解除',sources:['metadata']};
const resolved:Gap={...gap,summary:'源码审查',status:'resolved',resolution:'已读取源码及差异',sources:['execution:1']};
const original={id:'preflight',kind:'preflight',repoId:'repo',issueId:'repo#12',caseId:'case',revision:'rev',baseSha:'head',patchSha256:'empty',status:'completed',createdAt:'2026-10-27T10:00:00Z',attempt:1,prContext:{headSha:'head',baseSha:'base',headRef:'feature',headRepo:'repo',baseRef:'main'},artifact:{stage:'preflight',gaps:[gap]}} as Job;
const review={...original,id:'review',kind:'review',createdAt:'2026-10-27T11:00:00Z',status:'approved',evidenceGate:{allowed:true,reasons:[]},artifact:{stage:'review',gaps:[resolved]}} as unknown as Job;
test('later explicit same-target resolution changes display without mutating historical report',()=>{
 const before=JSON.stringify(original),rows=presentedGaps(original,[original,review]);
 assert.equal(rows[0].gap.status,'resolved');assert.equal(rows[0].resolvedBy,'review');assert.equal(JSON.stringify(original),before);
 const html=renderToStaticMarkup(React.createElement(GapSummary,{plan:{gaps:[gap]},presentation:rows}));
 assert.ok(html.includes('已完成的检查与已解决事项'));assert.ok(html.includes('后续同版本检查已完成'));assert.ok(!html.includes('尚未完成的系统检查'));assert.ok(!html.includes('系统待检查'));
});
test('wrong version, case, patch, stale, failed gate and missing evidence do not resolve a check',()=>{
 for(const patch of [{revision:'other'},{caseId:'other'},{patchSha256:'changed'},{artifactState:'stale'},{status:'failed'},{evidenceGate:{allowed:false,reasons:['bad quote']}},{prContext:{...review.prContext,headSha:'changed'}},{artifact:{stage:'review',gaps:[{...resolved,sources:[]}]}}]){
  assert.equal(presentedGaps(original,[{...review,...patch} as Job])[0].gap.status,'not_checked');
 }
});
test('latest failed or unresolved attempt cannot be hidden by an earlier pass',()=>{
 for(const patch of [{status:'failed',artifact:undefined},{artifact:{stage:'review',gaps:[gap]}}]){
  const latest={...review,...patch,id:'latest',createdAt:'2026-10-27T12:00:00Z'} as Job;
  assert.equal(presentedGaps(original,[review,latest])[0].gap.status,'not_checked');
 }
});
test('own resolved gaps are collapsed, while unresolved system work stays visible',()=>{
 const html=renderToStaticMarkup(React.createElement(GapSummary,{plan:{gaps:[resolved]}}));
 assert.ok(html.includes('<details>'));assert.ok(!html.includes('系统待检查'));assert.ok(!html.includes('系统检查由系统完成'));
 const pending=renderToStaticMarkup(React.createElement(GapSummary,{plan:{gaps:[gap]}}));assert.ok(pending.includes('尚未完成的系统检查'));assert.ok(pending.includes('尚未检查'));
});
