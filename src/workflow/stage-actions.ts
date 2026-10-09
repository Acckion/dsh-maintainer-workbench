import type { ProcessingTimeline, TimelineNode } from "../domain/timeline.ts";
import type { WorkflowActions } from "./actions.ts";

/** Start controls belong to their destination; run controls stay with the live run. */
export function actionsForStage(
  timeline: ProcessingTimeline,
  selected: TimelineNode,
): WorkflowActions | undefined {
  const actions = timeline.actions;
  if (timeline.historical || !actions) return;
  const current = selected.id === timeline.currentNodeId;
  const controls = current ? actions.controls : undefined;
  const destination =
    timeline.nodes.find(
      (n) => n.stage === actions.primary?.kind && n.status === "future",
    ) ??
    timeline.nodes.find(
      (n) =>
        n.stage === actions.primary?.kind && n.id === timeline.currentNodeId,
    );
  const primary = destination?.id === selected.id ? actions.primary : undefined;
  const stages =
    selected.status === "future" || primary || controls?.length
      ? actions.stages.filter((a) => a.kind === selected.stage)
      : [];
  if (!primary && !controls?.length && !stages.length) return;
  return {
    ...actions,
    primary,
    controls,
    stages,
  };
}
