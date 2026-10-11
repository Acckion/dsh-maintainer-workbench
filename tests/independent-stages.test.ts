import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantActions } from "../src/client/AssistantActions.tsx";
import { availableActions } from "../src/workflow/actions.ts";
import { stageInput, stageSource } from "../src/workflow/stage-input.ts";
import { Store } from "../src/core/store.ts";
import { Workbench } from "../src/core/workbench.ts";
import { revision } from "../src/core/revision.ts";
import type { Issue, Job, JobKind } from "../src/core/types.ts";
import { fixtureAnalysis, seedFixture, fixtureRunner } from "./support/fixtures.ts";

function setup(t: test.TestContext) {
  const store = new Store(":memory:");
  seedFixture(store);
  const wb = new Workbench(store, "unused-independent-fixture", fixtureRunner, undefined, false);
  t.after(() => wb.close());
  return { store, wb, issue: store.issues()[0], repo: store.repos()[0] };
}

function completed(issue: Issue, kind: JobKind, status: Job["status"] = "completed"): Job {
  return {
    id: `${issue.id}:${kind}`, repoId: issue.repoId, issueId: issue.id, kind, status,
    baseSha: "fixture", revision: "fixture", issueSnapshot: issue,
    result: { ...fixtureAnalysis(issue, kind), missingInfo: [] },
    attempt: 1, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z",
  };
}

test("all applicable nodes are selectable without predecessors; downstream input is required", t => {
  const { issue } = setup(t);
  const actions = availableActions(issue);
  for (const kind of ["investigate", "fix", "docs", "validate", "review"] as const) {
    const action = actions.stages.find(a => a.kind === kind)!;
    assert.equal(action.enabled, true, kind);
    assert.equal(action.input?.required, true, kind);
    assert.ok(action.input?.warnings[0].includes("依赖节点"), kind);
  }
  assert.equal(actions.stages.find(a => a.kind === "triage")?.input?.required, false);
});

test("direct dispatch requires real supplementary input and creates no predecessor jobs", t => {
  const { wb, store, issue } = setup(t);
  for (const kind of ["investigate", "fix", "docs", "validate", "review"] as const) {
    assert.throws(() => wb.enqueue([issue.id], kind), /用户补充信息为必填/, kind);
    assert.throws(() => wb.enqueue([issue.id], kind, { instructions: " \n " }), /用户补充信息为必填/, kind);
    const id = wb.enqueue([issue.id], kind, { supplementalInfo: `Independently execute ${kind} for queue ordering at the recorded checkout.` }).created[0];
    const job = store.get<Job>("jobs", id)!;
    assert.equal(job.kind, kind);
    assert.equal(job.sourceJobId, undefined);
    assert.match(job.instructions!, /queue ordering/);
    assert.equal(job.goal, undefined);
  }
  assert.deepEqual(store.jobs().map(j => j.kind).sort(), ["investigate", "fix", "docs", "validate", "review"].sort());
});

test("a completed predecessor makes supplementary input optional without relaxing evidence checks", t => {
  const { wb, store, issue, repo } = setup(t);
  const prior = { ...completed(issue, "triage"), revision: revision(issue, repo, "triage") };
  store.put("jobs", prior);
  assert.equal(stageInput(issue, "investigate", [prior]).required, false);
  assert.equal(wb.enqueue([issue.id], "investigate").created.length, 1);
  assert.equal(store.jobs().filter(j => j.kind === "triage").length, 1);
});

test("PR preflight is optional-context routing; review and CI can start independently with supplementary input", t => {
  const { wb, store, issue } = setup(t);
  const pr = { ...issue, type: "pr" as const };
  store.put("issues", pr);
  const actions = availableActions(pr);
  assert.equal(actions.stages.find(a => a.kind === "preflight")?.input?.required, false);
  for (const kind of ["review", "ci"] as const) {
    assert.equal(actions.stages.find(a => a.kind === kind)?.enabled, true);
    assert.equal(actions.stages.find(a => a.kind === kind)?.input?.required, true);
    assert.throws(() => wb.enqueue([pr.id], kind), /用户补充信息为必填/);
    assert.equal(wb.enqueue([pr.id], kind, { instructions: `Inspect the current PR head for ${kind}; prior preflight is unavailable.` }).created.length, 1);
  }
});

test("generated workflow text cannot stand in for a blank user supplement", t => {
  const { wb, issue } = setup(t);
  assert.throws(() => wb.enqueue([issue.id], "validate", {
    instructions: "Automatically generated validation guidance.", supplementalInfo: "",
  }), /用户补充信息为必填/);
});

test("starting an independent node with context preserves outstanding clarification records", t => {
  const { wb, store, issue } = setup(t);
  const request = { id: "asked", questions: ["Which queue version?"], waitingFor: "reporter", state: "asked" as const,
    askedAt: issue.updatedAt, baselineComments: 0, source: "maintainer_record" as const, replies: [] };
  const item = { ...issue, informationRequests: [request] };
  store.put("issues", item);
  assert.equal(stageInput(item, "triage").required, true);
  assert.throws(() => wb.enqueue([issue.id], "triage"), /用户补充信息为必填/);
  wb.enqueue([issue.id], "triage", { instructions: "Analyze the queue v2 regression from the supplied description only; reporter reply remains pending." });
  assert.equal(store.get<Issue>("issues", issue.id)?.informationRequests?.[0].state, "asked");
});

test("failed, pending, stale, other-item and other-cycle results cannot replace required input", t => {
  const { issue } = setup(t);
  const good = completed(issue, "triage");
  const variants = [
    ...(["queued", "running", "failed", "waiting_input", "cancelled", "rejected"] as const).map(status => ({ ...good, status })),
    { ...good, artifactState: "stale" },
    { ...good, issueId: "another-item" },
    { ...good, repoId: "another-repository" },
    { ...good, result: undefined },
  ];
  for (const value of variants) assert.equal(stageInput(issue, "investigate", [value]).required, true);
  const state = { ...issue.processing!, id: "current-case" };
  assert.equal(stageInput({ ...issue, processing: state }, "investigate", [{ ...good, caseId: "old-case" }]).required, true);
});

test("repository revision drift is checked server-side even when the stored artifact is not marked stale", t => {
  const { wb, store, issue } = setup(t);
  store.put("jobs", completed(issue, "triage"));
  assert.throws(() => wb.enqueue([issue.id], "investigate"), /用户补充信息为必填/);
});

test("missing plan scope and pending clarification become input requirements; supplied context permits dispatch", t => {
  const { wb, store, issue } = setup(t);
  const input = { ...issue, analysis: { ...fixtureAnalysis(issue, "triage"), category: "feature" as const } };
  store.put("issues", input);
  const requirements = stageInput(input, "fix", [completed(input, "investigate")]);
  assert.equal(requirements.required, true);
  assert.ok(requirements.reasons.some(reason => reason.includes("验收")));
  assert.equal(wb.enqueue([issue.id], "fix", { instructions: "Implement offline queue only; accept if queue order remains stable." }).created.length, 1);
});

test("another node may start while a predecessor runs, with required context", t => {
  const { wb, store, issue } = setup(t);
  const running = { ...completed(issue, "triage", "running"), result: undefined };
  const actions = availableActions(issue, running, [running]);
  assert.equal(actions.stages.find(a => a.kind === "triage")?.enabled, false);
  assert.equal(actions.stages.find(a => a.kind === "investigate")?.enabled, true);
  assert.equal(actions.stages.find(a => a.kind === "investigate")?.input?.required, true);
  store.put("jobs", running);
  assert.equal(wb.enqueue([issue.id], "investigate", { instructions: "Investigate queue ordering independently, without waiting for triage." }).created.length, 1);
});

test("validation sources are patch producers, never unrelated metadata or a pending patch", t => {
  const { issue } = setup(t);
  const producer = { ...completed(issue, "docs"), patch: "actual patch" };
  const metadata = { ...completed(issue, "triage"), createdAt: "2026-10-11T01:00:00Z" };
  assert.equal(stageSource(issue, "validate", [producer, metadata])?.id, producer.id);
  assert.equal(stageInput(issue, "validate", [producer]).required, false);
  assert.equal(stageSource(issue, "validate", [metadata]), undefined);
  assert.equal(stageSource(issue, "review", [{ ...producer, status: "running" }]), undefined);
});

test("batch missing-input checks are atomic and run before any job creation", t => {
  const { wb, store, issue, repo } = setup(t);
  const other = store.issues()[1];
  store.put("jobs", { ...completed(issue, "triage"), revision: revision(issue, repo, "triage") });
  const before = store.jobs().length;
  assert.throws(() => wb.enqueue([issue.id, other.id], "investigate"), /用户补充信息为必填/);
  assert.equal(store.jobs().length, before);
});

test("UI shows missing predecessor warning and required input even while another node runs", t => {
  const { issue } = setup(t);
  const running = { ...completed(issue, "triage", "running"), result: undefined };
  const actions = availableActions(issue, running, [running]);
  const projection = { ...actions, primary: actions.stages.find(a => a.kind === "validate") };
  const markup = renderToStaticMarkup(React.createElement(AssistantActions, {
    issue, history: [running], busy: false, projected: projection,
    act: async () => {}, openEvidence: () => {},
  }));
  assert.match(markup, /独立执行节点/);
  assert.match(markup, /依赖节点/);
  assert.match(markup, /用户补充信息（必填）/);
  assert.match(markup, /aria-label="用户补充信息" required=""/);
  assert.match(markup, /disabled=""[^>]*>验证改动/);
  const supplied = renderToStaticMarkup(React.createElement(AssistantActions, {
    issue, history: [], busy: false, projected: projection, instructions: "Check queue ordering at the recorded checkout.",
    act: async () => {}, openEvidence: () => {},
  }));
  assert.doesNotMatch(supplied, /disabled=""[^>]*>验证改动/);
});
