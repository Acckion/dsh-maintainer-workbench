import type { IssuePlan, JobKind } from "../core/types.ts";
import type { PlanDraft } from "../core/change-plan.ts";

export interface WorkflowRun {
  caseId?: string;
  id: string;
  inputKey: string;
  planVersion: string;
  plan: IssuePlan;
  route: JobKind;
  status:
    | "running"
    | "blocked"
    | "review"
    | "paused"
    | "cancelled"
    | "waiting_author";
  currentJobId?: string;
  checkpoint?: { kind: JobKind; sourceJobId?: string; instructions: string };
  completedJobIds: string[];
  reason: string;
  startedAt: string;
  deadlineAt: string;
  maxSteps: number;
  waitingHead?: string;
}
export interface WorkflowProgress {
  status:
    | "plan"
    | "running"
    | "blocked"
    | "review"
    | "waiting"
    | "stale"
    | "deferred";
  reason: string;
}
export interface WorkflowState {
  draft?: PlanDraft;
  run?: WorkflowRun;
  previousRuns?: WorkflowRun[];
}
