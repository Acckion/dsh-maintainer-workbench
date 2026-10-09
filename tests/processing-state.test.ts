import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessingService } from "../src/application/processing.ts";
import { artifactSchemas, asAnalysis } from "../src/core/artifacts.ts";
import { Store } from "../src/core/store.ts";
import type { Issue, Job, Runner } from "../src/core/types.ts";
import { Workbench, revision } from "../src/core/workbench.ts";
import { handler, localRejection } from "../src/server/http.ts";
import { availableActions } from "../src/workflow/actions.ts";
import { fixtureAnalysis, seedFixture } from "./support/fixtures.ts";

test("a waiting case and its input survive restart without scheduling Agent work", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mw-state-")),
    db = join(dir, "state.sqlite");
  const first = new Store(db);
  seedFixture(first);
  const id = first.issues()[0].id;
  const service = new ProcessingService(first),
    wait = service.requestInput(id, {
      reason: "Need target behavior",
      fields: [{ id: "behavior", question: "Expected behavior?" }],
    });
  const saved = first.processing.current(id)!;
  first.close();
  const restored = new Store(db);
  t.after(async () => {
    restored.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(restored.processing.current(id), saved);
  assert.equal(restored.jobs().length, 0);
  const resumed = new ProcessingService(restored);
  assert.throws(
    () =>
      resumed.submitInput(
        id,
        wait.id,
        { behavior: "after" },
        saved.version - 1,
      ),
    /状态已变化/,
  );
  assert.throws(
    () => resumed.submitInput(id, wait.id, { other: "after" }, saved.version),
    /完整填写/,
  );
  resumed.submitInput(id, wait.id, { behavior: "after" }, saved.version);
  assert.equal(restored.processing.current(id)?.waits[0].state, "satisfied");
  assert.equal(
    restored.processing.inputs(saved.id)[0].values.behavior,
    "after",
  );
  assert.equal(restored.jobs().length, 0);
});

test("events are deduplicated and state/event/issue writes roll back together", () => {
  const store = new Store(":memory:");
  seedFixture(store);
  const issue = store.issues()[0],
    initial = store.processing.current(issue.id)!;
  const event = {
    type: "remote.activity" as const,
    kind: "ci" as const,
    fingerprint: "ci-1",
  };
  const once = store.processing.dispatch(
    issue.id,
    event,
    "github",
    "delivery-1",
  );
  assert.deepEqual(
    store.processing.dispatch(issue.id, event, "github", "delivery-1"),
    once,
  );
  assert.throws(
    () =>
      store.transaction(() => {
        store.put("issues", { ...issue, title: "changed" });
        throw Error("rollback");
      }),
    /rollback/,
  );
  assert.equal(store.get<Issue>("issues", issue.id)?.title, issue.title);
  assert.deepEqual(store.processing.current(issue.id), once);
  assert.equal(
    store.processing
      .events(initial.id)
      .filter((e) => e.payload.type === "remote.activity").length,
    1,
  );
  store.close();
});

test("late results cannot advance changed input or a newer execution", () => {
  const store = new Store(":memory:");
  seedFixture(store);
  const issue = store.issues()[0],
    repo = store.repos()[0],
    state = store.processing.current(issue.id)!;
  const job: Job = {
    id: "old-run",
    caseId: state.id,
    repoId: repo.id,
    issueId: issue.id,
    issueSnapshot: issue,
    revision: revision(issue, repo),
    baseSha: repo.headSha,
    kind: "triage",
    status: "queued",
    attempt: 1,
    createdAt: "now",
    updatedAt: "now",
  };
  store.put("jobs", job);
  store.put("jobs", { ...job, status: "running" });
  store.put("issues", {
    ...store.get<Issue>("issues", issue.id)!,
    body: "New evidence",
    updatedAt: "2026-10-10T00:00:00Z",
  });
  const changed = store.processing.current(issue.id)!;
  store.put("jobs", {
    ...job,
    status: "completed",
    result: fixtureAnalysis(issue, "triage"),
  });
  assert.equal(store.processing.current(issue.id)?.phase, changed.phase);
  assert.deepEqual(store.processing.current(issue.id)?.activeRunIds, []);
  const current = store.get<Issue>("issues", issue.id)!;
  const newer = {
    ...job,
    id: "new-run",
    issueSnapshot: current,
    revision: revision(current, repo),
  };
  store.put("jobs", newer);
  store.put("jobs", { ...job, status: "approved" });
  assert.equal(store.processing.current(issue.id)?.currentRunId, newer.id);
  store.close();
});

test("close/reopen starts a new processing cycle and old jobs cannot change it", () => {
  const store = new Store(":memory:");
  seedFixture(store);
  const issue = store.issues()[0],
    repo = store.repos()[0],
    first = store.processing.current(issue.id)!;
  const job: Job = {
    id: "closed-cycle-run",
    caseId: first.id,
    repoId: repo.id,
    issueId: issue.id,
    issueSnapshot: issue,
    revision: revision(issue, repo),
    baseSha: repo.headSha,
    kind: "triage",
    status: "queued",
    attempt: 1,
    createdAt: "now",
    updatedAt: "now",
  };
  store.put("jobs", job);
  store.put("issues", { ...issue, state: "closed" });
  assert.equal(store.processing.current(issue.id)?.phase, "closed");
  store.put("issues", { ...issue, state: "open" });
  const reopened = store.processing.current(issue.id)!;
  assert.notEqual(reopened.id, first.id);
  assert.equal(reopened.cycle, 2);
  store.put("jobs", {
    ...job,
    status: "completed",
    result: fixtureAnalysis(issue, "triage"),
  });
  assert.deepEqual(store.processing.current(issue.id), reopened);
  assert.equal(store.processing.cases(issue.id).length, 2);
  store.close();
});

test("deferred decisions survive source activity and refuse accidental task dispatch", async () => {
  const store = new Store(":memory:");
  seedFixture(store);
  const w = new Workbench(
      store,
      "/tmp/mw-deferred",
      undefined,
      undefined,
      false,
    ),
    issue = store.issues()[0];
  try {
    w.decide(issue.id, "deferred", "Wait for next release");
    store.put("issues", {
      ...store.get<Issue>("issues", issue.id)!,
      body: "More information",
    });
    assert.equal(store.processing.current(issue.id)?.lifecycle, "deferred");
    assert.throws(() => w.enqueue([issue.id], "triage"), /暂缓/);
    w.decide(issue.id, "decision", "Resume assessment");
    assert.equal(w.enqueue([issue.id], "triage").created.length, 1);
  } finally {
    await w.close();
  }
});

test("source changes invalidate an outstanding input request without approving it", () => {
  const store = new Store(":memory:");
  seedFixture(store);
  const service = new ProcessingService(store),
    issue = store.issues()[0];
  const wait = service.requestInput(issue.id, {
    reason: "Confirm scope",
    fields: [{ id: "scope", question: "Which scope?" }],
  });
  store.put("issues", {
    ...store.get<Issue>("issues", issue.id)!,
    body: "Different goal",
  });
  assert.equal(
    store.processing.current(issue.id)?.waits.find((w) => w.id === wait.id)
      ?.state,
    "superseded",
  );
  assert.throws(
    () =>
      service.submitInput(
        issue.id,
        wait.id,
        { scope: "Old answer" },
        store.processing.current(issue.id)!.version,
      ),
    /已结束/,
  );
  store.close();
});

test("a superseded input wait allows a fresh task and never reuses the paused execution", async (t) => {
  const store = new Store(":memory:");
  seedFixture(store);
  const w = new Workbench(
    store,
    "/tmp/mw-superseded-input",
    undefined,
    undefined,
    false,
  );
  t.after(() => w.close());
  const issue = store.issues()[0],
    id = w.enqueue([issue.id], "triage").created[0],
    job = store.get<Job>("jobs", id)!;
  store.put("jobs", {
    ...job,
    status: "waiting_input",
    result: fixtureAnalysis(issue, "triage"),
  });
  w.processing.requestInput(
    issue.id,
    {
      reason: "Need behavior",
      fields: [{ id: "behavior", question: "Expected behavior?" }],
    },
    id,
  );
  w.decide(issue.id, "decision", "Reassess with current evidence");
  assert.throws(() => w.resume(id), /先回答/);
  const fresh = w.enqueue([issue.id], "triage");
  assert.equal(fresh.created.length, 1);
  assert.deepEqual(fresh.reused, []);
});

test("an accepted feature plan is actionable and needs fresh approval after GitHub input changes", async (t) => {
  const store = new Store(":memory:");
  seedFixture(store);
  const w = new Workbench(
    store,
    "/tmp/mw-plan",
    async () => {
      throw Error("No execution expected");
    },
    undefined,
    false,
  );
  t.after(() => w.close());
  const issue = store.issues()[0];
  w.savePlan(issue.id, {
    category: "feature",
    decision: "accepted",
    goal: "Offline queue",
    scope: "Queue only",
    reproduction: "",
    expected: "",
    actual: "",
    acceptanceCriteria: ["Retain order"],
  });
  const accepted = store.get<Issue>("issues", issue.id)!;
  assert.equal(availableActions(accepted).primary?.kind, "fix");
  assert.equal(availableActions(accepted).primary?.enabled, true);
  store.put("issues", { ...accepted, body: "New compatibility constraint" });
  assert.throws(() => w.enqueue([issue.id], "fix"), /重新确认/);
  w.decide(issue.id, "accepted", "Confirmed compatibility constraint");
  assert.equal(w.enqueue([issue.id], "fix").created.length, 1);
});

test("legacy queued executions migrate once without invoking the Agent or replaying events", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mw-legacy-state-")),
    db = join(dir, "state.sqlite");
  const first = new Store(db);
  seedFixture(first);
  const issue = first.issues()[0],
    repo = first.repos()[0];
  const job: Job = {
    id: "legacy-queued",
    repoId: repo.id,
    issueId: issue.id,
    issueSnapshot: issue,
    revision: revision(issue, repo),
    baseSha: repo.headSha,
    kind: "triage",
    status: "queued",
    attempt: 1,
    createdAt: "now",
    updatedAt: "now",
  };
  // Simulate pre-refactor data: original tables only, no business-state records.
  first.db
    .prepare("INSERT INTO jobs VALUES(?,?)")
    .run(job.id, JSON.stringify(job));
  first.db.exec(
    "DELETE FROM processing_events; DELETE FROM processing_inputs; DELETE FROM processing_cases",
  );
  first.close();
  const migrated = new Store(db),
    state = migrated.processing.current(issue.id)!;
  assert.deepEqual(state.activeRunIds, [job.id]);
  assert.equal(state.currentRunId, job.id);
  const count = migrated.processing.events(state.id).length;
  migrated.close();
  const restored = new Store(db);
  t.after(async () => {
    restored.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(restored.processing.current(issue.id), state);
  assert.equal(restored.processing.events(state.id).length, count);
  assert.equal(restored.jobs()[0].status, "queued");
});

test("reopened items dispatch a fresh execution instead of reusing previous-cycle work", async (t) => {
  const store = new Store(":memory:");
  seedFixture(store);
  const w = new Workbench(store, "/tmp/mw-reopen", undefined, undefined, false);
  t.after(() => w.close());
  const issue = store.issues()[0],
    id = w.enqueue([issue.id], "triage").created[0],
    job = store.get<Job>("jobs", id)!;
  store.put("jobs", {
    ...job,
    status: "completed",
    result: fixtureAnalysis(issue, "triage"),
  });
  store.put("issues", {
    ...store.get<Issue>("issues", issue.id)!,
    state: "closed",
  });
  store.put("issues", {
    ...store.get<Issue>("issues", issue.id)!,
    state: "open",
  });
  assert.throws(
    () => w.enqueue([issue.id], "investigate", { sourceJobId: id }),
    /同一事项/,
  );
  const dispatched = w.enqueue([issue.id], "triage");
  assert.equal(dispatched.created.length, 1);
  assert.deepEqual(dispatched.reused, []);
  const fresh = store.get<Job>("jobs", dispatched.created[0])!;
  assert.notEqual(fresh.caseId, job.caseId);
  assert.equal(fresh.handoff?.length, 0);
});

test("document validation failures route to document implementation and never to a passing review", () => {
  const artifact = artifactSchemas.validate.parse({
    schemaVersion: 1,
    stage: "validate",
    summary: "Broken link",
    coverage: "changed docs",
    evidence: [],
    nextSteps: [],
    responseDraft: "",
    environment: "fixture",
    tests: [{ command: "check links", status: "failed", output: "missing" }],
    blockers: [],
  });
  const issue = {
    state: "open",
    type: "issue",
    plan: {
      category: "docs",
      decision: "accepted",
      goal: "Fix docs",
      acceptanceCriteria: ["links valid"],
    },
  } as Issue;
  const job = {
    kind: "validate",
    status: "completed",
    result: asAnalysis(artifact),
    artifact,
    patch: "patch",
    handoff: [{ id: "docs", kind: "docs" }],
    sourceJobId: "docs",
  } as Job;
  assert.equal(availableActions(issue, job).primary?.kind, "docs");
});

test("HTTP returns a version conflict for an obsolete maintainer decision", async (t) => {
  const store = new Store(":memory:");
  seedFixture(store);
  const w = new Workbench(
      store,
      "/tmp/mw-version",
      undefined,
      undefined,
      false,
    ),
    issue = store.issues()[0],
    version = issue.processing!.version;
  const server = createServer(handler(w, localRejection));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await w.close();
  });
  w.decide(issue.id, "deferred", "wait");
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/maintainer/api/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueId: issue.id,
        stage: "accepted",
        reason: "old window",
        expectedVersion: version,
      }),
    },
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "VERSION_CONFLICT");
  assert.equal(store.processing.current(issue.id)?.lifecycle, "deferred");
});

test("Agent input request releases execution capacity; user answer resumes only by explicit command", async (t) => {
  const store = new Store(":memory:");
  seedFixture(store);
  let calls = 0;
  const runner: Runner = async ({ job, issue }) => {
    calls++;
    const artifact = artifactSchemas.investigate.parse({
      schemaVersion: 1,
      stage: "investigate",
      summary: "Need behavior",
      coverage: "metadata",
      evidence: [],
      nextSteps: [],
      responseDraft: "",
      facts: [],
      hypotheses: [],
      reproduction: "",
      rootCause: "",
      impact: "",
      proposedChanges: [],
      acceptanceCriteria: [],
      blockers: [],
      ...(calls === 1
        ? {
            inputRequest: {
              reason: "Need expected behavior",
              fields: [{ id: "behavior", question: "What should happen?" }],
            },
          }
        : {}),
    });
    if (calls === 2) assert.match(job.instructions ?? "", /Keep queue order/);
    return { artifact, result: asAnalysis(artifact), engine: "fixture" };
  };
  const dir = await mkdtemp(join(tmpdir(), "mw-input-"));
  const w = new Workbench(store, dir, runner, undefined, false);
  t.after(async () => {
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  w.prepareRepository = async () => {};
  const id = w.enqueue([store.issues()[0].id], "investigate", {
    goal: "resolve",
  }).created[0];
  w.pump();
  await w.drain();
  assert.equal(store.get<Job>("jobs", id)?.status, "waiting_input");
  assert.equal(w.snapshot().capabilities.running, 0);
  w.pump();
  await w.drain();
  assert.equal(calls, 1);
  assert.throws(() => w.resume(id), /先回答/);
  const state = store.processing.current(store.issues()[0].id)!,
    wait = state.waits.find((w) => w.type === "user_input")!;
  w.processing.submitInput(
    state.workItemId,
    wait.id,
    { behavior: "Keep queue order" },
    state.version,
  );
  assert.equal(calls, 1);
  w.resume(id);
  w.pump();
  await w.drain();
  assert.equal(calls, 2);
  assert.equal(store.jobs().length, 2);
});
