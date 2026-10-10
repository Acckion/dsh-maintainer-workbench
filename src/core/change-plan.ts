import {gapsSchema, planGaps, gapsGuidance} from '../domain/gaps.ts';
import { z } from "zod";
import type { Issue, Job, Repo } from "./types.ts";
import { issuePlanSchema } from "./issue-flow.ts";
import { createHash } from "node:crypto";
import type { InputRequest } from "../domain/input.ts";

/** Route authorization to the plan UI; never treat this as permission to execute. */
export function planningInputRequest(artifact: Job["artifact"], request?: InputRequest): InputRequest | undefined {
  if (!request) return request;
  const meaningful = request.fields.filter(f=>f.purpose!=="plan_confirmation" &&
    !(f.gapId && artifact?.gaps?.some(g=>g.id===f.gapId && (g.status==="resolved" || !["reporter_information","maintainer_decision"].includes(g.kind)))));
  if(!meaningful.length)return undefined;
  request = meaningful.length===request.fields.length?request:{...request,fields:meaningful};
  if (!artifact || !["triage", "preflight", "investigate"].includes(artifact.stage)) return request;
  const parsed = draftSchema.safeParse("planDraft" in artifact ? artifact.planDraft : undefined);
  if (!parsed.success || !parsed.data.goal.trim() || !parsed.data.scope.trim() ||
      (!parsed.data.acceptanceCriteria.length || !parsed.data.acceptanceCriteria.every(s => s.trim())) ||
      !["docs", "fix", "investigate", "review"].includes(parsed.data.route)) return request;
  const fields = request.fields.filter(field => {
    if (field.purpose === "plan_confirmation") return false;
    if (field.purpose) return true;
    // Narrow compatibility for prior reports; ordinary yes/no decisions remain inputs.
    return !(field.id === "confirm_plan" &&
      /确认.{0,20}(计划|草稿).{0,20}(实施|执行|开始)|confirm.{0,30}plan.{0,30}(implement|execute|start)/i.test(field.question));
  });
  return fields.length === request.fields.length ? request : fields.length ? { ...request, reason: "计划确认由界面处理；仍需补充以下信息或作出取舍", fields } : undefined;
}

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
  gaps: gapsSchema.optional(),
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
export const planningGuidance = gapsGuidance + `For triage, preflight and investigation, also return planDraft. Build a concise Chinese editable plan from the supplied issue/PR, repository guidance and current investigation. Do not ask humans to copy known facts. Read applicable guidance for investigation. Never invent acceptance, reproduction or facts. Distinguish recommendations in sources.detail; missing required facts go in missingInfo. planDraft fields: category:bug|feature|docs|question|maintenance, goal:string, scope:string, reproduction:string, expected:string, actual:string, acceptanceCriteria:string[], route:docs|fix|investigate|answer|review|track, sources:[{field:goal|scope|acceptanceCriteria|reproduction|expected|actual|category,source:string,detail:string}], missingInfo:string[]. Sources reference the provided issue/PR URL, repository source path, or current report evidence. Document plans specify exact requested edits and patch-level checks, never invent capabilities or add whole-repository audits. PRs can have mixed changes: include all relevant review focuses in acceptanceCriteria, do not require bug reproduction fields for PR review. Pure questions use answer. Unclear root causes use investigate. All plan fields are draft suggestions, not execution evidence or human authorization. PLAN CONFIRMATION IS OWNED BY THE HOST UI: return the draft and stop; never ask whether to confirm/start/execute it in inputRequest. inputRequest is only for genuinely missing human-provided facts (purpose:information) or substantive choices not resolved by supplied materials (purpose:decision). Unread repository files, file existence and anchor checks are future system checks, not human information gaps; put them in nextSteps or acceptanceCriteria, not missingInfo.`;

export function draftFromJob(issue: Issue, repo: Repo, job: Job): PlanDraft {
  const a = job.artifact;
  const parsed = draftSchema.safeParse(
    a && "planDraft" in a ? a.planDraft : undefined,
  );
  if (parsed.success)
    return {
      ...parsed.data,
      gaps: planGaps({...parsed.data, gaps: parsed.data.gaps ?? a?.gaps}),
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
      issue.plan && /不修改文件|不实施修复|只读/.test(issue.plan.scope) ? "investigate" :
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
