import type { Job } from './types.ts';
import { blockingGaps } from '../domain/gaps.ts';
import { validationState } from './workflow-state.ts';
import { linkedExecution } from './execution-links.ts';
import { stepResolved } from '../workflow/manual.ts';
import type { ProcessingCase } from '../domain/processing.ts';

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

/** Each immutable source requirement needs its own resolved gap and current process references. */
export function uncoveredReviewChecks(review: Job, latest: Job): string[] {
  return reviewValidationNeeds(review).filter(need => {
    if (latest.artifact?.stage !== 'validate') return true;
    const resolved = latest.artifact.gaps?.find(g => g.id === need.id && g.status === 'resolved');
    if (!resolved?.sources.length) return true;
    const records = latest.artifact.tests.filter(t => t.status === 'passed').map(t => linkedExecution(latest,t))
      .filter(r => r && resolved.sources.some(id => id === r.id || id === r.callId) &&
        r.sessionId === latest.sessionId && r.checkoutSha === latest.baseSha &&
        r.patchHash === latest.patchSha256 && r.cwd === latest.worktree &&
        r.exitCode === 0 && !r.isError && !r.signal);
    return !records.length || !(need.checks ?? []).every(command => records.some(r => r?.command?.trim() === command.trim()));
  }).map(g=>g.id);
}

/** Latest explicit handoff wins; an earlier pass cannot hide a later failed attempt. */
export function prReviewValidation(review: Job, jobs: Job[], state: ProcessingCase | undefined = review.issueSnapshot.processing) {
  const needs=reviewValidationNeeds(review);
  // Human disposition is authoritative for the current cycle, never fabricated test evidence.
  if (state && state.id === review.caseId && stepResolved(state, 'validate'))
    return {required:!!needs.length,passed:true,manual:true,latest:undefined as Job|undefined};
  if(!needs.length) return {required:false,passed:true,latest:undefined as Job|undefined};
  const latest=jobs.filter(j=>j.kind==='validate' && j.sourceJobId===review.id)
    .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.attempt-b.attempt||a.id.localeCompare(b.id)).at(-1);
  const passed=!!latest && !!latest.worktree && !!latest.sessionId && !!latest.baseSha && !!latest.patchSha256 &&
    latest.artifactState!=='stale' && sameReviewedTarget(review,latest) &&
    ['completed','awaiting_review','approved'].includes(latest.status) &&
    validationState(latest.artifact)?.state==='passed' && !blockingGaps(latest.artifact?.gaps ?? [],'validate').length &&
    !uncoveredReviewChecks(review,latest).length;
  return {required:true,passed,latest};
}
