import { createHash } from 'node:crypto';
import type { Artifact } from './artifacts.ts';
import type { Issue, Job } from './types.ts';

/** Classification depends on source metadata, not local plans or later execution reports. */
export function classificationRevision(issue: Issue): string {
  return createHash('sha256').update(JSON.stringify([issue.type, issue.title, issue.body, issue.comments, [...issue.labels].sort(), issue.headSha ?? '', issue.prBaseSha ?? ''])).digest('hex');
}
export function classifyArtifact(artifact: Artifact | undefined, issue: Issue, jobId: string): Issue['classification'] {
  if (!artifact || !['triage', 'preflight'].includes(artifact.stage) || !('category' in artifact) || !artifact.category || !('priority' in artifact) || !artifact.priority) return undefined;
  return { category: artifact.category, priority: artifact.priority, labels: [...new Map((artifact.labels ?? []).map(label => [label.trim().toLowerCase(), label.trim()])).values()].filter(Boolean).slice(0, 8), revision: classificationRevision(issue), jobId, updatedAt: new Date().toISOString() };
}

/** A confirmed workbench reply changes comment count, not the classified source.
 * Keep conservative invalidation for every change not explained by saved receipts.
 * This affects classification display only, never review/publication freshness gates.
 */
export function classificationCurrent(issue: Issue, jobs: Job[]): boolean {
  const classified = issue.classification;
  if (!classified) return false;
  if (classified.revision === classificationRevision(issue)) return true;
  const source = jobs.find(job => job.id === classified.jobId && job.issueId === issue.id && job.repoId === issue.repoId);
  if (!source || classificationRevision(source.issueSnapshot) !== classified.revision ||
    classificationRevision({...issue, comments: source.issueSnapshot.comments}) !== classified.revision) return false;
  const receipts = jobs.filter(job => job.issueId === issue.id && job.repoId === issue.repoId &&
    classificationRevision({...job.issueSnapshot, comments: source.issueSnapshot.comments}) === classified.revision)
    .map(job => job.publications?.comment).filter(receipt => receipt?.status === 'published' &&
      receipt.remoteUpdatedAt && Date.parse(receipt.remoteUpdatedAt) > Date.parse(classified.updatedAt) &&
      receipt.urls.length === 1 && /#issuecomment-\d+$/.test(receipt.urls[0]));
  if (!receipts.some(receipt => receipt?.remoteUpdatedAt === issue.updatedAt)) return false;
  const ownReplies = new Set(receipts.flatMap(receipt => receipt?.urls ?? []));
  return issue.comments === source.issueSnapshot.comments + ownReplies.size;
}
