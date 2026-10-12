import type { Job } from "./types.ts";

/** A failed report is recoverable only after the host verified execution integrity. */
export function reportNeedsRecovery(job: Job): boolean {
  return job.status === "failed" && !!job.formatRecovery && !!job.rawOutput && !job.result;
}
