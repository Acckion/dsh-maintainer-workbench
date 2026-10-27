import type { Job } from './types.ts';
import { blockingGaps } from '../domain/gaps.ts';
import { validationState } from './workflow-state.ts';
import { linkedExecution } from './execution-links.ts';
import { executionOutcome, executionCoversCommand } from './execution-outcome.ts';
import { stepResolved } from '../workflow/manual.ts';
import type { ProcessingCase } from '../domain/processing.ts';
import { validationChecks } from './validation-scope.ts';

/** Future-stage checks remain system work; only explicit validation requirements count. */
export function reviewValidationNeeds(review?: Job) {
  return review?.issueSnapshot.type === 'pr' && review.artifact?.stage === 'review'
    ? blockingGaps(review.artifact.gaps ?? [], 'validate').map(g=>({...g,checks:validationChecks(g)})) : [];
}

export function sameReviewedTarget(review: Job, validation: Job): boolean {
  const a=review.prContext,b=validation.prContext;
  return review.issueId===validation.issueId && review.repoId===validation.repoId &&
    review.caseId===validation.caseId && review.revision===validation.revision &&
    review.baseSha===validation.baseSha && review.patchSha256===validation.patchSha256 &&
    !!a && !!b && ['headSha','baseSha','headRef','headRepo','baseRef'].every(k=>Reflect.get(a,k)===Reflect.get(b,k));
}

/** Each immutable source requirement needs its own resolved gap and current process references. */
export function uncoveredReviewChecks(review: Job, latest: Job): string[] {
  return reviewValidationNeeds(review).filter(need => {
    if (latest.artifact?.stage !== 'validate') return true;
    const resolved = latest.artifact.gaps?.find(g => g.id === need.id && g.status === 'resolved');
    if (!resolved?.sources.length) return true;
    const candidates = need.kind === 'environment'
      ? (latest.executionRecords ?? []).filter(r=>r.command&&linkedExecution(latest,{command:r.command,executionId:r.id})===r)
      : latest.artifact.tests.filter(t => t.status === 'passed').map(t => linkedExecution(latest,t));
    const records = candidates
      .filter(r => r && resolved.sources.some(id => id === r.id || id === r.callId) &&
        r.sessionId === latest.sessionId && r.checkoutSha === latest.baseSha &&
        r.patchHash === latest.patchSha256 && r.cwd === latest.worktree &&
        executionOutcome(r) === 'passed');
    return !records.length || !(need.checks ?? []).every(command => records.some(r => r && executionCoversCommand(r,command)));
  }).map(g=>g.id);
}

/** Latest explicit handoff wins; an earlier pass cannot hide a later failed attempt. */
export interface PRReviewValidation {required:boolean;passed:boolean;manual?:boolean;latest:Job|undefined;reusedSource?:boolean}
export function prReviewValidation(review: Job, jobs: Job[], state: ProcessingCase | undefined = review.issueSnapshot.processing):PRReviewValidation {
  const needs=reviewValidationNeeds(review);
  // Human disposition is authoritative for the current cycle, never fabricated test evidence.
  if (state && state.id === review.caseId && stepResolved(state, 'validate'))
    return {required:!!needs.length,passed:true,manual:true,latest:undefined as Job|undefined};
  if(!needs.length) return {required:false,passed:true,latest:undefined as Job|undefined};
  const latest=jobs.filter(j=>j.kind==='validate' && j.sourceJobId===review.id)
    .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.attempt-b.attempt||a.id.localeCompare(b.id)).at(-1);
  if(!latest){
    // A review gets its own source-inspection workspace; missing dependencies
    // there do not erase a successful validator in its explicit source chain.
    const byId=new Map(jobs.map(j=>[j.id,j])),seen=new Set([review.id]);let id=review.sourceJobId;
    while(id&&seen.size<30&&!seen.has(id)){
      seen.add(id);const source=byId.get(id);if(!source)break;
      if(source.kind==='validate'){
        if(jobs.some(j=>j.kind==='validate'&&j.sourceJobId===source.sourceJobId&&sameReviewedTarget(source,j)&&j.createdAt>source.createdAt&&
          (!['completed','awaiting_review','approved'].includes(j.status)||validationState(j.artifact)?.state!=='passed')))break;
        if(review.artifactState!=='stale'&&review.caseId&&source.sessionId&&source.worktree&&source.baseSha&&source.patchSha256&&source.artifact?.stage==='validate'&&source.artifactState!=='stale'&&sameReviewedTarget(review,source)&&
          ['completed','awaiting_review','approved'].includes(source.status)&&validationState(source.artifact)?.state==='passed'&&
          !blockingGaps(source.artifact.gaps??[],'validate').length){
          const records=source.artifact.tests.filter(t=>t.status==='passed').map(t=>linkedExecution(source,t))
            .filter(r=>r&&r.sessionId===source.sessionId&&r.cwd===source.worktree&&r.checkoutSha===source.baseSha&&r.patchHash===source.patchSha256&&executionOutcome(r)==='passed');
          if(needs.every(g=>g.checks?.length&&g.checks.every(command=>records.some(r=>r&&executionCoversCommand(r,command)))))
            return {required:true,passed:true,latest:source,reusedSource:true};
        }
        break;
      }
      id=source.sourceJobId;
    }
  }
  const passed=!!latest && !!latest.worktree && !!latest.sessionId && !!latest.baseSha && !!latest.patchSha256 &&
    latest.artifactState!=='stale' && sameReviewedTarget(review,latest) &&
    ['completed','awaiting_review','approved'].includes(latest.status) &&
    validationState(latest.artifact)?.state==='passed' && !blockingGaps(latest.artifact?.gaps ?? [],'validate').length &&
    !uncoveredReviewChecks(review,latest).length;
  return {required:true,passed,latest};
}
