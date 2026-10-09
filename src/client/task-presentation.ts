import type { Job } from '../core/types.ts';
import { validationState } from '../core/workflow-state.ts';
export type TaskFilter = 'attention' | 'running' | 'completed' | 'failed' | 'all';
export interface TaskGroup { id: string; latest: Job; members: Job[]; state: TaskFilter; }
const lightweight = (job: Job) => ['triage', 'preflight'].includes(job.kind);
/** Group only persisted source chains, never unrelated runs on the same Issue. */
export function taskGroups(jobs: Job[], includeQuick = false): TaskGroup[] {
  const byId = new Map(jobs.map(job => [job.id, job]));
  const root = (job: Job): string => {
    const seen = new Set<string>(); let current = job;
    while (current.sourceJobId && !seen.has(current.id)) {
      seen.add(current.id); const parent = byId.get(current.sourceJobId);
      if (!parent || parent.repoId !== job.repoId || parent.issueId !== job.issueId || lightweight(parent)) break;
      current = parent;
    }
    return current.id;
  };
  const depth = (job: Job) => { let count=0,current=job;const seen=new Set<string>();while(current.sourceJobId && !seen.has(current.id)){seen.add(current.id);const parent=byId.get(current.sourceJobId);if(!parent)break;count++;current=parent;}return count; };
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    if (!includeQuick && lightweight(job)) continue;
    const id = job.goalId ?? root(job); groups.set(id, [...(groups.get(id) ?? []), job]);
  }
  return [...groups].map(([id, members]) => {
    members.sort((a,b) => b.createdAt.localeCompare(a.createdAt) || depth(b)-depth(a));
    const latest = members[0];
    const state: TaskFilter = members.some(job => ['running','queued'].includes(job.status)) ? 'running'
      : ['failed','cancelled','rejected'].includes(latest.status) || validationState(latest.artifact)?.state === 'failed' ? 'failed'
      : (latest.goalPauseReason && latest.status !== 'approved') || members.some(job => job.status === 'awaiting_review') || validationState(latest.artifact)?.state === 'incomplete' ? 'attention' : 'completed';
    return { id, latest, members, state };
  }).sort((a,b) => b.latest.createdAt.localeCompare(a.latest.createdAt));
}
