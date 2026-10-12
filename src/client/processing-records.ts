import type { Job } from "../core/types.ts";
import type { ProcessingEvent } from "../domain/processing.ts";
import type { ProcessingTimeline } from "../domain/timeline.ts";

export type ProcessingRecord =
  | {
      id: string;
      at: string;
      job: Job;
      attempt: number;
      events: ProcessingEvent[];
    }
  | { id: string; at: string; event: ProcessingEvent };

const eventTime = (event: ProcessingEvent) =>
  event.occurredAt || event.receivedAt;

/** Group lifecycle observations by their saved run ID; human decisions remain separate. */
export function processingRecords(
  timeline: Pick<ProcessingTimeline, "caseId" | "issueId" | "cycle" | "events">,
  history: Job[],
): ProcessingRecord[] {
  const jobs = history
    .filter(
      (job) =>
        job.issueId === timeline.issueId &&
        (job.caseId ? job.caseId === timeline.caseId : timeline.cycle === 1),
    )
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const events = timeline.events
    .filter(
      (event) =>
        event.caseId === timeline.caseId &&
        event.workItemId === timeline.issueId,
    )
    .sort(
      (a, b) =>
        eventTime(a).localeCompare(eventTime(b)) ||
        a.receivedAt.localeCompare(b.receivedAt),
    );
  const attempts = new Map<Job["kind"], number>();
  const runs = new Map<string, Extract<ProcessingRecord, { job: Job }>>();
  const records: ProcessingRecord[] = jobs.map((job) => {
    const attempt = (attempts.get(job.kind) ?? 0) + 1;
    attempts.set(job.kind, attempt);
    const record = {
      id: `run:${job.id}`,
      at: job.createdAt,
      job,
      attempt,
      events: [] as ProcessingEvent[],
    };
    runs.set(job.id, record);
    return record;
  });
  for (const event of events) {
    const run =
      event.payload.type === "run.observed"
        ? runs.get(event.payload.runId)
        : undefined;
    if (run) {
      run.events.push(event);
      if (eventTime(event) > run.at) run.at = eventTime(event);
    } else
      records.push({ id: `event:${event.id}`, at: eventTime(event), event });
  }
  return records.sort(
    (a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id),
  );
}
