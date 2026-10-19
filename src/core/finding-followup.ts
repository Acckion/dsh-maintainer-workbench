import type { FindingFollowup, Job } from './types.ts';

/** Explicit history identities only; matching titles/line numbers never proves a fix. */
export function reviewFollowups(job: Job, reported: FindingFollowup[] = []): FindingFollowup[] {
  const sources = (job.handoff ?? []).filter(source => source.kind === 'review' && source.artifact?.stage === 'review');
  const seen = new Set<string>();
  for (const item of reported) {
    const source = sources.find(source => source.id === item.sourceJobId);
    const key = `${item.sourceJobId}:${item.findingId}`;
    if (!source || source.artifact?.stage !== 'review' || !source.artifact.findings.some(finding => finding.id === item.findingId) || seen.has(key)) throw new Error('后续审查引用了缺失、重复或不属于本次交接的发现');
    seen.add(key);
  }
  const latest = sources.at(-1);
  const missing: FindingFollowup[] = latest?.artifact?.stage === 'review' ? latest.artifact.findings.filter(f => !seen.has(`${latest.id}:${f.id}`)).map(f => ({ sourceJobId: latest.id, findingId: f.id, status: 'unverified', evidence: '本次审查未给出此历史发现的版本复核证据。' })) : [];
  return [...reported, ...missing];
}

/** Recover only new findings mistakenly attached to a known historical review.
 * Never infer an old finding identity or accept a fabricated resolved status.
 */
export function reconcileReviewFollowups(job: Job, artifact: Extract<NonNullable<Job['artifact']>, { stage: 'review' }>) {
  const sources = (job.handoff ?? []).filter(source => source.kind === 'review' && source.artifact?.stage === 'review');
  const historicalIds = new Set(sources.flatMap(source => source.artifact?.stage === 'review' ? source.artifact.findings.map(f => f.id) : []));
  const currentIds = new Set(artifact.findings.map(f => f.id));
  const seen = new Set<string>();
  const retained: FindingFollowup[] = [], ignored: FindingFollowup[] = [];
  for (const item of artifact.followups ?? []) {
    const key = `${item.sourceJobId}:${item.findingId}`;
    if (seen.has(key)) throw new Error('后续审查引用了重复的历史发现');
    seen.add(key);
    const source = sources.find(source => source.id === item.sourceJobId);
    if (source && currentIds.has(item.findingId) && !historicalIds.has(item.findingId) && item.status !== 'resolved') {
      ignored.push(item);
    } else {
      retained.push(item);
    }
  }
  return { followups: reviewFollowups(job, retained), ignored };
}
