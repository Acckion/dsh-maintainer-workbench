import { createHash } from 'node:crypto';
import type { Artifact } from './artifacts.ts';
import type { Issue } from './types.ts';

/** Classification depends on source metadata, not local plans or later execution reports. */
export function classificationRevision(issue: Issue): string {
  return createHash('sha256').update(JSON.stringify([issue.type, issue.title, issue.body, issue.comments, [...issue.labels].sort(), issue.headSha ?? '', issue.prBaseSha ?? ''])).digest('hex');
}
export function classifyArtifact(artifact: Artifact | undefined, issue: Issue, jobId: string): Issue['classification'] {
  if (!artifact || !['triage', 'preflight'].includes(artifact.stage) || !('category' in artifact) || !artifact.category || !('priority' in artifact) || !artifact.priority) return undefined;
  return { category: artifact.category, priority: artifact.priority, labels: [...new Map((artifact.labels ?? []).map(label => [label.trim().toLowerCase(), label.trim()])).values()].filter(Boolean).slice(0, 8), revision: classificationRevision(issue), jobId, updatedAt: new Date().toISOString() };
}
