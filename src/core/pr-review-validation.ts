import type { Job } from './types.ts';
import { blockingGaps } from '../domain/gaps.ts';
import { validationState } from './workflow-state.ts';

/** Future-stage checks remain system work; only explicit validation requirements count. */
export function reviewValidationNeeds(review?: Job) {
  return review?.issueSnapshot.type === 'pr' && review.artifact?.stage === 'review'
    ? blockingGaps(review.artifact.gaps ?? [], 'validate') : [];
}

export function sameReviewedTarget(review: Job, validation: Job): boolean {
  const a=review.prContext,b=validation.prContext;
  return review.issueId===validation.issueId && review.repoId===validation.repoId &&
    review.caseId===validation.caseId && review.revision===validation.revision &&
    review.baseSha===validation.baseSha && review.patchSha256===validation.patchSha256 &&
    !!a && !!b && ['headSha','baseSha','headRef','headRepo','baseRef'].every(k=>Reflect.get(a,k)===Reflect.get(b,k));
}

/** Latest explicit handoff wins; an earlier pass cannot hide a later failed attempt. */
export function prReviewValidation(review: Job, jobs: Job[]) {
  const needs=reviewValidationNeeds(review);
  if(!needs.length) return {required:false,passed:true,latest:undefined as Job|undefined};
  const latest=jobs.filter(j=>j.kind==='validate' && j.sourceJobId===review.id)
    .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.attempt-b.attempt||a.id.localeCompare(b.id)).at(-1);
  const passed=!!latest && latest.artifactState!=='stale' && sameReviewedTarget(review,latest) &&
    ['completed','awaiting_review','approved'].includes(latest.status) &&
    validationState(latest.artifact)?.state==='passed' && !blockingGaps(latest.artifact?.gaps ?? [],'validate').length;
  return {required:true,passed,latest};
}
