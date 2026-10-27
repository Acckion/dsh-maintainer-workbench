import type { Job } from '../core/types.ts';
import { sameReviewedTarget } from '../core/pr-review-validation.ts';
import { planGaps, type Gap } from '../domain/gaps.ts';

export interface PresentedGap { gap: Gap; resolvedBy?: string; original?: Gap }
/** Display-only reconciliation. Original reports and publication gates stay immutable. */
export function presentedGaps(job: Job, history: Job[]): PresentedGap[] {
  const gaps = planGaps({ gaps: job.artifact?.gaps, missingInfo: job.artifact?.stage === 'triage' ? job.artifact.missingInfo : [] });
  return gaps.map(gap => {
    if (gap.status === 'resolved' || gap.kind !== 'system_check' || job.artifactState === 'stale') return { gap };
    const latest = history.filter(next => next.id !== job.id && next.createdAt > job.createdAt &&
      sameReviewedTarget(job, next) &&
      (gap.blocks.includes(next.kind as Gap['blocks'][number]) || next.artifact?.gaps?.some(g => g.id === gap.id)))
      .sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.attempt-a.attempt || b.id.localeCompare(a.id))[0];
    const resolved = latest?.artifact?.gaps?.find(g => g.id === gap.id && g.kind === gap.kind && g.status === 'resolved');
    if (!latest || !resolved?.sources.length || !resolved.resolution || latest.artifactState === 'stale' ||
      !['completed','awaiting_review','approved'].includes(latest.status) || latest.evidenceGate?.allowed === false) return { gap };
    return { gap: resolved, original: gap, resolvedBy: latest.id };
  });
}
