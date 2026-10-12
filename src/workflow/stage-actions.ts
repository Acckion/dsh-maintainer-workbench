import type { ProcessingTimeline, TimelineNode } from "../domain/timeline.ts";
import type { WorkflowActions } from "./actions.ts";

/** Every stage can launch a fresh run; live controls stay with the current run. */
export function actionsForStage(
  timeline: ProcessingTimeline,
  selected: TimelineNode,
): WorkflowActions | undefined {
  const actions = timeline.actions;
  if (timeline.historical || !actions) return;
  const current = selected.id === timeline.currentNodeId;
  const controls = current ? actions.controls : undefined;
  const primary = actions.stages.find((a) => a.kind === selected.stage) ??
    (actions.primary?.kind === selected.stage ? actions.primary : undefined);
  const stages = primary ? actions.stages : [];
  if (!primary && !controls?.length && !stages.length) return;
  return {
    ...actions,
    primary,
    controls,
    stages,
  };
}
