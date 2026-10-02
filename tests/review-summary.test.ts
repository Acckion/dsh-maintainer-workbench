import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Audit, Issue, Job } from '../src/core/types.ts';
import { artifactSchemas, asAnalysis } from '../src/core/artifacts.ts';
import { AcceptArtifactButton, ReviewSummary, type DetailTab } from '../src/client/ReviewSummary.tsx';
import { executionExplanation, patchScope, reviewEvidence, selectedAnalysis, taskStatus } from '../src/client/review-evidence.ts';
import { WorkflowPanel } from '../src/client/WorkflowPanel.tsx';

const saved = JSON.parse(readFileSync(new URL('../docs/evidence/product-trial-2026-10-02/after.json', import.meta.url), 'utf8'));
const trial = () => structuredClone(saved) as { jobs: Job[]; observations: { originalImplementationJobId: string } };
function finalChain() {
  const data = trial(), implementation = data.jobs.find(job => job.id === data.observations.originalImplementationJobId)!;
  const review = data.jobs.find(job => job.id === implementation.deliveryReviewId)!;
  const validation = data.jobs.find(job => job.id === review.sourceJobId)!;
  return { jobs: data.jobs, implementation, review, validation };
}
const props = (job: Job, jobs: Job[]) => ({ job, jobs, audit: [], native: true, open: (_id: string, _tab: DetailTab) => {} });
const html = (job: Job, jobs: Job[]) => renderToStaticMarkup(React.createElement(ReviewSummary, props(job, jobs)));

test('actual installed trial assembles exact implementation, validation, review and limitations', () => {
  const f = finalChain(), result = reviewEvidence(f.implementation, f.jobs), markup = html(f.implementation, f.jobs);
  assert.equal(result.implementation?.id, f.implementation.id);
  assert.equal(result.review?.id, f.review.id);
  assert.deepEqual(result.validations.map(job => job.id), [f.validation.id]);
  assert.equal(result.warnings.length, 0);
  assert.match(markup, /审阅摘要/); assert.match(markup, /Scripted provider; not model-quality evidence/);
  assert.match(markup, new RegExp(f.validation.id)); assert.match(markup, /npm test/);
  assert.match(markup, /本地已接受此审查/); assert.match(markup, /工具证据和原生会话/);
});

test('focused implementation pass does not hide the explicitly linked failing full validation', () => {
  const f = finalChain(), partial = f.jobs.find(job => job.kind === 'fix' && job.id !== f.implementation.id)!;
  const result = reviewEvidence(partial, f.jobs), markup = html(partial, f.jobs);
  assert.equal(result.validations.length, 1); assert.equal(result.validations[0].artifact?.stage, 'validate');
  assert.match(markup, /1 项验证失败/); assert.match(markup, /Only the reported symptom was tested/);
  assert.match(markup, /实施自报测试/); assert.match(markup, /不能替代独立验证/);
  assert.doesNotMatch(markup, new RegExp(f.validation.id));
});

test('same-patch validation retries all remain visible rather than cherry-picking a passing report', () => {
  const f = finalChain(); delete f.implementation.deliveryReviewId;
  const failed = structuredClone(f.validation); failed.id = 'failed-same-patch';
  if (failed.artifact?.stage !== 'validate') throw Error('fixture');
  failed.artifact.tests[0].status = 'failed'; failed.result = asAnalysis(failed.artifact);
  f.jobs.push(failed);
  assert.equal(reviewEvidence(f.implementation, f.jobs).validations.length, 2);
  assert.match(html(f.implementation, f.jobs), /1 项验证失败/);
});

test('an approved chain cannot conceal another same-patch failing validation from either entry', () => {
  const f = finalChain(), failed = structuredClone(f.validation);
  failed.id = 'new-failure-after-review'; failed.createdAt = '2026-10-03T00:00:00Z';
  if (failed.artifact?.stage !== 'validate') throw Error('fixture');
  failed.artifact.tests[0].status = 'failed'; failed.result = asAnalysis(failed.artifact); f.jobs.push(failed);
  for (const selected of [f.implementation, f.review]) {
    const result = reviewEvidence(selected, f.jobs), markup = html(selected, f.jobs);
    assert.deepEqual(result.validations.map(job=>job.id),[f.validation.id,failed.id]);
    assert.deepEqual(result.reviewSourceValidationIds,[f.validation.id]);
    assert.ok(result.warnings.some(text=>text.includes('另有失败')));
    assert.match(markup,/本次审查引用的验证报告/); assert.match(markup,/其他同补丁验证报告/);
    assert.match(markup,/1 项验证失败/); assert.match(markup,/现有审查未引用这些记录/);
  }
  failed.patch += 'other-patch';
  assert.deepEqual(reviewEvidence(f.implementation,f.jobs).validations.map(job=>job.id),[f.validation.id]);
});

for (const source of ['validation', 'review'] as const) test(`a same-patch failed validation dispatched from ${source} remains visible at both review entries`, () => {
  const f = finalChain(), failed = structuredClone(f.validation);
  failed.id = `nested-failure-from-${source}`; failed.createdAt = '2026-10-03T00:00:00Z';
  failed.sourceJobId = f[source].id;
  if (failed.artifact?.stage !== 'validate') throw Error('fixture');
  failed.artifact.tests[0].status = 'failed'; failed.result = asAnalysis(failed.artifact); f.jobs.push(failed);
  for (const selected of [f.implementation, f.review]) {
    const result = reviewEvidence(selected, f.jobs), markup = html(selected, f.jobs);
    assert.deepEqual(result.validations.map(job => job.id), [f.validation.id, failed.id]);
    assert.deepEqual(result.reviewSourceValidationIds, [f.validation.id]);
    assert.ok(result.warnings.some(text => text.includes('另有失败')));
    assert.match(markup, /其他同补丁验证报告/); assert.match(markup, /1 项验证失败/);
  }
});

test('descendant validation verifies every intermediate handoff and never borrows another implementation', () => {
  for (const drift of ['patch', 'base', 'revision', 'issue', 'target', 'stale', 'rejected', 'missing', 'cycle', 'other-implementation'] as const) {
    const f = finalChain(), intermediate = structuredClone(f.validation), later = structuredClone(f.validation);
    intermediate.id = 'intermediate-check'; intermediate.sourceJobId = f.implementation.id;
    later.id = 'later-check'; later.sourceJobId = intermediate.id; later.createdAt = '2026-10-03T00:00:00Z';
    if (later.artifact?.stage !== 'validate') throw Error('fixture');
    later.artifact.tests[0].status = 'failed'; later.result = asAnalysis(later.artifact);
    if (drift === 'patch') intermediate.patch += 'different';
    if (drift === 'base') intermediate.baseSha = 'other-base';
    if (drift === 'revision') intermediate.revision = 'other-revision';
    if (drift === 'issue') intermediate.issueId = 'other-issue';
    if (drift === 'target') intermediate.prContext = { headSha:'x',baseSha:'y',headRef:'other',headRepo:'fixture/other',baseRef:'main',draft:false,merged:false,mergeable:null,checks:[],reviews:[],warnings:[] };
    if (drift === 'stale') intermediate.artifactState = 'stale';
    if (drift === 'rejected') intermediate.status = 'rejected';
    if (drift === 'missing') intermediate.sourceJobId = 'missing';
    if (drift === 'cycle') intermediate.sourceJobId = later.id;
    if (drift === 'other-implementation') {
      const other = { ...f.implementation, id: 'other-implementation' };
      f.jobs.push(other); intermediate.sourceJobId = other.id;
    }
    f.jobs.push(intermediate, later);
    for (const selected of [f.implementation, f.review]) {
      const result = reviewEvidence(selected, f.jobs);
      assert.ok(!result.validations.some(job => job.id === later.id), drift);
      assert.deepEqual(result.reviewSourceValidationIds, [f.validation.id], drift);
    }
  }
});

test('multi-hop reruns stay distinct from review-source evidence without changing local decisions', () => {
  const f = finalChain(), rerun = structuredClone(f.validation), followupReview = structuredClone(f.review), failed = structuredClone(f.validation);
  rerun.id = 'rerun'; rerun.sourceJobId = f.review.id; rerun.createdAt = '2026-10-03T00:00:00Z';
  followupReview.id = 'followup-review'; followupReview.sourceJobId = rerun.id;
  failed.id = 'multi-hop-failure'; failed.sourceJobId = followupReview.id; failed.createdAt = '2026-10-04T00:00:00Z';
  if (failed.artifact?.stage !== 'validate') throw Error('fixture');
  failed.artifact.tests[0].status = 'failed'; failed.result = asAnalysis(failed.artifact);
  f.jobs.push(rerun, followupReview, failed);
  const saved = JSON.stringify(f.jobs);
  for (const selected of [f.implementation, f.review, rerun]) {
    const result = reviewEvidence(selected, f.jobs);
    assert.deepEqual(result.validations.map(job => job.id), [f.validation.id, rerun.id, failed.id]);
    if (selected.kind !== 'validate') assert.deepEqual(result.reviewSourceValidationIds, [f.validation.id]);
  }
  assert.equal(JSON.stringify(f.jobs), saved, 'The summary is read-only; extra reports do not silently revoke local decisions');
});

test('current artifact coverage remains visible in the composed overview for every non-review stage', () => {
  const f = finalChain();
  for (const source of f.jobs.filter(job=>job.artifact && job.kind!=='review')) {
    const job = structuredClone(source); job.artifact!.coverage = 'UNIQUE_COVERAGE_BOUNDARY_'+job.kind;
    const tree = React.createElement(React.Fragment,null,
      React.createElement(ReviewSummary,props(job,f.jobs)),
      React.createElement(WorkflowPanel,{issue:job.issueSnapshot,job,history:f.jobs,busy:false,hideSummary:true,act:async()=>{}}));
    assert.match(renderToStaticMarkup(tree),new RegExp(job.artifact!.coverage));
  }
});

for (const drift of ['missing', 'revoked', 'stale', 'patch', 'base', 'revision', 'issue', 'target', 'cycle', 'wrong-source'] as const) test(`review summary fails closed for ${drift} linked evidence`, () => {
  const f = finalChain();
  if (drift === 'missing') f.jobs = f.jobs.filter(job => job.id !== f.review.id);
  if (drift === 'revoked') f.review.status = 'rejected';
  if (drift === 'stale') f.validation.artifactState = 'stale';
  if (drift === 'patch') f.validation.patch += '\nchanged';
  if (drift === 'base') f.validation.baseSha = 'new-base';
  if (drift === 'revision') f.validation.revision = 'new-input';
  if (drift === 'issue') f.validation.issueId = 'other-issue';
  if (drift === 'target') f.validation.prContext = { headSha:'x',baseSha:'y',headRef:'other',headRepo:'fixture/other',baseRef:'main',draft:false,merged:false,mergeable:null,checks:[],reviews:[],warnings:[] };
  if (drift === 'cycle') f.validation.sourceJobId = f.review.id;
  if (drift === 'wrong-source') f.validation.sourceJobId = f.jobs.find(job => job.kind === 'fix' && job.id !== f.implementation.id)!.id;
  const result = reviewEvidence(f.implementation, f.jobs), markup = html(f.implementation, f.jobs);
  assert.equal(result.validations.length, 0); assert.ok(result.warnings.length);
  assert.doesNotMatch(markup, /本地已接受此审查/);
  assert.match(markup, /尚无可引用的同一补丁独立验证报告/);
});

test('incomplete review with no findings remains visibly incomplete', () => {
  const f = finalChain(); if (f.review.artifact?.stage !== 'review') throw Error('fixture');
  f.review.artifact.verdict = 'incomplete'; f.review.artifact.findings = []; f.review.artifact.blockers = ['missing coverage'];
  const markup = html(f.review, f.jobs);
  assert.match(markup, /审查覆盖不足，需要补充证据/); assert.match(markup, /missing coverage/);
  assert.doesNotMatch(markup, /本次覆盖范围内未提出发现/);
  const workflow = renderToStaticMarkup(React.createElement(WorkflowPanel, { issue:f.review.issueSnapshot,job:f.review,history:f.jobs,busy:false,act:async()=>{} }));
  assert.doesNotMatch(workflow, /没有已确认的发现/);
});

for (const variant of ['not_run', 'empty', 'blocked'] as const) test(`${variant} validation is not shown as a passed report`, () => {
  const f = finalChain(); if (f.validation.artifact?.stage !== 'validate') throw Error('fixture');
  if (variant === 'not_run') f.validation.artifact.tests[0].status = 'not_run';
  if (variant === 'empty') f.validation.artifact.tests = [];
  if (variant === 'blocked') f.validation.artifact.blockers = ['runner environment unavailable'];
  const markup = html(f.validation, f.jobs);
  assert.doesNotMatch(markup, /验证报告标记为通过/);
  assert.match(markup, /尚未执行完整|验证有阻塞/);
});

test('selected failed or running task never borrows an older issue analysis or passing chain', () => {
  const f = finalChain(); const old = f.jobs.find(job => job.kind === 'triage')!.result!;
  const issue = { ...f.implementation.issueSnapshot, analysis: old };
  const failed = { ...f.implementation, status: 'failed' as const, result: undefined };
  assert.equal(selectedAnalysis(issue, failed), undefined);
  assert.equal(selectedAnalysis(issue), old);
  assert.equal(selectedAnalysis(issue, f.implementation), f.implementation.result);
  assert.equal(reviewEvidence(failed, f.jobs).validations.length, 0);
  assert.doesNotMatch(html(failed, f.jobs), /本地已接受此审查/);
});

test('execution summary distinguishes queued, waiting, failed recovery, cancellation and stale inputs', () => {
  const f = finalChain(); const job = { ...f.implementation, status:'failed' as const, result:undefined,rawOutput:'saved output',formatRecovery:{baseSha:'base',patchHash:'hash'},waitingReason:'obsolete reason' };
  const rows: Audit[] = [{id:2,at:'now',jobId:job.id,action:'tool',detail:'latest actual record'}, {id:3,at:'now',jobId:'other',action:'tool',detail:'unrelated'}];
  assert.equal(executionExplanation(job,true,rows).formatRetry,true);
  assert.equal(executionExplanation(job,false,rows).formatRetry,false);
  assert.equal(executionExplanation(job,true,rows).waitingReason,undefined);
  assert.equal(executionExplanation(job,true,rows).latest?.id,2);
  assert.match(executionExplanation({...job,status:'running',waitingReason:'等待审批'},true,[]).waitingReason!,/等待审批/);
  assert.match(executionExplanation({...job,status:'queued'},true,[]).next,/没有承诺开始时间/);
  assert.match(executionExplanation({...job,status:'cancelled'},true,[]).next,/不会自动恢复/);
  assert.match(executionExplanation({...job,artifactState:'stale'},true,[]).next,/旧结果不能批准/);
});

test('list status never paints locally accepted failing or incomplete validation as green', () => {
  const f = finalChain(); if (f.validation.artifact?.stage !== 'validate') throw Error('fixture');
  f.validation.status = 'approved'; f.validation.artifact.tests[0].status = 'failed';
  assert.equal(taskStatus(f.validation).tone,'red'); assert.match(taskStatus(f.validation).label,/验证报告有失败 · 本地已接受/);
  f.validation.artifact.tests[0].status = 'not_run';
  assert.equal(taskStatus(f.validation).tone,'amber'); assert.match(taskStatus(f.validation).label,/不完整/);
  assert.match(taskStatus({...f.implementation,artifactState:'stale'}).label,/旧版本/);
});

test('triage exposes impact, missing information and evidence without implying code tests', () => {
  const f = finalChain(); const triage = f.jobs.find(job => job.kind==='triage' && job.issueSnapshot.number===3)!;
  const markup = html(triage,f.jobs);
  assert.match(markup,/分诊依据与缺口/); assert.match(markup,/复现步骤和输入样本/);
  assert.match(markup,/轻量分诊不执行代码测试/); assert.doesNotMatch(markup,/关联验证报告/);
});

test('acceptance button is really disabled for stale/busy jobs and does not promise publication', () => {
  const f = finalChain();
  for (const variant of [{job:{...f.implementation,artifactState:'stale'},busy:false}, {job:f.implementation,busy:true}]) {
    const markup = renderToStaticMarkup(React.createElement(AcceptArtifactButton,{...variant,accept:()=>{}}));
    assert.match(markup,/disabled=""/); assert.doesNotMatch(markup,/可发布/);
  }
  assert.match(renderToStaticMarkup(React.createElement(AcceptArtifactButton,{job:f.validation,busy:false,accept:()=>{}})),/接受此报告/);
});

// Inspect stateless component callbacks, not a browser or visual-layout test.
function buttons(node: React.ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!React.isValidElement(node)) return [];
  const element = node as ReactElement<any>;
  if (typeof element.type === 'function') return buttons((element.type as (props: any) => React.ReactNode)(element.props));
  return [...(element.type === 'button' ? [element] : []), ...buttons(element.props.children)];
}
test('one evidence action opens the exact source validation and patch, preserving target identity', () => {
  const f = finalChain(), opened: [string, DetailTab][] = [], sessions:string[]=[];
  const tree = React.createElement(ReviewSummary,{...props(f.implementation,f.jobs),open:(id,tab)=>opened.push([id,tab]),openSession:id=>sessions.push(id)});
  const controls = buttons(tree);
  const text = (element:ReactElement<any>) => renderToStaticMarkup(element);
  controls.find(button=>/核对此验证的证据/.test(text(button)))!.props.onClick();
  controls.find(button=>/完整补丁/.test(text(button)))!.props.onClick();
  controls.find(button=>/打开对应审查与逐项处置/.test(text(button)))!.props.onClick();
  controls.find(button=>/Harness 会话/.test(text(button)))!.props.onClick();
  assert.deepEqual(opened,[[f.validation.id,'evidence'],[f.implementation.id,'diff'],[f.review.id,'overview']]);
  assert.deepEqual(sessions,[f.implementation.sessionId]);
});

test('patch scope counts text hunks rather than file headers or binary payload', () => {
  assert.equal(patchScope(), '没有保存的代码补丁');
  const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+++literal\ndiff --git a/b b/b\nGIT binary patch\n+encoded\n-encoded\n';
  assert.match(patchScope(patch),/2 个文件差异 · \+1 \/ -1 文本行 · 含二进制/);
});
