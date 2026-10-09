import type { WorkflowState } from "../../domain/plan-workflow.ts";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { revision } from "../../core/revision.ts";
import type { Issue, Job, Repo } from "../../core/types.ts";
import {
  type ProcessingCase,
  type ProcessingEvent,
  type ProcessingEventPayload,
} from "../../domain/processing.ts";
import {
  currentWorkflowVersion,
  workflowDefinition,
} from "../../workflow/definitions.ts";
import {
  actionsIdentity,
  actionsObservation,
  prObservation,
  remoteIdentity,
} from "../../workflow/remote-state.ts";
import { runState } from "../../workflow/run-state.ts";
import { initialProcessing } from "./legacy-issue.ts";
import { upgradeWorkflow } from "./workflow-upgrade.ts";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sourceFingerprint = (issue: Issue) =>
  hash([
    issue.title,
    issue.body,
    issue.state,
    issue.comments,
    issue.updatedAt,
    issue.headSha,
    issue.prBaseSha,
    issue.merged,
  ]);

/** SQLite event/state repository. Called inside the same transaction as compatible issue/job writes. */
export class ProcessingRepository {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processing_cases(id TEXT PRIMARY KEY, workItemId TEXT NOT NULL, cycle INTEGER NOT NULL, current INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS current_processing_case ON processing_cases(workItemId) WHERE current=1;
      CREATE TABLE IF NOT EXISTS processing_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, caseId TEXT NOT NULL, deduplicationKey TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_case ON processing_events(caseId,seq);
      CREATE TABLE IF NOT EXISTS processing_inputs(id TEXT PRIMARY KEY, caseId TEXT NOT NULL, waitId TEXT NOT NULL, data TEXT NOT NULL);
      INSERT OR IGNORE INTO schema_migrations VALUES(1,datetime('now'));`);
    upgradeWorkflow(db);
  }
  current(workItemId: string): ProcessingCase | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM processing_cases WHERE workItemId=? AND current=1",
      )
      .get(workItemId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  cases(workItemId: string): ProcessingCase[] {
    return this.db
      .prepare(
        "SELECT data FROM processing_cases WHERE workItemId=? ORDER BY cycle",
      )
      .all(workItemId)
      .map((row) => JSON.parse(String(row.data)));
  }
  events(caseId: string): ProcessingEvent[] {
    return this.db
      .prepare("SELECT data FROM processing_events WHERE caseId=? ORDER BY seq")
      .all(caseId)
      .map((row) => JSON.parse(String(row.data)));
  }
  inputs(caseId: string): {
    id: string;
    waitId: string;
    values: Record<string, string>;
    at: string;
  }[] {
    return this.db
      .prepare(
        "SELECT data FROM processing_inputs WHERE caseId=? ORDER BY rowid",
      )
      .all(caseId)
      .map((row) => JSON.parse(String(row.data)));
  }
  private create(
    issue: Issue,
    cycle: number,
    reopened = false,
  ): ProcessingCase {
    const now = new Date().toISOString();
    const initial = reopened
      ? {
          phase: "discovered" as const,
          reason: "事项已重新打开，需确认新的处理目标",
        }
      : initialProcessing(issue);
    const initialPhase = initial.phase;
    const state: ProcessingCase = {
      id: randomUUID(),
      workItemId: issue.id,
      repositoryId: issue.repoId,
      cycle,
      workflowDefinitionVersion: currentWorkflowVersion,
      lifecycle:
        initialPhase === "deferred"
          ? "deferred"
          : initialPhase === "answered"
            ? "completed"
            : "active",
      phase: initialPhase,
      reason: initial.reason,
      waits: [],
      activeRunIds: [],
      sourceFingerprint: sourceFingerprint(issue),
      planFingerprint: issue.plan ? hash(issue.plan) : undefined,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare("UPDATE processing_cases SET current=0 WHERE workItemId=?")
      .run(issue.id);
    this.db
      .prepare("INSERT INTO processing_cases VALUES(?,?,?,1,?)")
      .run(state.id, issue.id, cycle, JSON.stringify(state));
    return state;
  }
  dispatch(
    workItemId: string,
    payload: ProcessingEventPayload,
    source: ProcessingEvent["source"],
    key: string,
    expectedVersion?: number,
  ): ProcessingCase {
    this.db.exec("SAVEPOINT processing_event");
    try {
      const result = this.apply(
        workItemId,
        payload,
        source,
        key,
        expectedVersion,
      );
      this.db.exec("RELEASE SAVEPOINT processing_event");
      return result;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO SAVEPOINT processing_event; RELEASE SAVEPOINT processing_event",
      );
      throw error;
    }
  }
  private apply(
    workItemId: string,
    payload: ProcessingEventPayload,
    source: ProcessingEvent["source"],
    key: string,
    expectedVersion?: number,
  ): ProcessingCase {
    const state = this.current(workItemId);
    if (!state) throw new Error("事项处理状态不存在");
    const deduplicationKey = `${state.id}:${key}`;
    if (
      this.db
        .prepare("SELECT id FROM processing_events WHERE deduplicationKey=?")
        .get(deduplicationKey)
    )
      return state;
    if (expectedVersion !== undefined && state.version !== expectedVersion)
      throw new ProcessingConflictError();
    const now = new Date().toISOString();
    const event: ProcessingEvent = {
      id: randomUUID(),
      caseId: state.id,
      workItemId,
      source,
      deduplicationKey,
      occurredAt: now,
      receivedAt: now,
      payload,
    };
    const next = workflowDefinition(state.workflowDefinitionVersion).transition(
      state,
      event,
    );
    this.db
      .prepare(
        "INSERT INTO processing_events(id,caseId,deduplicationKey,data) VALUES(?,?,?,?)",
      )
      .run(event.id, state.id, deduplicationKey, JSON.stringify(event));
    this.db
      .prepare("UPDATE processing_cases SET data=? WHERE id=?")
      .run(JSON.stringify(next), state.id);
    return next;
  }
  recordPlanning(
    workItemId: string,
    planning: WorkflowState,
    expectedVersion?: number,
  ): ProcessingCase {
    const state = this.current(workItemId);
    if (!state) throw new Error("事项处理状态不存在");
    if (expectedVersion !== undefined && state.version !== expectedVersion)
      throw new ProcessingConflictError();
    if (hash(state.planning ?? null) === hash(planning)) return state;
    return this.dispatch(
      workItemId,
      { type: "planning.recorded", planning },
      "system",
      `planning:${state.version}:${hash(planning)}`,
      expectedVersion,
    );
  }
  /** Import legacy records once, including authorization attached to a historical cycle. */
  migratePlanning(issue: Issue): void {
    const planning = issue.orchestration;
    if (!planning) return;
    const state = planning.run?.caseId
      ? this.cases(issue.id).find((c) => c.id === planning.run!.caseId)
      : this.current(issue.id);
    if (!state || state.planning) return;
    // A legacy run without a cycle cannot acquire execution permission during migration.
    const imported =
      planning.run && !planning.run.caseId
        ? {
            ...planning,
            run: {
              ...planning.run,
              caseId: state.id,
              status: "blocked" as const,
              reason: "旧计划缺少处理周期绑定，请核对后重新确认",
            },
          }
        : planning;
    const now = new Date().toISOString();
    const event: ProcessingEvent = {
      id: randomUUID(),
      caseId: state.id,
      workItemId: issue.id,
      source: "system",
      deduplicationKey: `${state.id}:planning:migration`,
      occurredAt: now,
      receivedAt: now,
      payload: { type: "planning.recorded", planning: imported },
    };
    const next = workflowDefinition(state.workflowDefinitionVersion).transition(
      state,
      event,
    );
    this.db
      .prepare(
        "INSERT INTO processing_events(id,caseId,deduplicationKey,data) VALUES(?,?,?,?)",
      )
      .run(event.id, state.id, event.deduplicationKey, JSON.stringify(event));
    this.db
      .prepare("UPDATE processing_cases SET data=? WHERE id=?")
      .run(JSON.stringify(next), state.id);
  }
  observeIssue(previous: Issue | undefined, issue: Issue): ProcessingCase {
    let state = this.current(issue.id);
    const reopened = previous?.state === "closed" && issue.state === "open";
    if (!state || reopened)
      state = this.create(issue, state ? state.cycle + 1 : 1, reopened);
    const fingerprint = sourceFingerprint(issue);
    if (!previous || fingerprint !== state.sourceFingerprint || reopened) {
      state = this.dispatch(
        issue.id,
        {
          type: "source.observed",
          fingerprint,
          state: issue.state,
          itemType: issue.type,
          merged: issue.merged,
          headSha: issue.headSha,
        },
        "github",
        `source:${state.version}:${fingerprint}`,
      );
    }
    if (
      JSON.stringify(previous?.plan) !== JSON.stringify(issue.plan) &&
      issue.plan
    ) {
      state = this.dispatch(
        issue.id,
        {
          type: "decision.recorded",
          phase:
            issue.plan.decision === "accepted"
              ? "accepted"
              : issue.plan.decision === "deferred"
                ? "deferred"
                : "decision",
          reason: issue.plan.goal || "等待明确目标与验收条件",
          planFingerprint: hash(issue.plan),
        },
        "user",
        `plan:${state.version}:${hash(issue.plan)}`,
      );
    }
    const requests = (issue.informationRequests ?? []).map((r) => ({
      id: r.id,
      state: r.state,
      waitingFor: r.waitingFor,
      askedAt: r.askedAt,
    }));
    const oldRequests = (previous?.informationRequests ?? []).map((r) => ({
      id: r.id,
      state: r.state,
      waitingFor: r.waitingFor,
      askedAt: r.askedAt,
    }));
    if (
      requests.length &&
      (!previous || JSON.stringify(requests) !== JSON.stringify(oldRequests))
    )
      state = this.dispatch(
        issue.id,
        { type: "information.observed", requests },
        "github",
        `information:${state.version}:${hash(requests)}`,
      );
    if (
      issue.actions &&
      JSON.stringify(
        previous?.actions ? actionsIdentity(previous.actions) : undefined,
      ) !== JSON.stringify(actionsIdentity(issue.actions))
    ) {
      const observation = {
          ...actionsObservation(issue.actions),
          url:
            issue.type === "pr"
              ? issue.url
              : issue.linkedPullRequests?.find((url) =>
                  url
                    .replace(/\/$/, "")
                    .endsWith(`/pull/${issue.actions!.prNumber}`),
                ),
        },
        identity = hash(actionsIdentity(issue.actions));
      state = this.dispatch(
        issue.id,
        {
          type: "remote.activity",
          kind: "ci",
          fingerprint: identity,
          observation,
        },
        "github",
        `ci:${state.version}:${identity}`,
      );
    }
    for (const remote of issue.remotePRs ?? []) {
      const old = previous?.remotePRs?.find((pr) => pr.url === remote.url);
      if (
        JSON.stringify(old ? remoteIdentity(old) : undefined) ===
        JSON.stringify(remoteIdentity(remote))
      )
        continue;
      const identity = hash(remoteIdentity(remote));
      state = this.dispatch(
        issue.id,
        {
          type: "remote.activity",
          kind: "reviews",
          fingerprint: identity,
          observation: prObservation(remote),
        },
        "github",
        `remote:${state.version}:${identity}`,
      );
    }
    return state;
  }
  observeJob(
    previous: Job | undefined,
    job: Job,
    issue: Issue,
    repo: Repo,
  ): void {
    const state = this.current(issue.id);
    if (!state || (job.caseId && job.caseId !== state.id)) return;
    const facts = (j: Job) => [
      j.status,
      j.waitingReason,
      j.goalPauseReason,
      j.reviewNote,
      j.findingDecisions,
      j.artifact,
      j.result,
      j.error,
    ];
    if (!previous || hash(facts(previous)) !== hash(facts(job))) {
      this.dispatch(
        issue.id,
        {
          type: "run.observed",
          runId: job.id,
          kind: job.kind,
          status: job.status,
          current:
            job.revision === revision(issue, repo, job.kind) &&
            sourceFingerprint(job.issueSnapshot) === state.sourceFingerprint,
          waitingReason: job.waitingReason,
          pauseReason: job.goalPauseReason,
          ...runState(job),
        },
        previous &&
          (["approved", "rejected"].includes(job.status) ||
            JSON.stringify(previous.findingDecisions) !==
              JSON.stringify(job.findingDecisions))
          ? "user"
          : "agent",
        `run:${job.id}:${state.version}:${hash(facts(job))}`,
      );
    }
    if (
      job.reviewThreads &&
      hash({ ...previous?.reviewThreads, syncedAt: undefined }) !==
        hash({ ...job.reviewThreads, syncedAt: undefined })
    ) {
      const threads = job.reviewThreads;
      this.dispatch(
        issue.id,
        {
          type: "remote.activity",
          kind: "threads",
          fingerprint: hash({ ...threads, syncedAt: undefined }),
          observation: {
            url: issue.url,
            headSha: threads.headSha,
            baseSha: threads.baseSha,
            complete: !threads.partial,
            unresolvedThreads: threads.threads.filter(
              (t) => !t.isResolved && !t.isOutdated,
            ).length,
          },
        },
        "github",
        `threads:${job.id}:${this.current(issue.id)!.version}`,
      );
    }
    for (const [action, receipt] of Object.entries(job.publications ?? {})) {
      if (
        receipt?.status === "published" &&
        previous?.publications?.[
          action as keyof NonNullable<Job["publications"]>
        ]?.status !== "published"
      )
        this.dispatch(
          issue.id,
          {
            type: "publication.confirmed",
            action,
            runId: job.id,
            targetUrl:
              action === "review" || action === "update_pr"
                ? job.issueSnapshot.url
                : receipt.urls?.[0],
            headSha:
              action === "review"
                ? job.prContext?.headSha
                : job.publishedCommit,
            baseSha: job.prContext?.baseSha,
            answerPublished:
              action === "comment" &&
              (issue.plan?.category ??
                issue.analysis?.category ??
                job.result?.category) === "question",
          },
          "system",
          `publication:${job.id}:${action}`,
        );
    }
  }
  migrate(issues: Issue[]): void {
    for (const issue of issues)
      if (!this.current(issue.id)) this.observeIssue(undefined, issue);
  }
}

export class ProcessingConflictError extends Error {
  readonly code = "VERSION_CONFLICT";
  constructor() {
    super("事项状态已变化，请刷新后再操作");
  }
}
