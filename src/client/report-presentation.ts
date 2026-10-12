import { reportNeedsRecovery } from '../core/report-state.ts';
import type { Job } from '../core/types.ts';
import type { ProcessingTimeline } from '../domain/timeline.ts';

/** Refresh report wording from run records, without changing server eligibility or run targets. */
export function reportPresentation(timeline: ProcessingTimeline, jobs: readonly Job[]): ProcessingTimeline {
  const runs = new Map(jobs.map(job => [job.id, job]));
  return {
    ...timeline,
    nodes: timeline.nodes.map(node => {
      const run = runs.get(node.id === timeline.currentNodeId
        ? timeline.currentRunId ?? '' : node.attemptIds.at(-1) ?? '');
      return node.status === 'blocked' && run && reportNeedsRecovery(run)
        ? { ...node, result: '报告待整理' } : node;
    }),
    actions: timeline.actions && {
      ...timeline.actions,
      controls: timeline.actions.controls?.map(control => {
        const run = runs.get(control.runId);
        return control.kind === 'retry' && run && reportNeedsRecovery(run)
          ? { ...control, label: '重新整理报告' } : control;
      }),
    },
  };
}
