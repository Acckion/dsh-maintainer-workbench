import { modelData } from "../core/model-input.ts";
import type { Issue, Job, JobKind } from "../core/types.ts";
import type { ManualStepRecord, ProcessingCase } from "../domain/processing.ts";
import type { TimelineStage } from "../domain/timeline.ts";

export function mergedDiagnosis(issue: Issue): boolean {
  return (
    issue.type === "issue" &&
    (issue.plan?.category ?? issue.analysis?.category) === "bug"
  );
}
export function canonicalStage(
  issue: Issue,
  stage: TimelineStage,
): TimelineStage {
  return mergedDiagnosis(issue) && stage === "decision" ? "investigate" : stage;
}
export function stepDisposition(
  state: ProcessingCase | undefined,
  stage: TimelineStage,
): ManualStepRecord | undefined {
  return state?.manualSteps?.findLast(
    (r) => r.stage === stage && r.mode !== "supplement",
  );
}
export function stepResolved(
  state: ProcessingCase | undefined,
  stage: TimelineStage,
): boolean {
  const record = stepDisposition(state, stage);
  return record?.mode === "skip" || record?.mode === "complete";
}
export function scopeResolved(issue: Issue): boolean {
  return stepResolved(
    issue.processing,
    mergedDiagnosis(issue) ? "investigate" : "decision",
  );
}
export function nextManualStage(
  issue: Issue,
  stage: TimelineStage,
): TimelineStage | undefined {
  if (stage === "track") return;
  if (stage === "triage") return "investigate";
  if (stage === "preflight" || stage === "ci") return "review";
  if (stage === "investigate")
    return issue.type === "pr"
      ? "review"
      : (issue.plan?.category ?? issue.analysis?.category) === "question"
        ? "decision"
        : mergedDiagnosis(issue)
          ? "fix"
          : "decision";
  if (stage === "decision")
    return issue.type === "pr" ||
      (issue.plan?.category ?? issue.analysis?.category) === "question"
      ? "track"
      : issue.plan?.category === "docs"
        ? "docs"
        : "fix";
  if (stage === "fix" || stage === "docs") return "validate";
  if (stage === "validate") return "review";
  return issue.type === "pr" ? "decision" : "track";
}
/** Choose real saved patches, never fabricate a Job from manual text. */
export function manualSource(
  issue: Issue,
  jobs: Job[],
  kind: JobKind,
): Job | undefined {
  if (!["validate", "review"].includes(kind)) return;
  return [...jobs]
    .sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.attempt - a.attempt,
    )
    .find(
      (j) =>
        j.issueId === issue.id &&
        (!j.caseId || j.caseId === issue.processing?.id) &&
        j.patch &&
        j.result &&
        j.artifactState !== "stale" &&
        ["completed", "awaiting_review", "approved"].includes(j.status),
    );
}
export function manualContext(issue: Issue): string {
  const records = issue.processing?.manualSteps ?? [];
  return records.length
    ? "\nExplicit maintainer decisions (authoritative; newer explicit maintainer instructions override older plans and Agent conclusions; preserve original text, obey instructions, do not repeat skipped/completed work or demand missing fields/evidence; user_reported is not tool_executed; the latest non-supplement decision for each stage supersedes earlier dispositions, and explicit reopen allows executing that stage again):\n" +
        modelData(records)
    : "";
}

export function withManualContext(
  instructions: string | undefined,
  issue: Issue,
): string {
  const base = instructions ?? "";
  const marker = base.indexOf("\nExplicit maintainer decisions (");
  return (
    (marker < 0 ? base : base.slice(0, marker)).slice(0, 8000) +
    manualContext(issue)
  );
}
