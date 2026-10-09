import type { Job } from './types.ts';
import { validationState } from './workflow-state.ts';

export interface ValidationAcceptance {
  allowed: boolean;
  reason?: string;
  latest?: Job;
}

type IsCurrent = (job: Job) => boolean;
const finished = new Set<Job['status']>(['completed', 'awaiting_review', 'approved']);

function sameTarget(a: Job, b: Job): boolean {
  const samePr = !a.prContext && !b.prContext || !!a.prContext && !!b.prContext
    && ['headSha', 'baseSha', 'headRef', 'headRepo', 'baseRef'].every(key => Reflect.get(a.prContext!, key) === Reflect.get(b.prContext!, key));
  return a.repoId === b.repoId && a.issueId === b.issueId && a.issueSnapshot.number === b.issueSnapshot.number
    && a.revision === b.revision && a.baseSha === b.baseSha && samePr;
}

function later(a: Job, b: Job): number {
  return a.createdAt.localeCompare(b.createdAt) || a.attempt - b.attempt || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
}

/**
 * Failed or abandoned validation matters only when it is a descendant of this
 * exact implementation. Patch text alone must never block another change.
 */
export function validationAcceptance(implementation: Job, jobs: Job[], isCurrent: IsCurrent = job => job.artifactState !== 'stale'): ValidationAcceptance {
  if (!['fix', 'docs'].includes(implementation.kind) || !implementation.patch) return { allowed: true };
  const children = new Map<string, Job[]>();
  for (const job of jobs) if (job.sourceJobId && ['validate', 'review'].includes(job.kind)) children.set(job.sourceJobId, [...(children.get(job.sourceJobId) ?? []), job]);
  const validations: Job[] = [], seen = new Set([implementation.id]), queue = [{ job: implementation, depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];
    if (parent.depth >= 30) continue;
    for (const candidate of children.get(parent.job.id) ?? []) {
      if (seen.has(candidate.id) || !sameTarget(implementation, candidate)) continue;
      // A cancelled/failed validator can stop before saving its patch. Its
      // explicit handoff still binds it to this implementation and must block.
      if (candidate.patch && candidate.patch !== implementation.patch) continue;
      seen.add(candidate.id);
      if (candidate.kind === 'validate') validations.push(candidate);
      queue.push({ job: candidate, depth: parent.depth + 1 });
    }
  }
  if (!validations.length) return { allowed: true };
  const latest = validations.sort(later).at(-1)!;
  if (!isCurrent(latest)) return { allowed: false, latest, reason: '同一补丁的最新验证已过期，请重新验证后再接受此实施产物。' };
  if (latest.status === 'cancelled') return { allowed: false, latest, reason: '同一补丁的最新验证已取消，请重新验证后再接受此实施产物。' };
  if (latest.status === 'failed' || latest.status === 'rejected') return { allowed: false, latest, reason: '同一补丁的最新验证未完成，请重新验证后再接受此实施产物。' };
  if (!finished.has(latest.status)) return { allowed: false, latest, reason: '同一补丁的最新验证仍在进行，请等待结果后再接受此实施产物。' };
  const state = validationState(latest.artifact);
  if (state?.state === 'passed') return { allowed: true, latest };
  return { allowed: false, latest, reason: `同一补丁的最新验证：${state?.reason ?? '没有可接受的完整通过结果。'}` };
}
