import { createHash } from "node:crypto";
import type { ActionsSnapshot, RemotePR } from "../core/remote-progress.ts";
import type { RemoteObservation } from "../domain/processing.ts";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const success = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
export function prObservation(pr: RemotePR): RemoteObservation {
  const complete = !pr.error && !pr.partial;
  return {
    url: pr.url,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    state: pr.mergedAt
      ? "merged"
      : pr.state === "CLOSED"
        ? "closed"
        : pr.state === "OPEN"
          ? "open"
          : undefined,
    complete,
    ci:
      !complete || !pr.checks.length
        ? "unknown"
        : pr.checks.some((c) => c.status !== "COMPLETED")
          ? "pending"
          : pr.checks.some((c) => !success.has(c.conclusion ?? ""))
            ? "failed"
            : "passed",
    review: !complete
      ? "unknown"
      : pr.review === "APPROVED"
        ? "approved"
        : pr.review === "CHANGES_REQUESTED"
          ? "changes_requested"
          : "pending",
  };
}
export function actionsObservation(
  snapshot: ActionsSnapshot,
): RemoteObservation {
  const complete = !snapshot.warnings.length;
  return {
    headSha: snapshot.headSha,
    baseSha: snapshot.baseSha,
    complete,
    ci:
      !complete || !snapshot.jobs.length
        ? "unknown"
        : snapshot.jobs.some((j) => j.status !== "completed")
          ? "pending"
          : snapshot.jobs.some(
                (j) => !success.has((j.conclusion ?? "").toUpperCase()),
              )
            ? "failed"
            : "passed",
  };
}
/** Ignore poll timestamps, but retain identities, conclusions and coverage changes. */
export const remoteIdentity = (pr: RemotePR) => ({
  ...pr,
  syncedAt: undefined,
});
export const actionsIdentity = (value: ActionsSnapshot) => ({
  ...value,
  syncedAt: undefined,
});
