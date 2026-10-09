import type { Store } from "../core/store.ts";
import type { Issue, Repo } from "../core/types.ts";
import type { ProcessingTimeline } from "../domain/timeline.ts";
import { revision } from "../core/revision.ts";
import { availableActions } from "../workflow/actions.ts";
import { projectTimeline } from "../workflow/timeline.ts";
export { projectTimeline } from "../workflow/timeline.ts";

export function processingTimeline(
  store: Store,
  issueId: string,
  caseId?: string,
): ProcessingTimeline {
  return store.transaction(() => {
    const item = store.get<Issue>("issues", issueId),
      current = store.processing.current(issueId);
    if (!item || !current) throw new Error("事项不存在");
    const state = caseId
      ? store.processing.cases(issueId).find((c) => c.id === caseId)
      : current;
    if (!state) throw new Error("处理周期不属于此事项");
    const historical = state.id !== current.id;
    const repo = store.get<Repo>("repos", item.repoId);
    const jobs = store
      .jobs()
      .filter((j) => j.issueId === issueId)
      .map((job) => ({
        ...job,
        artifactState: historical
          ? "historical"
          : repo &&
              job.revision === revision(item, repo, job.kind) &&
              (!job.caseId || job.caseId === current.id)
            ? "current"
            : "stale",
      }));
    const selected =
      jobs.find((j) => j.id === state.currentRunId) ??
      (!state.currentRunId
        ? jobs
            .filter(
              (j) => j.caseId === state.id || (!j.caseId && state.cycle === 1),
            )
            .at(-1)
        : undefined);
    const viewItem = historical
      ? { ...(selected?.issueSnapshot ?? item), processing: state }
      : item;
    const applicableJobs = jobs.filter(
      (j) => j.caseId === state.id || (!j.caseId && state.cycle === 1),
    );
    return projectTimeline(
      viewItem,
      state,
      applicableJobs,
      store.processing.events(state.id),
      historical ? undefined : availableActions(item, selected, applicableJobs),
      historical,
    );
  });
}
