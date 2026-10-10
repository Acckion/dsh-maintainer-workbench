import type { WorkflowState } from "./plan-workflow.ts";

/** Durable business state, independent of an individual Agent run. */
export type ProcessingLifecycle =
  | "active"
  | "waiting"
  | "deferred"
  | "completed"
  | "cancelled";
export const processingPhases = [
  "discovered",
  "triage",
  "preflight",
  "investigate",
  "needs_info",
  "decision",
  "accepted",
  "deferred",
  "implement",
  "answer",
  "answered",
  "track",
  "draft",
  "review",
  "fix",
  "docs",
  "validate",
  "validated",
  "ci",
  "blocked",
  "closed",
] as const;
export type ProcessingPhase = (typeof processingPhases)[number];

export interface ProcessingWait {
  id: string;
  type:
    | "reporter_reply"
    | "user_input"
    | "approval"
    | "host_permission"
    | "author_revision"
    | "ci_completion"
    | "environment_ready";
  state: "open" | "satisfied" | "cancelled" | "superseded";
  targetFingerprint: string;
  requestedByRunId?: string;
  requiredFields?: string[];
  answers?: Record<string, import("./input.ts").InputAnswer>;
  questions?: {
    gapId?: string;
    actor?: "reporter" | "maintainer";
    required?: boolean;
    purpose?: "information" | "decision" | "plan_confirmation";
    id: string;
    question: string;
    options?: { label: string; description?: string }[];
  }[];
  expectedActor?: string;
  reason: string;
  createdAt: string;
  resumeAction?: string;
  targetUrl?: string;
  targetHeadSha?: string;
  targetBaseSha?: string;
}

export interface RemoteObservation {
  url?: string;
  headSha: string;
  baseSha?: string;
  state?: "open" | "closed" | "merged";
  ci?: "pending" | "passed" | "failed" | "unknown";
  review?: "approved" | "changes_requested" | "pending" | "unknown";
  unresolvedThreads?: number;
  complete: boolean;
}

export interface ProcessingCase {
  id: string;
  workItemId: string;
  repositoryId: string;
  workflowDefinitionVersion: string;
  lifecycle: ProcessingLifecycle;
  phase: ProcessingPhase;
  reason: string;
  waits: ProcessingWait[];
  activeRunIds: string[];
  sourceFingerprint: string;
  currentRunId?: string;
  planFingerprint?: string;
  planSourceFingerprint?: string;
  /** Confirmed plan and durable checkpoints for this processing cycle only. */
  planning?: WorkflowState;
  cycle: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ProcessingEventPayload =
  | { type: "planning.recorded"; planning: WorkflowState }
  | { type: "workflow.upgraded"; from: string; to: string }
  | {
      type: "source.observed";
      fingerprint: string;
      state: "open" | "closed";
      itemType: "issue" | "pr";
      merged?: boolean;
      headSha?: string;
    }
  | {
      type: "decision.recorded";
      phase: ProcessingPhase;
      reason: string;
      planFingerprint?: string;
    }
  | {
      type: "information.observed";
      requests: {
        id: string;
        state: "asked" | "reply_received" | "fulfilled" | "dismissed";
        waitingFor: string;
        askedAt: string;
      }[];
    }
  | {
      type: "run.observed";
      runId: string;
      kind: string;
      status: string;
      current: boolean;
      waitingReason?: string;
      phase: ProcessingPhase;
      reason: string;
      pauseReason?: string;
    }
  | { type: "input.requested"; wait: ProcessingWait }
  | { type: "input.submitted"; waitId: string; targetFingerprint: string; answers?: Record<string, import("./input.ts").InputAnswer> }
  | { type: "input.recorded"; waitId: string; targetFingerprint: string; answers: Record<string, import("./input.ts").InputAnswer> }
  | {
      type: "remote.activity";
      kind: "ci" | "reviews" | "threads";
      fingerprint: string;
      observation?: RemoteObservation;
    }
  | {
      type: "publication.confirmed";
      action: string;
      runId: string;
      targetUrl?: string;
      headSha?: string;
      baseSha?: string;
      answerPublished?: boolean;
    }
  | { type: "environment.observed"; ready: boolean; reason: string }
  | { type: "wait.cancelled"; waitId: string; reason: string };

export interface ProcessingEvent {
  id: string;
  caseId: string;
  workItemId: string;
  source: "github" | "user" | "agent" | "system";
  deduplicationKey: string;
  occurredAt: string;
  receivedAt: string;
  payload: ProcessingEventPayload;
}
