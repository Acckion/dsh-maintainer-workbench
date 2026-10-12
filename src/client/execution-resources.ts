import type { Issue, Job } from '../core/types.ts';
import type { WorkspaceRecord } from '../domain/workspaces.ts';

/** Join by persisted ownership, never by a similar path or issue number. */
export function executionResourceGroups(jobs: Job[], issues: Issue[], workspaces: WorkspaceRecord[]) {
  const groups = new Map<string, { issue: Issue; jobs: Job[]; workspaces: WorkspaceRecord[] }>();
  for (const job of [...jobs].sort((a,b)=>a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (!job.sessionId && !job.worktree && !job.analysisPath && !workspaces.some(w=>w.ownerRunId===job.id)) continue;
    const issue = issues.find(i=>i.id===job.issueId && i.repoId===job.repoId) ?? job.issueSnapshot;
    let group = groups.get(job.issueId);
    if (!group) { group = {issue, jobs:[], workspaces:[]}; groups.set(job.issueId,group); }
    group.jobs.push(job);
    group.workspaces.push(...workspaces.filter(w=>w.ownerRunId===job.id && w.repositoryId===job.repoId));
  }
  const assigned = new Set([...groups.values()].flatMap(g=>g.workspaces.map(w=>w.id)));
  return { groups:[...groups.values()].sort((a,b)=>b.jobs.at(-1)!.createdAt.localeCompare(a.jobs.at(-1)!.createdAt)), unassigned:workspaces.filter(w=>!assigned.has(w.id)) };
}
