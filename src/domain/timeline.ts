import type { JobKind } from "../core/types.ts";
import type { ProcessingEvent, ProcessingWait } from "./processing.ts";
import type { WorkflowActions } from "../workflow/actions.ts";

export type TimelineStage = JobKind | "decision" | "track";
export type TimelineStatus =
  | "saved"
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "stale"
  | "future"
  | "completed";
export interface TaskProfile {
  category: string;
  label: string;
  areas: string[];
  focus: string[];
  provisional: boolean;
  basis: string;
}
export interface TimelineNode {
  id: string;
  stage: TimelineStage;
  label: string;
  status: TimelineStatus;
  result: string;
  attemptIds: string[];
  occurredAt?: string;
  waits: ProcessingWait[];
  conditions: string[];
}
export interface ProcessingTimeline {
  issueId: string;
  caseId: string;
  version: number;
  cycle: number;
  historical: boolean;
  currentNodeId: string;
  currentRunId?: string;
  profile: TaskProfile;
  nodes: TimelineNode[];
  events: ProcessingEvent[];
  eventTotal: number;
  actions?: WorkflowActions;
  reason: string;
  draft: boolean;
  next: string;
}
