import { z } from "zod";
import type { Issue, Job, Repo } from "./types.ts";
import { issuePlanSchema } from "./issue-flow.ts";
import { createHash } from "node:crypto";

export const draftSchema = issuePlanSchema.omit({ decision: true }).extend({
  sources: z
    .array(
      z.object({
        field: z.enum([
          "goal",
          "scope",
          "acceptanceCriteria",
          "reproduction",
          "expected",
          "actual",
          "category",
        ]),
        source: z.string().min(1).max(400),
        detail: z.string().max(1000),
      }),
    )
    .max(30),
  missingInfo: z.array(z.string().min(1).max(1000)).max(12),
  route: z.enum(["docs", "fix", "investigate", "answer", "review", "track"]),
});
export type PlanDraft = z.infer<typeof draftSchema> & {
  inputKey: string;
  sourceJobId?: string;
  generatedAt: string;
};
/** Plan identity excludes the confirmed plan; confirmation must not stale its own inputs. */
export function planInputKey(issue: Issue, repo: Repo): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        issue.processing?.id,
        issue.title,
        issue.body,
        issue.updatedAt,
        issue.state,
        issue.headSha,
        issue.prBaseSha,
        repo.headSha,
        issue.informationRequests?.map((r) => [
          r.id,
          r.state,
          r.questions,
          r.replies.map((reply) => [reply.id, reply.body]),
        ]),
      ]),
    )
    .digest("hex");
}
export const planningGuidance = `For triage, preflight and investigation, also return planDraft. Build a concise Chinese editable plan from the supplied issue/PR, repository guidance and current investigation. Do not ask humans to copy known facts. Read applicable guidance for investigation. Never invent acceptance, reproduction or facts. Distinguish recommendations in sources.detail; missing required facts go in missingInfo. planDraft fields: category:bug|feature|docs|question|maintenance, goal:string, scope:string, reproduction:string, expected:string, actual:string, acceptanceCriteria:string[], route:docs|fix|investigate|answer|review|track, sources:[{field:goal|scope|acceptanceCriteria|reproduction|expected|actual|category,source:string,detail:string}], missingInfo:string[]. Sources reference the provided issue/PR URL, repository source path, or current report evidence. Document plans specify exact requested edits and patch-level checks, never invent capabilities or add whole-repository audits. PRs can have mixed changes: include all relevant review focuses in acceptanceCriteria, do not require bug reproduction fields for PR review. Pure questions use answer. Unclear root causes use investigate. All plan fields are draft suggestions, not execution evidence or human authorization.`;

export function draftFromJob(issue: Issue, repo: Repo, job: Job): PlanDraft {
  const a = job.artifact;
  const parsed = draftSchema.safeParse(
    a && "planDraft" in a ? a.planDraft : undefined,
  );
  if (parsed.success)
    return {
      ...parsed.data,
      inputKey: planInputKey(issue, repo),
      sourceJobId: job.id,
      generatedAt: new Date().toISOString(),
    };
  // Legacy outputs remain useful, without pretending their summaries are complete plans.
  const category =
    issue.plan?.category ??
    (a?.stage === "triage"
      ? a.category
      : (issue.analysis?.category ??
        (issue.type === "pr" ? "maintenance" : "bug")));
  return {
    category,
    goal:
      issue.plan?.goal || (a?.stage === "preflight" ? a.intent : issue.title),
    scope: issue.plan?.scope ?? "",
    reproduction:
      issue.plan?.reproduction ||
      (a?.stage === "investigate" ? a.reproduction : ""),
    expected: issue.plan?.expected ?? "",
    actual: issue.plan?.actual ?? "",
    acceptanceCriteria:
      issue.plan?.acceptanceCriteria ??
      (a && "acceptanceCriteria" in a ? a.acceptanceCriteria : []),
    route:
      issue.type === "pr"
        ? "review"
        : category === "question"
          ? "answer"
          : a?.stage === "triage" && a.route === "investigate"
            ? "investigate"
            : category === "docs"
              ? "docs"
              : "fix",
    sources: [
      {
        field: "goal",
        source: issue.url,
        detail: "原事项标题；本报告未提供完整计划草稿，需补齐范围与具体验收。",
      },
    ],
    missingInfo: [
      ...(a?.stage === "triage"
        ? a.missingInfo
        : a && "blockers" in a
          ? a.blockers
          : []),
      ...(!issue.plan?.scope
        ? ["报告未整理具体修改范围，请补充或重新分析。"]
        : []),
    ],
    inputKey: planInputKey(issue, repo),
    sourceJobId: job.id,
    generatedAt: new Date().toISOString(),
  };
}
