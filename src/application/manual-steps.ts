import { z } from "zod";
import type { Workbench } from "../core/workbench.ts";
import type { Issue, Job } from "../core/types.ts";
import type { TimelineStage } from "../domain/timeline.ts";
import {
  canonicalStage,
  manualSource,
  nextManualStage,
} from "../workflow/manual.ts";
import { processingTimeline } from "./timeline.ts";

export const manualStepSchema = z
  .object({
    issueId: z.string(),
    caseId: z.string(),
    stage: z.enum([
      "triage",
      "preflight",
      "investigate",
      "decision",
      "fix",
      "docs",
      "validate",
      "review",
      "ci",
      "track",
    ]),
    mode: z.enum(["supplement", "takeover", "skip", "complete", "reopen"]),
    text: z.string().max(16000).default(""),
    requestId: z.string().min(1).max(100),
    expectedVersion: z.number().int().nonnegative(),
    sourceFingerprint: z.string().max(200).optional(),
  })
  .refine(
    (p) => !["complete", "supplement"].includes(p.mode) || !!p.text.trim(),
    { message: "请填写结果" },
  );

/** Human decisions are durable before old execution is cancelled. No synthetic artifacts. */
export class ManualStepService {
  constructor(private wb: Workbench) {}
  submit(value: unknown) {
    const p = manualStepSchema.parse(value),
      store = this.wb.store;
    const previous = store.get<Issue>("issues", p.issueId);
    if (!previous?.processing || previous.processing.id !== p.caseId)
      throw new Error("处理周期已变化，输入已保留");
    const old = previous.processing.manualSteps?.find(
      (r) => r.id === p.requestId,
    );
    if (old) {
      if (
        canonicalStage(previous, old.stage) !==
          canonicalStage(previous, p.stage) ||
        old.mode !== p.mode ||
        old.text !== p.text
      )
        throw new Error("请求标识已用于另一项决定");
      return { ok: true, reused: true };
    }
    let runIds: string[] = [];
    const cleanupWarnings: string[] = [];
    if (
      p.sourceFingerprint &&
      p.sourceFingerprint !== previous.processing.sourceFingerprint
    )
      cleanupWarnings.push(
        "事项来源有更新；你的决定仍生效，文字结果保留原来源版本。",
      );
    store.transaction(() => {
      const issue = store.get<Issue>("issues", p.issueId)!;
      const state = issue.processing!;
      if (
        issue.state !== "open" ||
        ["completed", "cancelled"].includes(state.lifecycle)
      )
        throw new Error("当前事项不可处置");
      const timeline = processingTimeline(store, p.issueId);
      const current = timeline.nodes.find(
        (n) => n.id === timeline.currentNodeId,
      )!;
      const target = canonicalStage(issue, p.stage);
      if (
        p.expectedVersion > state.version ||
        (canonicalStage(issue, current.stage) !== target &&
          timeline.actions?.primary?.kind !== target &&
          !(
            p.mode === "reopen" &&
            state.manualSteps?.some((r) => r.stage === target)
          ))
      )
        throw new Error("目标阶段已变化，输入已保留，请核对阶段");
      runIds = store
        .jobs()
        .filter(
          (j) =>
            j.issueId === p.issueId &&
            (!j.caseId || j.caseId === state.id) &&
            (canonicalStage(issue, j.kind) === target ||
              j.id === state.currentRunId) &&
            !state.revokedRunIds?.includes(j.id),
        )
        .map((j) => j.id);
      const nextStage = nextManualStage(issue, target);
      store.processing.dispatch(
        p.issueId,
        {
          type: "step.manual",
          record: {
            id: p.requestId,
            stage: target,
            mode: p.mode,
            text: p.text,
            actor: "user",
            at: new Date().toISOString(),
            sourceFingerprint: p.sourceFingerprint ?? state.sourceFingerprint,
            runIds,
          },
          nextStage,
        },
        "user",
        `manual:${p.requestId}`,
        state.version,
      );
      if (p.mode !== "supplement") {
        const updated = store.get<Issue>("issues", p.issueId)!;
        store.put("issues", {
          ...updated,
          informationRequests: updated.informationRequests?.map((r) =>
            ["asked", "reply_received"].includes(r.state)
              ? { ...r, state: "dismissed" as const }
              : r,
          ),
        });
      }
      store.audit(
        "processing.manual",
        `${target}: ${p.mode}`,
        state.currentRunId ?? null,
      );
    });
    if (p.mode !== "supplement") {
      for (const id of runIds) {
        const job = store.get<Job>("jobs", id)!;
        if (
          [
            "queued",
            "running",
            "waiting_input",
            "waiting_environment",
          ].includes(job.status)
        )
          try {
            this.wb.cancel(id);
          } catch (error) {
            cleanupWarnings.push(
              `用户决定已生效；旧运行尚未停止：${error instanceof Error ? error.message : String(error)}`,
            );
            store.audit(
              "processing.manual_cleanup",
              `用户决定已生效；旧运行清理失败：${error instanceof Error ? error.message : String(error)}`,
              id,
            );
          }
      }
      if (["skip", "complete"].includes(p.mode)) {
        const issue = store.get<Issue>("issues", p.issueId)!;
        const next = issue.processing?.manualCursor;
        const goalRunIds = [
          ...runIds,
          ...(previous.processing.manualSteps?.findLast(
            (r) =>
              r.stage === canonicalStage(previous, p.stage) &&
              r.mode === "takeover",
          )?.runIds ?? []),
        ];
        const goalJob = goalRunIds
          .map((id) => store.get<Job>("jobs", id)!)
          .find((j) => j.goal === "resolve" && !j.workflowRunId);
        if (
          (["running", "blocked", "paused"].includes(
            previous.orchestration?.run?.status ?? "",
          ) ||
            goalJob) &&
          next &&
          !["track", "decision"].includes(next)
        ) {
          const source = manualSource(
            issue,
            this.wb.snapshot().jobs,
            next as Exclude<TimelineStage, "track" | "decision">,
          );
          // No real patch means no patch-consuming task; the user can still continue manually.
          if (
            issue.type === "pr" ||
            !["validate", "review"].includes(next) ||
            source
          ) {
            if (goalJob) {
              try {
                this.wb.enqueue(
                  [issue.id],
                  next as Exclude<TimelineStage, "track" | "decision">,
                  {
                    sourceJobId: source?.id,
                    goal: goalJob.goal,
                    goalId: goalJob.goalId,
                    instructions: goalJob.instructions,
                  },
                );
              } catch (error) {
                store.audit(
                  "processing.manual_continuation",
                  error instanceof Error ? error.message : String(error),
                );
              }
            } else
              this.wb.orchestration.continueManual(
                p.issueId,
                next as Exclude<TimelineStage, "track" | "decision">,
                source?.id,
              );
          }
        }
      }
    }
    return { ok: true, cleanupWarnings };
  }
}
