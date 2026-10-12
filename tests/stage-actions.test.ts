import assert from "node:assert/strict";
import test from "node:test";
import { actionsForStage } from "../src/workflow/stage-actions.ts";
import type {
  ProcessingTimeline,
  TimelineNode,
} from "../src/domain/timeline.ts";
const node = (
  id: string,
  stage: TimelineNode["stage"],
  status: TimelineNode["status"],
): TimelineNode => ({
  id,
  stage,
  status,
  label: stage,
  result: "",
  attemptIds: [],
  waits: [],
  conditions: [],
});
const saved = node("saved", "triage", "saved");
const next = node("next", "investigate", "future");
const view = {
  historical: false,
  currentNodeId: saved.id,
  nodes: [saved, next],
  actions: {
    primary: {
      kind: "investigate",
      label: "开始调查",
      enabled: true,
      blockedReasons: [],
    },
    stages: [],
    expectedVersion: 7,
  },
} as unknown as ProcessingTimeline;
test("start action belongs to its destination, never the saved source stage", () => {
  assert.equal(actionsForStage(view, saved), undefined);
  assert.equal(actionsForStage(view, next)?.primary?.kind, "investigate");
  assert.equal(actionsForStage(view, next)?.expectedVersion, 7);
  assert.equal(actionsForStage({ ...view, historical: true }, next), undefined);
});
test("live controls remain with the current run rather than future stages", () => {
  const actions = {
    ...view.actions!,
    primary: undefined,
    controls: [
      {
        kind: "cancel" as const,
        runId: "run",
        label: "停止",
        enabled: true,
        blockedReasons: [],
      },
    ],
  };
  assert.equal(
    actionsForStage({ ...view, actions }, saved)?.controls?.[0].runId,
    "run",
  );
  assert.equal(actionsForStage({ ...view, actions }, next), undefined);
});
test("reassessment belongs to the new attempt rather than older evidence of the same stage", () => {
  const old = node("old", "investigate", "saved");
  const timeline = { ...view, currentNodeId: old.id, nodes: [old, next] };
  assert.equal(actionsForStage(timeline, old), undefined);
  assert.equal(actionsForStage(timeline, next)?.primary?.kind, "investigate");
});

test("additional task choices are scoped to their future destination", () => {
  const fix = node("fix", "fix", "future");
  const stages = [
    {
      kind: "fix" as const,
      label: "修复",
      enabled: false,
      blockedReasons: ["范围待确认"],
    },
  ];
  const timeline = {
    ...view,
    nodes: [...view.nodes, fix],
    actions: { ...view.actions!, stages },
  };
  assert.equal(actionsForStage(timeline, saved), undefined);
  assert.deepEqual(actionsForStage(timeline, fix)?.stages, stages);
  assert.equal(actionsForStage(timeline, next)?.stages.length, 0);
});
