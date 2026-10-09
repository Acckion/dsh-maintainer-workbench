import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { artifactSchemas, asAnalysis } from "../src/core/artifacts.ts";
import { availableActions } from "../src/workflow/actions.ts";
import { ProcessingService } from "../src/application/processing.ts";
import { Store } from "../src/core/store.ts";
import type { Issue, Job } from "../src/core/types.ts";
import { Workbench, revision } from "../src/core/workbench.ts";
import type {
  ProcessingEventPayload,
  RemoteObservation,
} from "../src/domain/processing.ts";
import { seedFixture, fixtureAnalysis } from "./support/fixtures.ts";

function fixture() {
  const store = new Store(":memory:");
  seedFixture(store);
  const issue = store.issues()[0];
  let sequence = 0;
  const dispatch = (payload: ProcessingEventPayload) =>
    store.processing.dispatch(
      issue.id,
      payload,
      "system",
      `test:${++sequence}`,
    );
  const remote = (fields: Partial<RemoteObservation> = {}) =>
    dispatch({
      type: "remote.activity",
      kind: "ci",
      fingerprint: `status:${sequence}`,
      observation: {
        url: "https://github.com/fixture/queue/pull/200",
        headSha: "head",
        baseSha: "base",
        complete: true,
        ci: "passed",
        ...fields,
      },
    });
  const publish = (action = "pr") =>
    dispatch({
      type: "publication.confirmed",
      action,
      runId: "delivery",
      targetUrl: "https://github.com/fixture/queue/pull/200",
      headSha: "head",
      baseSha: "base",
    });
  return { store, issue, dispatch, remote, publish };
}

test("CI waits require complete evidence for the exact PR head and base", () => {
  const f = fixture();
  try {
    f.publish();
    for (const change of [
      { headSha: "other" },
      { baseSha: "other" },
      { complete: false },
      { url: "https://github.com/fixture/queue/pull/201" },
      { ci: "pending" as const },
    ]) {
      f.remote(change);
      assert.equal(
        f.store.processing.current(f.issue.id)!.waits[0].state,
        "open",
      );
    }
    f.remote({ ci: "failed" });
    assert.equal(f.store.processing.current(f.issue.id)!.phase, "blocked");
    assert.equal(
      f.store.processing.current(f.issue.id)!.waits[0].state,
      "satisfied",
    );
  } finally {
    f.store.close();
  }
});

test("late remote evidence records wait completion without advancing an active newer run", () => {
  const f = fixture();
  try {
    f.publish();
    f.dispatch({
      type: "run.observed",
      runId: "new-run",
      kind: "investigate",
      status: "queued",
      current: true,
      phase: "investigate",
      reason: "new evidence",
    });
    f.remote({ ci: "failed" });
    const state = f.store.processing.current(f.issue.id)!;
    assert.equal(state.phase, "investigate");
    assert.equal(state.lifecycle, "active");
    assert.equal(state.waits[0].state, "satisfied");
  } finally {
    f.store.close();
  }
});

test("CI rerun changes are observed again after failure, while polling timestamps add no events", () => {
  const f = fixture();
  try {
    const repo = f.store.repos()[0];
    const job: Job = {
      id: "delivery",
      caseId: f.issue.processing!.id,
      repoId: repo.id,
      issueId: f.issue.id,
      issueSnapshot: f.issue,
      revision: revision(f.issue, repo, "fix"),
      baseSha: repo.headSha,
      kind: "fix",
      status: "approved",
      createdAt: "now",
      updatedAt: "now",
      attempt: 1,
    };
    f.store.put("jobs", job);
    f.publish();
    const set = (conclusion: string, time: string) =>
      f.store.put("issues", {
        ...f.store.get<Issue>("issues", f.issue.id)!,
        linkedPullRequests: ["https://github.com/fixture/queue/pull/200"],
        actions: {
          prNumber: 200,
          headSha: "head",
          baseSha: "base",
          syncedAt: time,
          warnings: [],
          jobs: [
            {
              id: 1,
              runId: 1,
              attempt: 1,
              headSha: "head",
              name: "CI",
              url: "https://github.com/fixture/queue/actions/runs/1",
              status: "completed",
              conclusion,
              steps: [],
            },
          ],
        },
      });
    set("failure", "one");
    assert.equal(f.store.processing.current(f.issue.id)!.phase, "blocked");
    const count = f.store.processing.events(f.issue.processing!.id).length;
    set("failure", "two");
    assert.equal(
      f.store.processing.events(f.issue.processing!.id).length,
      count,
    );
    set("success", "three");
    assert.equal(f.store.processing.current(f.issue.id)!.phase, "track");
    set("failure", "four");
    assert.equal(f.store.processing.current(f.issue.id)!.phase, "blocked");
  } finally {
    f.store.close();
  }
});

test("author revisions bind to target PR; merged linked PRs do not close an open Issue", () => {
  const f = fixture();
  try {
    f.publish("review");
    f.remote({ headSha: "new", complete: false });
    assert.equal(
      f.store.processing.current(f.issue.id)!.waits[0].state,
      "open",
    );
    f.remote({ headSha: "head" });
    assert.equal(
      f.store.processing.current(f.issue.id)!.waits[0].state,
      "open",
    );
    f.remote({ headSha: "new" });
    assert.equal(
      f.store.processing.current(f.issue.id)!.waits[0].state,
      "satisfied",
    );
    assert.equal(f.store.processing.current(f.issue.id)!.phase, "decision");
    f.publish();
    f.remote({ state: "merged" });
    assert.equal(f.store.processing.current(f.issue.id)!.lifecycle, "waiting");
    assert.equal(f.store.get<Issue>("issues", f.issue.id)!.state, "open");
  } finally {
    f.store.close();
  }
});

test("cancelling a paused run closes its input and environment waits", async (t) => {
  const f = fixture();
  const w = new Workbench(
    f.store,
    "/tmp/mw-cancel-wait",
    undefined,
    undefined,
    false,
  );
  t.after(() => w.close());
  const id = w.enqueue([f.issue.id], "triage").created[0],
    job = f.store.get<Job>("jobs", id)!;
  f.store.put("jobs", {
    ...job,
    status: "waiting_input",
    result: fixtureAnalysis(f.issue, "triage"),
  });
  w.processing.requestInput(
    f.issue.id,
    { reason: "Need scope", fields: [{ id: "scope", question: "Scope?" }] },
    id,
  );
  f.dispatch({ type: "environment.observed", ready: false, reason: "offline" });
  w.cancel(id);
  assert.ok(
    f.store.processing
      .current(f.issue.id)!
      .waits.every((wait) => wait.state !== "open"),
  );
  assert.equal(w.enqueue([f.issue.id], "triage").created.length, 1);
});

test("explicitly ending a reporter wait reconciles the underlying information request", async (t) => {
  const f = fixture(),
    w = new Workbench(f.store, "/tmp/mw-end-wait", undefined, undefined, false);
  t.after(() => w.close());
  const request = w.askInformation(
    f.issue.id,
    ["Which version?"],
    f.issue.author,
  );
  const state = f.store.processing.current(f.issue.id)!,
    wait = state.waits.find((w) => w.type === "reporter_reply")!;
  assert.throws(
    () => w.processing.cancelWait(f.issue.id, wait.id, "", state.version),
    /原因/,
  );
  w.processing.cancelWait(
    f.issue.id,
    wait.id,
    "No longer relevant",
    state.version,
  );
  assert.equal(
    f.store
      .get<Issue>("issues", f.issue.id)!
      .informationRequests!.find((r) => r.id === request.id)!.state,
    "dismissed",
  );
  assert.equal(
    f.store.processing.current(f.issue.id)!.waits.find((w) => w.id === wait.id)!
      .state,
    "cancelled",
  );
});

test("historical processing cycles remain queryable and reject a foreign case ID", () => {
  const f = fixture();
  try {
    const old = f.issue.processing!.id;
    f.store.put("issues", { ...f.issue, state: "closed" });
    f.store.put("issues", { ...f.issue, state: "open" });
    const service = new ProcessingService(f.store),
      history = service.history(f.issue.id, old);
    assert.equal(history.selected.id, old);
    assert.notEqual(history.state.id, old);
    assert.equal(history.cases.length, 2);
    assert.throws(
      () => service.history(f.issue.id, f.store.issues()[1].processing!.id),
      /不属于/,
    );
  } finally {
    f.store.close();
  }
});

test("workflow v1 upgrades once and preserves pending input and recorded answers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mw-upgrade-")),
    path = join(dir, "state.sqlite");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new Store(path);
  seedFixture(first);
  const issue = first.issues()[0],
    service = new ProcessingService(first);
  const wait = service.requestInput(issue.id, {
    reason: "Scope",
    fields: [{ id: "scope", question: "Which scope?" }],
  });
  service.submitInput(
    issue.id,
    wait.id,
    { scope: "queue" },
    first.processing.current(issue.id)!.version,
  );
  service.requestInput(issue.id, {
    reason: "Compatibility",
    fields: [{ id: "version", question: "Which version?" }],
  });
  const before = first.processing.current(issue.id)!;
  first.db
    .prepare("UPDATE processing_cases SET data=? WHERE id=?")
    .run(
      JSON.stringify({ ...before, workflowDefinitionVersion: "maintainer/1" }),
      before.id,
    );
  first.close();
  const restored = new Store(path),
    after = restored.processing.current(issue.id)!;
  assert.equal(after.id, before.id);
  assert.equal(after.version, before.version + 1);
  assert.equal(after.workflowDefinitionVersion, "maintainer/2");
  assert.deepEqual(after.waits, before.waits);
  assert.equal(restored.processing.inputs(after.id)[0].values.scope, "queue");
  const count = restored.processing.events(after.id).length;
  restored.close();
  const twice = new Store(path);
  t.after(() => twice.close());
  assert.equal(twice.processing.events(after.id).length, count);
  assert.equal(twice.jobs().length, 0);
});

test("a confirmed answer ends local processing without closing GitHub; ordinary comments do not", () => {
  const f = fixture();
  try {
    f.dispatch({
      type: "publication.confirmed",
      action: "comment",
      runId: "comment",
    });
    assert.notEqual(
      f.store.processing.current(f.issue.id)!.lifecycle,
      "completed",
    );
    f.dispatch({
      type: "publication.confirmed",
      action: "comment",
      runId: "answer",
      answerPublished: true,
    });
    assert.equal(f.store.processing.current(f.issue.id)!.phase, "answered");
    assert.equal(f.store.get<Issue>("issues", f.issue.id)!.state, "open");
  } finally {
    f.store.close();
  }
});

test("repository preparation failures pause without automatic retries and resume explicitly", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mw-environment-")),
    store = new Store(":memory:");
  seedFixture(store);
  let calls = 0;
  const w = new Workbench(
    store,
    dir,
    async ({ issue, job }) => {
      calls++;
      return { result: fixtureAnalysis(issue, job.kind), engine: "fixture" };
    },
    undefined,
    false,
  );
  t.after(async () => {
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  w.prepareRepository = async () => {
    throw Error("offline fixture");
  };
  const id = w.enqueue([store.issues()[0].id], "investigate").created[0];
  w.pump();
  await w.drain();
  assert.equal(store.get<Job>("jobs", id)!.status, "waiting_environment");
  assert.equal(w.snapshot().capabilities.running, 0);
  assert.equal(calls, 0);
  w.pump();
  await w.drain();
  assert.equal(store.jobs().length, 1);
  assert.throws(() => w.resume(id), /环境/);
  w.prepareRepository = async (repoId) => {
    w.processing.environmentReady(repoId);
  };
  await w.prepareRepository(store.repos()[0].id);
  assert.equal(calls, 0);
  const next = w.resume(id).created[0];
  w.pump();
  await w.drain();
  assert.equal(calls, 1);
  assert.equal(store.get<Job>("jobs", next)!.status, "completed");
});

test("published clarification receipts reconcile a durable reporter wait exactly once after restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mw-published-questions-")),
    path = join(dir, "state.sqlite");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new Store(path);
  seedFixture(first);
  const issue = first.issues()[0],
    repo = first.repos()[0];
  const artifact = {
    schemaVersion: 1 as const,
    stage: "triage" as const,
    summary: "Need clarification",
    coverage: "metadata",
    evidence: [],
    nextSteps: [],
    responseDraft: "Which version?",
    category: "bug" as const,
    priority: "P2" as const,
    labels: [],
    module: "queue",
    impact: "unknown",
    missingInfo: ["Which version?"],
    duplicateOf: null,
    duplicateReason: "",
    route: "needs_info" as const,
    routeReason: "Missing reproduction",
  };
  const job: Job = {
    id: "published-question",
    caseId: issue.processing!.id,
    repoId: repo.id,
    issueId: issue.id,
    issueSnapshot: issue,
    revision: revision(issue, repo, "triage"),
    baseSha: repo.headSha,
    kind: "triage",
    status: "approved",
    createdAt: "now",
    updatedAt: "now",
    attempt: 1,
    artifact,
    result: fixtureAnalysis(issue, "triage"),
    publications: {
      comment: {
        status: "published",
        urls: ["https://github.com/fixture/queue/issues/128#comment"],
        startedAt: "2026-09-26T00:00:00Z",
        at: "2026-09-26T00:00:01Z",
      },
    },
  };
  first.put("jobs", job);
  first.close();
  const restored = new Store(path),
    w = new Workbench(restored, dir, undefined, undefined, false),
    updated = restored.get<Issue>("issues", issue.id)!;
  assert.equal(updated.informationRequests!.length, 1);
  assert.equal(updated.informationRequests![0].source, "published_comment");
  assert.equal(
    updated.informationRequests![0].askedAt,
    job.publications!.comment!.startedAt,
  );
  assert.equal(
    restored.processing
      .current(issue.id)!
      .waits.find((wait) => wait.type === "reporter_reply")!.state,
    "open",
  );
  assert.ok(
    restored.get<Job>("jobs", job.id)!.publications!.comment!
      .followupRecordedAt,
  );
  const count = restored.processing.events(issue.processing!.id).length;
  await w.close();
  const twice = new Store(path),
    w2 = new Workbench(twice, dir, undefined, undefined, false);
  t.after(() => w2.close());
  assert.equal(
    twice.get<Issue>("issues", issue.id)!.informationRequests!.length,
    1,
  );
  assert.equal(twice.processing.events(issue.processing!.id).length, count);
});

test("question analysis routes to repository-backed answer preparation and refuses accidental code changes", async (t) => {
  const f = fixture(),
    w = new Workbench(
      f.store,
      "/tmp/mw-question-answer",
      async()=>{throw new Error('此测试不执行 Agent');},
      undefined,
      false,
    );
  t.after(() => w.close());
  const issue = {
    ...f.issue,
    analysis: {
      ...fixtureAnalysis(f.issue, "triage"),
      category: "question" as const,
    },
  };
  f.store.put("issues", issue);
  const triage = artifactSchemas.triage.parse({
    schemaVersion: 1,
    stage: "triage",
    summary: "Question",
    coverage: "metadata",
    evidence: [],
    nextSteps: [],
    responseDraft: "Preliminary answer",
    category: "question",
    priority: "P3",
    labels: [],
    module: "queue",
    impact: "usage",
    missingInfo: [],
    duplicateOf: null,
    duplicateReason: "",
    route: "answer",
    routeReason: "Read docs",
  });
  const job = {
    id: "question-triage",
    kind: "triage",
    status: "completed",
    artifact: triage,
    result: asAnalysis(triage),
  } as Job;
  assert.equal(
    availableActions(f.store.get<Issue>("issues", issue.id)!, job).primary
      ?.kind,
    "investigate",
  );
  assert.throws(() => w.enqueue([issue.id], "fix"), /使用提问/);
  const repo = f.store.repos()[0],
    answer: Job = {
      id: "answer",
      caseId: issue.processing!.id,
      kind: "investigate",
      repoId: repo.id,
      issueId: issue.id,
      issueSnapshot: f.store.get<Issue>("issues", issue.id)!,
      revision: revision(
        f.store.get<Issue>("issues", issue.id)!,
        repo,
        "investigate",
      ),
      baseSha: repo.headSha,
      status: "approved",
      attempt: 1,
      createdAt: "now",
      updatedAt: "now",
      result: fixtureAnalysis(issue, "investigate"),
    };
  f.store.put("jobs", answer);
  assert.equal(
    availableActions(f.store.get<Issue>("issues", issue.id)!, answer).primary,
    undefined,
  );
  f.store.put("jobs", {
    ...answer,
    publications: {
      comment: {
        status: "published",
        urls: ["https://github.com/fixture/queue/issues/128#answer"],
        at: "2026-09-26T00:00:00Z",
      },
    },
  });
  assert.equal(f.store.processing.current(issue.id)!.phase, "answered");
  assert.equal(f.store.get<Issue>("issues", issue.id)!.state, "open");
});

test("an incomplete review or a maintainer evidence request routes to further investigation", () => {
  const f = fixture();
  try {
    const artifact = artifactSchemas.review.parse({
      schemaVersion: 1,
      stage: "review",
      summary: "Need evidence",
      coverage: "partial",
      evidence: [],
      nextSteps: [],
      responseDraft: "",
      findings: [],
      verdict: "incomplete",
      blockers: ["Missing source"],
    });
    const job = {
      kind: "review",
      status: "completed",
      artifact,
      result: asAnalysis(artifact),
    } as Job;
    assert.equal(availableActions(f.issue, job).primary?.kind, "investigate");
    assert.equal(
      availableActions(f.issue, {
        ...job,
        artifact: { ...artifact, verdict: "no_findings" },
        findingDecisions: { f1: "needs_evidence" },
      }).primary?.kind,
      "investigate",
    );
  } finally {
    f.store.close();
  }
});
