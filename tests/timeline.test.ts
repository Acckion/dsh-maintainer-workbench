import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StagePanel } from "../src/client/StagePanel.tsx";
import {
  projectTimeline,
  processingTimeline,
} from "../src/application/timeline.ts";
import { availableActions } from "../src/workflow/actions.ts";
import { Store } from "../src/core/store.ts";
import type { Issue, Job, JobKind } from "../src/core/types.ts";
import type {
  ProcessingCase,
  ProcessingEvent,
} from "../src/domain/processing.ts";
import { seedFixture, fixtureAnalysis } from "./support/fixtures.ts";
import { revision } from "../src/core/revision.ts";
import { taskProfile } from "../src/workflow/presentation.ts";

const issue: Issue = {
  id: "fixture#1",
  repoId: "fixture",
  number: 1,
  type: "pr",
  title: "Fixture",
  body: "",
  author: "fixture",
  labels: [],
  state: "open",
  comments: 0,
  updatedAt: "2026-10-09T00:00:00Z",
  url: "",
};
const state: ProcessingCase = {
  id: "case",
  workItemId: issue.id,
  repositoryId: issue.repoId,
  workflowDefinitionVersion: "maintainer/2",
  lifecycle: "active",
  phase: "review",
  reason: "Fixture",
  waits: [],
  activeRunIds: [],
  sourceFingerprint: "fixture",
  cycle: 1,
  version: 1,
  createdAt: issue.updatedAt,
  updatedAt: issue.updatedAt,
};
const job = (
  id: string,
  kind: JobKind,
  status: Job["status"] = "completed",
  time = 1,
): Job => ({
  id,
  kind,
  status,
  issueId: issue.id,
  repoId: issue.repoId,
  caseId: state.id,
  revision: "fixture",
  baseSha: "a".repeat(40),
  issueSnapshot: issue,
  attempt: 1,
  createdAt: `2026-10-09T00:00:0${time}Z`,
  updatedAt: issue.updatedAt,
  result: fixtureAnalysis(issue, kind),
});

test("timeline preserves first-stage order, attempts and selected artifacts across investigation/review loops", () => {
  const first = job("first", "review", "failed"),
    investigation = job("investigation", "investigate", "completed", 2),
    second = job("second", "review", "awaiting_review", 3);
  first.error = "old failed proof";
  second.result = { ...second.result!, summary: "New result" };
  const before = JSON.stringify([first, investigation, second]);
  const view = projectTimeline(
    issue,
    { ...state, currentRunId: second.id },
    [second, investigation, first],
    [],
    availableActions(issue, second, [first, investigation, second]),
  );
  assert.deepEqual(
    view.nodes.slice(0, 2).map((n) => n.stage),
    ["review", "investigate"],
  );
  assert.deepEqual(view.nodes[0]!.attemptIds, [first.id, second.id]);
  assert.equal(view.currentRunId, second.id);
  assert.equal(first.error, "old failed proof");
  assert.equal(JSON.stringify([first, investigation, second]), before);
});

test("question route has no implementation or validation forecast", () => {
  const item = {
    ...issue,
    type: "issue" as const,
    analysis: {
      ...fixtureAnalysis(issue, "triage"),
      category: "question" as const,
    },
  };
  const view = projectTimeline(
    item,
    { ...state, phase: "discovered" },
    [],
    [],
    availableActions(item),
  );
  assert.deepEqual(
    view.nodes.map((n) => n.stage),
    ["triage", "investigate", "decision", "track"],
  );
  assert.ok(
    !view.nodes.some((n) => ["fix", "docs", "validate"].includes(n.stage)),
  );
});

test("Draft and no findings mean maintainer confirmation, never merge approval", () => {
  const review = job("review", "review", "awaiting_review");
  review.artifact = {
    schemaVersion: 1,
    stage: "review",
    summary: "No blockers",
    coverage: "Fixture",
    evidence: [],
    nextSteps: [],
    responseDraft: "",
    verdict: "no_findings",
    findings: [],
    blockers: [],
  };
  const view = projectTimeline(
    { ...issue, draft: true },
    { ...state, currentRunId: review.id },
    [review],
    [],
    availableActions(issue, review, [review]),
  );
  const current = view.nodes.find((n) => n.id === view.currentNodeId)!;
  assert.equal(current.stage, "decision");
  assert.equal(current.status, "waiting");
  assert.equal(view.draft, true);
  assert.ok(
    view.nodes
      .find((n) => n.stage === "track")!
      .conditions.some((c) => c.includes("Draft")),
  );
  assert.ok(!view.next.includes("可以合并"));
});

test("each wait stays attached to its requesting stage and future points are not fake runs", () => {
  const run = job("input", "investigate", "waiting_input");
  const wait = {
    id: "input",
    type: "user_input" as const,
    state: "open" as const,
    reason: "Expected behavior?",
    targetFingerprint: state.sourceFingerprint,
    requestedByRunId: run.id,
    createdAt: issue.updatedAt,
  };
  const view = projectTimeline(
    issue,
    { ...state, currentRunId: run.id, waits: [wait], lifecycle: "waiting" },
    [run],
    [],
    availableActions(
      { ...issue, processing: { ...state, waits: [wait] } },
      run,
      [run],
    ),
  );
  assert.equal(
    view.nodes.find((n) => n.stage === "investigate")!.waits[0]!.id,
    wait.id,
  );
  for (const node of view.nodes.filter((n) => n.status === "future")) {
    assert.equal(node.attemptIds.length, 0);
    assert.equal(node.occurredAt, undefined);
    assert.ok(node.conditions.length);
  }
});

test("a late historical run cannot take the current node from the authoritative run", () => {
  const active = job("active", "review", "running", 2),
    late = job("late", "investigate", "completed", 3);
  const view = projectTimeline(
    issue,
    { ...state, currentRunId: active.id, activeRunIds: [active.id] },
    [active, late],
    [],
    availableActions(issue, active, [active, late]),
  );
  assert.equal(
    view.nodes.find((n) => n.id === view.currentNodeId)!.stage,
    "review",
  );
  assert.equal(
    view.nodes.find((n) => n.id === view.currentNodeId)!.status,
    "running",
  );
  assert.match(view.next, /等待当前阶段结束/);
});

test("old cycles are read-only and do not borrow attempts from a new cycle", () => {
  const old = job("old", "review"),
    newRun = { ...job("new", "fix"), caseId: "new-case" };
  const view = projectTimeline(
    issue,
    { ...state, currentRunId: old.id, lifecycle: "completed" },
    [old, newRun],
    [],
    availableActions(issue, old, [old]),
    true,
  );
  assert.equal(view.actions, undefined);
  assert.equal(view.historical, true);
  assert.ok(!view.nodes.some((n) => n.attemptIds.includes(newRun.id)));
  assert.ok(!view.nodes.some((n) => n.status === "future"));
});

test("PR test specialization is evidence-based and explicitly provisional", () => {
  const review = job("review", "review");
  review.result = { ...review.result!, category: "maintenance" };
  review.artifact = {
    schemaVersion: 1,
    stage: "review",
    summary: "Fixture",
    coverage: "Fixture",
    evidence: [],
    nextSteps: [],
    responseDraft: "",
    verdict: "incomplete",
    findings: [],
    blockers: [],
    inspectedSources: [
      {
        executionId: "fixture",
        path: "src/gateway/server.lifecycle.test.ts",
        line: 1,
        quote: "fixture",
      },
    ],
  };
  assert.equal(taskProfile(issue, [review]).category, "tests");
  assert.equal(taskProfile(issue, [review]).provisional, true);
  assert.equal(
    taskProfile({ ...issue, title: "test: looks like a test" }, []).category,
    "unknown",
  );
  assert.equal(
    taskProfile(issue, [{ ...review, artifactState: "stale" }]).category,
    "unknown",
  );
});

test("decision events retain their position, closed cases do not forecast work", () => {
  const first = job("preflight", "preflight"),
    second = job("review", "review", "completed", 3);
  const event: ProcessingEvent = {
    id: "decision",
    caseId: state.id,
    workItemId: issue.id,
    source: "user",
    deduplicationKey: "fixture",
    occurredAt: "2026-10-09T00:00:02Z",
    receivedAt: "2026-10-09T00:00:02Z",
    payload: {
      type: "decision.recorded",
      phase: "decision",
      reason: "Fixture",
    },
  };
  const view = projectTimeline(
    { ...issue, state: "closed", merged: true },
    {
      ...state,
      lifecycle: "completed",
      phase: "closed",
      currentRunId: second.id,
    },
    [first, second],
    [event],
  );
  assert.deepEqual(
    view.nodes.map((n) => n.stage),
    ["preflight", "decision", "review", "track"],
  );
  assert.equal(view.nodes.at(-1)!.result, "远端已合并");
});

test("persistent timeline reads leave jobs, events, versions and Git workspaces unchanged", () => {
  const store = new Store(":memory:");
  try {
    seedFixture(store);
    const item = store.issues()[0]!;
    const before = {
      jobs: store.jobs(),
      events: store.processing.events(item.processing!.id),
      version: item.processing!.version,
    };
    const view = processingTimeline(store, item.id);
    assert.equal(view.version, before.version);
    assert.deepEqual(store.jobs(), before.jobs);
    assert.deepEqual(
      store.processing.events(item.processing!.id),
      before.events,
    );
    assert.equal(store.processing.current(item.id)!.version, before.version);
    assert.throws(
      () => processingTimeline(store, item.id, "foreign-case"),
      /不属于/,
    );
  } finally {
    store.close();
  }
});

test("persistent projection invalidates saved approval after input changes and forecasts a fresh run", () => {
  const store = new Store(":memory:");
  try {
    seedFixture(store);
    const original = store.issues()[0]!;
    const item = { ...original, type: "pr" as const, headSha: "b".repeat(40) };
    store.put("issues", item);
    const processing = store.processing.current(item.id)!;
    const repo = store.repos()[0]!;
    const run = {
      ...job("stale-review", "review", "awaiting_review"),
      issueId: item.id,
      repoId: item.repoId,
      caseId: processing.id,
      issueSnapshot: item,
      revision: revision(item, repo, "review"),
      artifact: {
        schemaVersion: 1 as const,
        stage: "review" as const,
        summary: "old approval",
        coverage: "old source",
        evidence: [],
        nextSteps: [],
        responseDraft: "",
        verdict: "no_findings" as const,
        findings: [],
        blockers: [],
      },
    };
    store.put("jobs", { ...run, status: "queued" });
    store.put("jobs", run);
    assert.equal(
      processingTimeline(store, item.id).nodes.find(
        (n) => n.id === processingTimeline(store, item.id).currentNodeId,
      )?.stage,
      "decision",
    );
    store.put("issues", {
      ...store.get<Issue>("issues", item.id)!,
      body: "Changed scope",
    });
    const view = processingTimeline(store, item.id);
    assert.equal(
      view.nodes.find((n) => n.id === view.currentNodeId)?.result,
      "输入已更新",
    );
    assert.equal(
      view.nodes.find((n) => n.stage === "review" && n.attemptIds.length)
        ?.status,
      "stale",
    );
    assert.ok(
      view.nodes.some((n) => n.status === "future" && n.stage === "preflight"),
    );
    assert.equal(
      store.get<Job>("jobs", run.id)!.artifact?.summary,
      "old approval",
    );
  } finally {
    store.close();
  }
});

test("activity projection bounds its payload while retaining the complete activity count", () => {
  const events: ProcessingEvent[] = Array.from({ length: 120 }, (_, i) => ({
    id: `e-${i}`,
    caseId: state.id,
    workItemId: issue.id,
    source: "user",
    deduplicationKey: `fixture-${i}`,
    occurredAt: issue.updatedAt,
    receivedAt: issue.updatedAt,
    payload: {
      type: "decision.recorded",
      phase: "decision",
      reason: "fixture",
    },
  }));
  const view = projectTimeline(issue, state, [], events);
  assert.equal(view.events.length, 100);
  assert.equal(view.eventTotal, 120);
  assert.equal(view.events[0]!.id, "e-20");
  assert.equal(events.length, 120);
});

test("delivery nodes retain the confirmed publication's source instead of borrowing a newer artifact", () => {
  const published = job("published", "fix", "approved"),
    current = job("current", "review", "running", 3);
  const event: ProcessingEvent = {
    id: "delivery",
    caseId: state.id,
    workItemId: issue.id,
    source: "user",
    deduplicationKey: "delivery",
    occurredAt: issue.updatedAt,
    receivedAt: "2026-10-09T00:00:02Z",
    payload: {
      type: "publication.confirmed",
      action: "pr",
      runId: published.id,
      targetUrl: "https://example.com/fixture",
    },
  };
  const view = projectTimeline(
    issue,
    { ...state, currentRunId: current.id, activeRunIds: [current.id] },
    [published, current],
    [event],
  );
  const track = view.nodes.find((n) => n.stage === "track")!;
  assert.deepEqual(track.attemptIds, [published.id]);
  assert.equal(track.status, "saved");
  assert.equal(view.currentRunId, current.id);
  assert.equal(
    view.nodes.find((n) => n.id === view.currentNodeId)?.stage,
    "review",
  );
});

test("browsing an earlier scope decision never mounts the current editable plan or latest artifact", () => {
  const current = job("implementation", "fix", "completed", 3);
  current.result = {
    ...current.result!,
    summary: "current implementation must stay on its own node",
  };
  const event: ProcessingEvent = {
    id: "decision",
    caseId: state.id,
    workItemId: issue.id,
    source: "user",
    deduplicationKey: "scope",
    occurredAt: issue.updatedAt,
    receivedAt: "2026-10-09T00:00:02Z",
    payload: {
      type: "decision.recorded",
      phase: "accepted",
      reason: "Only the offline queue is in scope",
    },
  };
  const item = { ...issue, type: "issue" as const };
  const view = projectTimeline(
    item,
    { ...state, phase: "review", currentRunId: current.id },
    [current],
    [event],
  );
  const selected = view.nodes.find((n) => n.stage === "decision")!;
  const renders: string[] = [];
  const markup = renderToStaticMarkup(
    React.createElement(StagePanel, {
      selected,
      timeline: view,
      issue: item,
      currentJob: current,
      history: [current],
      readOnly: true,
      viewingHistory: true,
      selection: { view: "stage", detail: "result" },
      choose: () => {},
      render: (tab) => {
        renders.push(tab);
        return null;
      },
      track: () => null,
    }),
  );
  assert.deepEqual(renders, []);
  assert.match(markup, /Only the offline queue is in scope/);
  assert.doesNotMatch(
    markup,
    /current implementation must stay on its own node/,
  );
});
