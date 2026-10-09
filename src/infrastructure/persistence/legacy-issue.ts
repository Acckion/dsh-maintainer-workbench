import type { Issue } from "../../core/types.ts";
import {
  processingPhases,
  type ProcessingPhase,
} from "../../domain/processing.ts";

/** Read old disk records once. Runtime services neither read nor write this field. */
interface LegacyIssue extends Issue {
  workflow?: { stage: string; reason: string; updatedAt: string };
}
export function initialProcessing(issue: Issue): {
  phase: ProcessingPhase;
  reason: string;
} {
  const old = (issue as LegacyIssue).workflow;
  return {
    phase:
      old && processingPhases.includes(old.stage as ProcessingPhase)
        ? (old.stage as ProcessingPhase)
        : "discovered",
    reason: old?.reason ?? "事项已发现",
  };
}
export function currentIssue(issue: Issue): Issue {
  const { workflow, ...current } = issue as LegacyIssue;
  return current;
}
