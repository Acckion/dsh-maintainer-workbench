import type { Job } from './types.ts';
import { historicalText, reviewPromptHandoff } from './review-context.ts';

export function implementationPromptHandoff(job: Pick<Job, 'sourceJobId' | 'handoff'>) {
  return reviewPromptHandoff(job.handoff)?.map(item => {
    const artifact = job.handoff?.find(source => source.id === item.sourceJobId)?.artifact;
    return { ...item, isPrimaryTarget: item.sourceJobId === job.sourceJobId, investigation: artifact?.stage === 'investigate' ? { rootCause: historicalText(artifact.rootCause), proposedChanges: artifact.proposedChanges.map(historicalText), acceptanceCriteria: artifact.acceptanceCriteria.map(historicalText) } : undefined };
  });
}

export function nativeImplementationGuidance(): string {
  return 'IMPLEMENTATION CONTRACT: this task requires actual edits in the dedicated worktree using native edit/write tools under host permissions, using real filesystem paths without an @ prefix, not another review or a proposed plan. Start with the primary handoff target and accepted findings, read current source and tests, reproduce when possible, implement the smallest evidenced fix, then inspect the real git diff and run relevant checks. Historical handoff claims are unverified, not actions performed by this task. changes must describe edits you actually made; do not claim a fix merely because you know what to change. Test commands must be executable commands discovered from the repository, never an issue/PR title. A regression runner blocked by missing dependencies or cache permissions does not by itself prove the authorized source edit is blocked: if the accepted defect is independently established from current source or a dependency-free reproduction, make the minimal source fix and report the unavailable suite honestly. Do not escalate permissions to repair test caches. If dependencies or runtime are unavailable report precise not_run limitations; never manufacture test results. If permissions or a genuine unresolved blocker prevent editing, report that limitation and no claimed changes. Leave edits uncommitted; do not publish.';
}

export function needsImplementationCompletion(artifact: { stage: string; changes?: string[] }, patch: string, permissionDenied: boolean): boolean {
  return ['fix', 'docs'].includes(artifact.stage) && !patch && !permissionDenied;
}
