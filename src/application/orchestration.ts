import { ProcessingConflictError } from "../infrastructure/persistence/processing.ts";
import { randomUUID } from "node:crypto";
import type { Issue, Job, JobKind, IssuePlan } from "../core/types.ts";
import type { Workbench } from "../core/workbench.ts";
import {
  draftFromJob,
  planInputKey,
  type PlanDraft,
} from "../core/change-plan.ts";
import { issuePlanSchema, planBlocker } from "../core/issue-flow.ts";
import { validationState } from "../core/workflow-state.ts";

import type {
  WorkflowRun,
  WorkflowState,
  WorkflowProgress,
} from "../domain/plan-workflow.ts";
export type {
  WorkflowRun,
  WorkflowState,
  WorkflowProgress,
} from "../domain/plan-workflow.ts";

/** Coordinates existing jobs; never approves artifacts or writes to GitHub. */
export class Orchestration {
  constructor(private wb: Workbench) {}
  private issue(id: string): Issue {
    const issue = this.wb.store.get<Issue>("issues", id);
    if (!issue || issue.state !== "open") throw new Error("只能处理开放事项");
    return issue;
  }
  private put(issue: Issue, state: WorkflowState) {
    const current = this.wb.store.get<Issue>("issues", issue.id);
    if (!current || current.processing?.id !== issue.processing?.id)
      throw new Error("处理周期已变化，请重新确认计划");
    this.wb.store.put("issues", {
      ...current,
      plan: issue.plan,
      orchestration: state,
    });
  }
  private stop(issue: Issue, status: WorkflowRun["status"], reason: string) {
    const run = issue.orchestration?.run;
    if (run)
      this.put(issue, {
        ...issue.orchestration,
        run: { ...run, status, reason },
      });
  }
  analyze(ids: string[], refresh = false) {
    const results: {
      id: string;
      created?: string[];
      reused?: string[];
      error?: string;
      skipped?: string;
    }[] = [];
    if (!ids.length || ids.length > this.wb.store.settings().maxJobsPerBatch)
      throw new Error("事项数量超出批量上限");
    for (const id of new Set(ids))
      try {
        const issue = this.issue(id),
          repo = this.wb.store.get<import("../core/types.ts").Repo>(
            "repos",
            issue.repoId,
          )!;
        if (
          issue.orchestration?.run?.status === "waiting_author" ||
          (!refresh && issue.orchestration?.run?.status === "paused") ||
          issue.processing?.lifecycle === "deferred" ||
          issue.informationRequests?.some((r) => r.state === "asked")
        ) {
          results.push({ id, skipped: "已暂缓或等待外部回复" });
          continue;
        }
        if (
          this.wb.store
            .jobs()
            .some(
              (j) =>
                j.issueId === id && ["queued", "running"].includes(j.status),
            )
        ) {
          results.push({ id, skipped: "已有执行中的任务" });
          continue;
        }
        if (
          !refresh &&
          issue.orchestration?.draft?.inputKey === planInputKey(issue, repo)
        ) {
          results.push({ id, reused: [] });
          continue;
        }
        let result = this.wb.enqueue(
          [id],
          issue.type === "pr" ? "preflight" : "triage",
          refresh
            ? {
                forceNew: true,
                instructions:
                  "重新整理计划草稿；复用有效事实，明确来源、范围、验收与真实缺口。",
              }
            : {},
        );
        const existing = result.reused
          .map((jobId) => this.wb.store.get<Job>("jobs", jobId)!)
          .find((j) => j.result);
        if (
          existing &&
          (!existing.artifact ||
            !("planDraft" in existing.artifact) ||
            !existing.artifact.planDraft)
        )
          result = this.wb.enqueue(
            [id],
            issue.type === "pr" ? "preflight" : "triage",
            {
              forceNew: true,
              instructions:
                "为历史事项生成新的计划草稿，整理来源、目标、范围、验收与缺口，不执行修改。",
            },
          );
        else if (existing) this.completed(existing);
        results.push({ id, ...result });
      } catch (e) {
        results.push({ id, error: e instanceof Error ? e.message : String(e) });
      }
    return {
      results,
      created: results.flatMap((r) => r.created ?? []),
      reused: results.flatMap((r) => r.reused ?? []),
    };
  }
  start(
    id: string,
    inputKey: string,
    value: unknown,
    route?: JobKind,
    sourceJobId?: string,
    feedback = "",
    expectedVersion?: number,
  ) {
    let issue = this.issue(id);
    const repo = this.wb.store.get<import("../core/types.ts").Repo>(
      "repos",
      issue.repoId,
    )!;
    const draft = issue.orchestration?.draft;
    if (
      !draft ||
      draft.inputKey !== inputKey ||
      inputKey !== planInputKey(issue, repo)
    )
      throw new Error("计划材料已变化，请重新分析");
    if (issue.informationRequests?.some((r) => r.state === "asked"))
      throw new Error("仍在等待已提出的问题，请先处理补充信息");
    if (
      issue.processing?.waits.some(
        (w) =>
          w.state === "open" &&
          ["user_input", "environment_ready"].includes(w.type),
      )
    )
      throw new Error("请先在 Work 面板补充当前输入或恢复环境，原等待请求保留");
    const plan = issuePlanSchema.parse({
      ...issuePlanSchema.parse(value),
      decision: "accepted",
    });
    const suggested = route ?? draft.route;
    if (suggested === "answer" || suggested === "track")
      throw new Error("当前建议是答复或跟踪，请查看处理建议");
    const kind: JobKind = suggested;
    if (!["docs", "fix", "investigate", "review", "triage"].includes(kind))
      throw new Error("当前建议只需准备答复或跟踪，请在事项中处理");
    if (!plan.goal || !plan.scope || !plan.acceptanceCriteria.length)
      throw new Error("请明确目标、范围及具体验收条件");
    const blocker =
      issue.type === "pr" ? undefined : planBlocker({ ...issue, plan }, kind);
    if (blocker) throw new Error(blocker);
    const old = issue.orchestration?.run;
    if (old?.status === "running") {
      if (
        JSON.stringify(old.plan) === JSON.stringify(plan) &&
        old.route === kind &&
        old.inputKey === inputKey
      )
        return {
          created: [],
          reused: old.currentJobId ? [old.currentJobId] : [],
        };
      throw new Error("当前事项正在执行，请先暂停或取消");
    }
    if (
      expectedVersion !== undefined &&
      issue.processing?.version !== expectedVersion
    )
      throw new ProcessingConflictError();
    if (
      this.wb.store
        .jobs()
        .some(
          (j) => j.issueId === id && ["running", "queued"].includes(j.status),
        )
    )
      throw new Error("事项已有执行中的任务");
    const run: WorkflowRun = {
      id: randomUUID(),
      caseId: issue.processing?.id,
      inputKey,
      planVersion: randomUUID(),
      plan,
      route: kind,
      status: "running",
      completedJobIds: [],
      reason: "已确认计划，自动推进实施、验证与审查",
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(
        Date.now() +
          (repo.policy?.timeoutMs ?? this.wb.store.settings().timeoutMs) * 4,
      ).toISOString(),
      maxSteps: 6,
    };
    issue = {
      ...issue,
      plan,
      orchestration: { ...issue.orchestration, draft, run },
    };
    this.put(issue, issue.orchestration!);
    this.wb.store.audit(
      "workflow.authorized",
      `${id}: ${kind} · ${plan.scope}`,
    );
    return this.schedule(issue, kind, sourceJobId, feedback);
  }
  private schedule(
    issue: Issue,
    kind: JobKind,
    sourceJobId?: string,
    feedback = "",
    forceNew = false,
  ) {
    const run = issue.orchestration!.run!;
    if (
      Date.now() > Date.parse(run.deadlineAt) ||
      this.wb.store.jobs().filter((j) => j.workflowRunId === run.id).length >=
        run.maxSteps
    ) {
      this.stop(
        issue,
        "blocked",
        "本次计划执行预算已到上限，请检查已有结果后再决定",
      );
      return { created: [], reused: [] };
    }
    const instructions = `执行已确认计划，不扩大范围。目标：${run.plan.goal}\n范围：${run.plan.scope}\n验收：${run.plan.acceptanceCriteria.join("\n")}\n${kind === "validate" && run.plan.category === "docs" ? "仅验证当前文档补丁，执行宿主指定的文档检查，不运行未要求的全仓库审计。" : ""}\n${feedback}`;
    this.put(issue, {
      ...issue.orchestration,
      run: {
        ...run,
        checkpoint: { kind, sourceJobId, instructions },
        currentJobId: undefined,
      },
    });
    try {
      const result = this.wb.enqueue([issue.id], kind, {
        sourceJobId,
        instructions,
        workflowRunId: run.id,
        forceNew,
      });
      const jobId = result.created[0] ?? result.reused[0];
      const current = this.issue(issue.id);
      if (current.orchestration?.run?.id === run.id)
        this.put(current, {
          ...current.orchestration,
          run: { ...current.orchestration.run, currentJobId: jobId },
        });
      return result;
    } catch (e) {
      this.stop(
        this.issue(issue.id),
        "blocked",
        e instanceof Error ? e.message : String(e),
      );
      return { created: [], reused: [] };
    }
  }
  completed(job: Job): void {
    const issue = this.wb.store.get<Issue>("issues", job.issueId);
    if (!issue || ["queued", "running"].includes(job.status)) return;
    if (job.caseId && job.caseId !== issue.processing?.id) return;
    if (["waiting_input", "waiting_environment"].includes(job.status)) {
      if (job.workflowRunId === issue.orchestration?.run?.id)
        this.stop(
          issue,
          "blocked",
          job.waitingReason ??
            job.error ??
            "等待输入或环境恢复，请在 Work 面板处理",
        );
      return;
    }
    const repo = this.wb.store.get<import("../core/types.ts").Repo>(
      "repos",
      issue.repoId,
    )!;
    let run = issue.orchestration?.run;
    if (
      ["triage", "preflight", "investigate"].includes(job.kind) &&
      job.result &&
      !job.workflowRunId &&
      job.revision === importRevision(issue, repo, job.kind)
    ) {
      const draft = draftFromJob(issue, repo, job);
      this.put(issue, {
        ...issue.orchestration,
        draft,
        ...(run && run.status !== "running"
          ? {
              run: undefined,
              previousRuns: [...(issue.orchestration?.previousRuns ?? []), run],
            }
          : {}),
      });
      if (
        job.kind === "preflight" &&
        job.artifact?.stage === "preflight" &&
        job.artifact.readiness === "review" &&
        (repo.policy?.autoReview ?? this.wb.store.settings().autoReview) &&
        !run &&
        !draft.missingInfo.length &&
        draft.goal &&
        draft.scope &&
        draft.acceptanceCriteria.length
      ) {
        try {
          this.start(
            issue.id,
            draft.inputKey,
            { ...draft, decision: "accepted" },
            "review",
          );
        } catch (error) {
          this.wb.store.audit(
            "workflow.auto_review_blocked",
            String(error),
            job.id,
          );
        }
      }
    }
    if (
      !run ||
      run.id !== job.workflowRunId ||
      run.status !== "running" ||
      run.completedJobIds.includes(job.id)
    )
      return;
    if (
      issue.state !== "open" ||
      (run.caseId !== undefined && run.caseId !== issue.processing?.id) ||
      run.inputKey !== planInputKey(issue, repo) ||
      JSON.stringify(issue.plan) !== JSON.stringify(run.plan)
    ) {
      this.stop(
        issue,
        "blocked",
        "事项、代码版本或已确认计划已变化，请重新分析",
      );
      return;
    }
    if (
      !job.result ||
      ["failed", "cancelled", "rejected"].includes(job.status)
    ) {
      this.stop(
        issue,
        job.status === "cancelled" ? "cancelled" : "blocked",
        job.error ?? "执行未完成，请查看原始记录后选择恢复",
      );
      return;
    }
    run = {
      ...run,
      completedJobIds: [...run.completedJobIds, job.id],
      currentJobId: job.id,
    };
    const updated = {
      ...issue,
      orchestration: { ...issue.orchestration, run },
    };
    this.put(updated, updated.orchestration);
    this.advance(updated, job);
  }
  private advance(updated: Issue, job: Job) {
    const run = updated.orchestration!.run!;
    if (job.kind === "docs" || job.kind === "fix") {
      if (!job.patch) {
        this.stop(updated, "blocked", "没有可验证补丁，请检查执行结果");
        return;
      }
      this.schedule(updated, "validate", job.id);
    } else if (job.kind === "validate") {
      const validation = validationState(job.artifact);
      if (validation?.state === "passed")
        this.schedule(updated, "review", job.id);
      else
        this.stop(
          updated,
          "blocked",
          `${validation?.reason ?? "缺少验证产物"}。${run.plan.category === "docs" ? "文档错误选择文档修订；环境问题先解除阻塞；缺证据补验证。" : "代码问题选择修订；环境或证据问题选择对应恢复。"}`,
        );
    } else if (job.kind === "preflight") {
      if (
        job.artifact?.stage === "preflight" &&
        job.artifact.readiness === "review"
      )
        this.schedule(updated, "review");
      else
        this.stop(
          updated,
          "blocked",
          "PR 预检尚未准备好，请处理缺口或草稿状态",
        );
    } else if (job.kind === "investigate") {
      const draft = draftFromJob(
        updated,
        this.wb.store.get<import("../core/types.ts").Repo>(
          "repos",
          updated.repoId,
        )!,
        job,
      );
      this.put(updated, {
        draft,
        run: {
          ...run,
          status: "paused",
          reason: "调查完成，请核对更新后的计划再确认实施",
        },
      });
    } else
      this.stop(
        updated,
        "review",
        job.kind === "review"
          ? "自动执行已结束，请最终审核；审查发现由维护者决定处置"
          : "请核对产物并选择下一步",
      );
  }
  replacement(jobId: string, result: { created: string[]; reused: string[] }) {
    const job = this.wb.store.get<Job>("jobs", jobId);
    if (!job?.workflowRunId) return;
    const issue = this.issue(job.issueId),
      run = issue.orchestration?.run;
    if (
      !run ||
      run.id !== job.workflowRunId ||
      run.currentJobId !== jobId ||
      (run.caseId && run.caseId !== issue.processing?.id)
    )
      return;
    const nextId = result.created[0] ?? result.reused[0];
    if (nextId)
      this.put(issue, {
        ...issue.orchestration,
        run: {
          ...run,
          status: "running",
          currentJobId: nextId,
          reason: "已明确恢复当前步骤，保留原始记录",
        },
      });
  }
  pause(id: string, cancel = false) {
    const issue = this.issue(id),
      run = issue.orchestration?.run;
    if (!run) throw new Error("没有进行中的计划");
    this.stop(
      issue,
      cancel ? "cancelled" : "paused",
      cancel
        ? "已取消后续自动推进，已有产物保留"
        : "已暂停后续推进，当前任务可完成并保留产物",
    );
    const job = run.currentJobId
      ? this.wb.store.get<Job>("jobs", run.currentJobId)
      : undefined;
    if (cancel && job && ["queued", "running"].includes(job.status))
      this.wb.cancel(job.id);
  }
  retry(id: string) {
    const issue = this.issue(id),
      run = issue.orchestration?.run;
    if (!run?.currentJobId || !["blocked", "cancelled"].includes(run.status))
      throw new Error("当前计划没有可明确重试的步骤");
    const repo = this.wb.store.get<import("../core/types.ts").Repo>(
      "repos",
      issue.repoId,
    )!;
    if (
      run.inputKey !== planInputKey(issue, repo) ||
      JSON.stringify(run.plan) !== JSON.stringify(issue.plan)
    )
      throw new Error("版本或计划已变化，请重新分析");
    if (
      this.wb.store.jobs().filter((j) => j.workflowRunId === run.id).length >=
      run.maxSteps
    )
      throw new Error("本次计划步骤预算已到上限，请重新确认计划");
    if (Date.now() > Date.parse(run.deadlineAt))
      throw new Error("本次执行预算已到期，请重新确认计划");
    const result = this.wb.retry(run.currentJobId);
    const current = this.issue(id);
    this.put(current, {
      ...current.orchestration,
      run: {
        ...run,
        status: "running",
        currentJobId: result.created[0] ?? result.reused[0],
        reason: "维护者检查现场后明确重试，保留原失败记录",
      },
    });
    return result;
  }
  resume(id: string) {
    const issue = this.issue(id),
      run = issue.orchestration?.run;
    if (!run || !["paused", "blocked"].includes(run.status))
      throw new Error("当前计划不能恢复");
    const repo = this.wb.store.get<import("../core/types.ts").Repo>(
      "repos",
      issue.repoId,
    )!;
    if (
      run.inputKey !== planInputKey(issue, repo) ||
      JSON.stringify(run.plan) !== JSON.stringify(issue.plan)
    )
      throw new Error("输入或计划已变更，请重新分析");
    const job = run.currentJobId
      ? this.wb.store.get<Job>("jobs", run.currentJobId)
      : undefined;
    if (job && ["failed", "cancelled", "rejected"].includes(job.status))
      throw new Error("原执行状态不明或失败，请检查工作区后从高级操作明确重试");
    const updated = {
      ...issue,
      orchestration: {
        ...issue.orchestration,
        run: { ...run, status: "running" as const },
      },
    };
    this.put(updated, updated.orchestration);
    if (job && !run.completedJobIds.includes(job.id)) this.completed(job);
    else if (
      job?.kind === "validate" &&
      validationState(job.artifact)?.state !== "passed"
    )
      return this.schedule(
        updated,
        "validate",
        job.sourceJobId,
        "维护者解除阻塞后重新执行验证，旧失败报告保留。",
        true,
      );
    else if (job?.kind === "docs" || job?.kind === "fix")
      return this.schedule(updated, "validate", job.id);
    else if (job?.kind === "validate")
      return this.schedule(updated, "review", job.id);
    else if (!job && run.checkpoint)
      return this.schedule(
        updated,
        run.checkpoint.kind,
        run.checkpoint.sourceJobId,
      );
    return { created: [], reused: [] };
  }
  startBatch(
    items: {
      issueId: string;
      inputKey: string;
      plan?: unknown;
      expectedVersion?: number;
    }[],
  ) {
    if (
      !items.length ||
      items.length > this.wb.store.settings().maxJobsPerBatch
    )
      throw new Error("事项数量超出批量上限");
    return {
      results: items.map((item) => {
        try {
          return {
            id: item.issueId,
            ...this.start(
              item.issueId,
              item.inputKey,
              item.plan,
              undefined,
              undefined,
              "",
              item.expectedVersion,
            ),
          };
        } catch (e) {
          return {
            id: item.issueId,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    };
  }
  reviewDecision(job: Job, decision: "approve" | "reject") {
    const issue = this.wb.store.get<Issue>("issues", job.issueId);
    if (
      !issue?.orchestration?.run ||
      issue.orchestration.run.id !== job.workflowRunId
    )
      return;
    if (decision === "reject")
      this.stop(
        issue,
        "paused",
        `维护者退回：${job.reviewNote || "请明确修订意见后继续"}`,
      );
  }
  waitAuthor(jobId: string) {
    const job = this.wb.store.get<Job>("jobs", jobId);
    if (
      !job ||
      job.kind !== "review" ||
      job.issueSnapshot.type !== "pr" ||
      job.publications?.review?.status !== "published"
    )
      throw new Error("请先通过发布预览确认审查意见已发布");
    const issue = this.issue(job.issueId),
      run = issue.orchestration?.run;
    if (
      !run ||
      run.id !== job.workflowRunId ||
      (run.caseId && run.caseId !== issue.processing?.id)
    )
      throw new Error("请先使用当前处理计划审查本事项");
    this.put(issue, {
      ...issue.orchestration,
      run: {
        ...run,
        status: "waiting_author",
        waitingHead: job.prContext?.headSha,
        reason: "审查意见已发布，等待作者新提交后自动复核",
      },
    });
  }
  synced(repoId: string) {
    for (const issue of this.wb.store
      .issues()
      .filter((i) => i.repoId === repoId)) {
      const run = issue.orchestration?.run;
      if (run?.caseId && run.caseId !== issue.processing?.id) {
        this.stop(
          issue,
          "blocked",
          "处理周期已变化，请重新分析并确认，旧授权保留为历史",
        );
        continue;
      }
      if (!run) {
        if (
          issue.orchestration?.draft &&
          issue.state === "open" &&
          issue.informationRequests?.some((r) => r.state === "reply_received")
        )
          this.analyze([issue.id]);
        continue;
      }
      if (issue.state !== "open") {
        this.stop(issue, "paused", "远端事项已关闭，停止后续自动推进");
        continue;
      }
      if (
        run.status === "waiting_author" &&
        issue.headSha &&
        issue.headSha !== run.waitingHead
      ) {
        // Re-review is within the prior read-only delegation. Old write authorization is not reused.
        const repo = this.wb.store.get<import("../core/types.ts").Repo>(
          "repos",
          issue.repoId,
        )!;
        const updated = {
          ...issue,
          orchestration: {
            ...issue.orchestration,
            draft: undefined,
            run: {
              ...run,
              id: randomUUID(),
              inputKey: planInputKey(issue, repo),
              completedJobIds: [],
              currentJobId: undefined,
              status: "running" as const,
              startedAt: new Date().toISOString(),
              deadlineAt: new Date(
                Date.now() + this.wb.store.settings().timeoutMs * 3,
              ).toISOString(),
              reason: "作者已有新提交，系统重新预检并复核历史发现",
            },
          },
        };
        this.put(updated, updated.orchestration);
        this.schedule(updated, "preflight");
      } else if (run.status === "running") {
        const repo = this.wb.store.get<import("../core/types.ts").Repo>(
          "repos",
          issue.repoId,
        )!;
        if (run.inputKey !== planInputKey(issue, repo))
          this.stop(issue, "blocked", "输入版本变化，旧产物保留，请重新分析");
      }
    }
  }
  view(issue: Issue): WorkflowProgress {
    const repo = this.wb.store.get<import("../core/types.ts").Repo>(
      "repos",
      issue.repoId,
    )!;
    const state = issue.orchestration;
    if (issue.state !== "open" || issue.processing?.lifecycle === "deferred")
      return { status: "deferred", reason: "事项已关闭或暂缓，保留历史结果" };
    if (
      issue.informationRequests?.some((r) => r.state === "asked") ||
      state?.run?.status === "waiting_author"
    )
      return {
        status: "waiting",
        reason: state?.run?.reason ?? "等待外部补充信息",
      };
    const wait = issue.processing?.waits.find(
      (w) =>
        w.state === "open" &&
        ["user_input", "environment_ready"].includes(w.type),
    );
    if (wait) return { status: "blocked", reason: wait.reason };
    if (state?.draft && state.draft.inputKey !== planInputKey(issue, repo))
      return {
        status: "stale",
        reason: "计划来源已变化，请重新分析，旧结果保留供追溯",
      };
    if (issue.informationRequests?.some((r) => r.state === "reply_received"))
      return {
        status: "blocked",
        reason: "补充回复已收到，请核对真正缺失的信息后继续",
      };
    const run = state?.run;
    if (run && JSON.stringify(run.plan) !== JSON.stringify(issue.plan))
      return {
        status: "stale",
        reason: "已确认计划被修改，旧授权不可继续，请重新确认",
      };
    if (run)
      return {
        status:
          run.status === "running"
            ? "running"
            : run.status === "review"
              ? "review"
              : "blocked",
        reason: run.reason,
      };
    if (
      this.wb.store
        .jobs()
        .some(
          (j) =>
            j.issueId === issue.id && ["running", "queued"].includes(j.status),
        )
    )
      return { status: "running", reason: "系统正在整理材料或执行任务" };
    const latest = this.wb.store
      .jobs()
      .filter((j) => j.issueId === issue.id)
      .at(-1);
    if (
      latest?.status === "failed" ||
      (latest?.kind === "validate" &&
        validationState(latest.artifact)?.state !== "passed")
    )
      return {
        status: "blocked",
        reason:
          latest.error ??
          validationState(latest.artifact)?.reason ??
          "执行失败，请处理阻塞",
      };
    if (latest?.status === "awaiting_review")
      return { status: "review", reason: "当前成果等待维护者审核" };
    return {
      status: "plan",
      reason: state?.draft
        ? "已整理计划草稿，请确认或修订"
        : "请开始整理现有材料与处理建议",
    };
  }
  reconcile(): void {
    for (const issue of this.wb.store.issues()) {
      const run = issue.orchestration?.run;
      if (!run || run.status !== "running") continue;
      const job = run.currentJobId
        ? this.wb.store.get<Job>("jobs", run.currentJobId)
        : undefined;
      if (job && run.completedJobIds.includes(job.id)) this.advance(issue, job);
      else if (job) this.completed(job);
      else if (run.checkpoint)
        this.schedule(issue, run.checkpoint.kind, run.checkpoint.sourceJobId);
    }
  }
}
import { revision as importRevision } from "../core/revision.ts";
