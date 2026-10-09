import { createHash } from 'node:crypto';
import { lightweight } from './artifacts.ts';
import type { Issue, JobKind, Repo } from './types.ts';

export function revision(issue: Issue, repo: Repo, kind: JobKind = 'triage'): string {
  const fields: unknown[] = [issue.updatedAt, issue.title, issue.body, issue.state, issue.headSha ?? '', issue.type === 'pr' ? [issue.prBaseSha ?? repo.headSha, issue.headSha ?? 'unknown'] : lightweight(kind) ? 'issue-v2' : repo.headSha];
  if (issue.plan) fields.push(issue.plan);
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
