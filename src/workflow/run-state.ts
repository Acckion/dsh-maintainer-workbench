import type { Job } from "../core/types.ts";
import { validationState } from "../core/workflow-state.ts";
import type { ProcessingPhase } from "../domain/processing.ts";

/** Translate execution outcomes to business phases; successful execution is not successful validation. */
export function runState(job: Job): { phase: ProcessingPhase; reason: string } {
  if (job.status === "waiting_environment")
    return { phase: job.kind, reason: job.error ?? "等待仓库环境准备" };
  if (job.status === "waiting_input")
    return {
      phase: job.kind,
      reason: job.artifact?.inputRequest?.reason ?? "等待用户输入",
    };
  if (["failed", "cancelled", "rejected"].includes(job.status))
    return {
      phase: "blocked",
      reason:
        job.error ?? job.reviewNote ?? "任务已停止，请检查证据后决定是否继续",
    };
  if (["queued", "running"].includes(job.status))
    return {
      phase: job.kind,
      reason:
        job.waitingReason ??
        `${job.kind} 任务${job.status === "queued" ? "已排队" : "正在执行"}`,
    };
  const artifact = job.artifact;
  const validation = validationState(artifact);
  if (validation)
    return {
      phase: validation.state === "passed" ? "validated" : "blocked",
      reason: validation.reason,
    };
  if (artifact?.stage === "triage")
    return { phase: artifact.route, reason: artifact.routeReason };
  if (artifact?.stage === "preflight")
    return { phase: artifact.readiness, reason: artifact.summary };
  return {
    phase: ["fix", "docs"].includes(job.kind) ? "review" : job.kind,
    reason:
      job.goalPauseReason ??
      artifact?.summary ??
      job.result?.summary ??
      "阶段产物已保存",
  };
}
