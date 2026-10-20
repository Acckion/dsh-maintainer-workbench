import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.ts";
import { Workbench, revision } from "../src/core/workbench.ts";
import { processingTimeline } from "../src/application/timeline.ts";
import {
  defaultPlan,
  issueTaskGuidance,
  planBlocker,
} from "../src/core/issue-flow.ts";
import { stepResolved } from "../src/workflow/manual.ts";
import { validationAcceptance } from "../src/core/validation-acceptance.ts";
import { seedFixture, fixtureAnalysis } from "./support/fixtures.ts";
import type { Issue, Job } from "../src/core/types.ts";
import { availableActions } from "../src/workflow/actions.ts";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "mw-manual-")),
    db = join(root, "store.sqlite");
  const store = new Store(db);
  seedFixture(store);
  const item = store.issues()[0];
  store.put("issues", { ...item, analysis: fixtureAnalysis(item, "triage") });
  const wb = new Workbench(
    store,
    root,
    async ({ issue, job }) => ({
      result: fixtureAnalysis(issue, job.kind),
      engine: "test",
    }),
    undefined,
    false,
  );
  t.after(async () => {
    await wb.close();
    await rm(root, { recursive: true, force: true });
  });
  const itemNow = () => store.get<Issue>("issues", item.id)!;
  const submit = (
    stage: string,
    mode: string,
    text = "",
    requestId = crypto.randomUUID(),
    expectedVersion = itemNow().processing!.version,
  ) =>
    wb.manualSteps.submit({
      issueId: item.id,
      caseId: itemNow().processing!.id,
      stage,
      mode,
      text,
      requestId,
      expectedVersion,
    });
  return { store, wb, item: itemNow, submit, root };
}

test("skip and free text are authoritative without required scope fields, survive restart and source updates", async (t) => {
  const f = await setup(t);
  f.submit("triage", "skip");
  f.submit("investigate", "complete", "  根因已查明。只改解析器，不再复现。\n");
  const current = f.item(),
    state = current.processing!;
  assert.equal(state.manualCursor, "fix");
  assert.equal(planBlocker(current, "fix"), undefined);
  assert.equal(
    state.manualSteps!.at(-1)!.text,
    "  根因已查明。只改解析器，不再复现。\n",
  );
  const fix = f.wb.enqueue([current.id], "fix").created[0];
  assert.match(f.store.get<Job>("jobs", fix)!.instructions!, /只改解析器/);
  assert.throws(
    () => f.wb.enqueue([current.id], "investigate"),
    /用户已跳过或手动完成/,
  );
  f.wb.cancel(fix);
  f.store.put("issues", { ...f.item(), updatedAt: "2026-10-12T00:00:00Z" });
  assert.equal(stepResolved(f.item().processing, "investigate"), true);
  assert.match(issueTaskGuidance(f.item()), /authoritative/);
  const second = new Store(join(f.root, "store.sqlite"));
  assert.equal(
    second.processing.current(current.id)!.manualSteps!.at(-1)!.text,
    state.manualSteps!.at(-1)!.text,
  );
  second.close();
});

test("takeover cancels only relevant runs and waits, late output and input cannot undo manual completion", async (t) => {
  const f = await setup(t);
  f.submit("triage", "skip");
  const id = f.wb.enqueue([f.item().id], "investigate").created[0];
  const wait = f.wb.processing.requestInput(
    f.item().id,
    {
      reason: "Need reproduction",
      fields: [{ id: "repro", question: "Reproduce?" }],
    },
    id,
  );
  const previous = f.store.get<Job>("jobs", id)!;
  f.submit("investigate", "takeover");
  assert.equal(f.store.get<Job>("jobs", id)!.status, "cancelled");
  assert.equal(
    f.item().processing!.waits.find((w) => w.id === wait.id)!.state,
    "cancelled",
  );
  f.submit("investigate", "complete", "已人工定位，继续");
  f.store.put("jobs", {
    ...previous,
    status: "completed",
    result: fixtureAnalysis(f.item(), "investigate"),
  });
  f.wb.orchestration.completed(f.store.get<Job>("jobs", id)!);
  assert.equal(f.item().processing!.manualCursor, "fix");
  assert.equal(f.item().processing!.currentRunId, undefined);
  f.store.processing.dispatch(
    f.item().id,
    {
      type: "input.requested",
      wait: { ...wait, id: "late-input", state: "open" },
    },
    "agent",
    "late-input",
  );
  assert.equal(
    f
      .item()
      .processing!.waits.some(
        (w) => w.id === "late-input" && w.state === "open",
      ),
    false,
  );
});

test("supplement preserves raw text without cancelling; retries are idempotent and stale phase targets are rejected", async (t) => {
  const f = await setup(t);
  const id = f.wb.enqueue([f.item().id], "triage").created[0];
  const version = f.item().processing!.version;
  f.store.audit("test", "parallel update");
  const requestId = crypto.randomUUID();
  f.submit("triage", "supplement", "  不要修改接口。\n", requestId, version);
  assert.equal(f.store.get<Job>("jobs", id)!.status, "queued");
  f.submit("triage", "supplement", "  不要修改接口。\n", requestId, version);
  assert.equal(f.item().processing!.manualSteps!.length, 1);
  assert.throws(
    () => f.submit("triage", "supplement", "different", requestId),
    /另一项决定/,
  );
  f.submit("triage", "skip");
  f.submit("investigate", "skip");
  assert.throws(() => f.submit("triage", "complete", "late"), /目标阶段已变化/);
  assert.equal(f.item().processing!.manualCursor, "fix");
});

test("all stages accept manual results and skip, no patch or executed test is fabricated; explicit reopen restores the stage", async (t) => {
  const f = await setup(t);
  for (const stage of ["triage", "investigate", "fix", "validate", "review"])
    f.submit(stage, "skip");
  assert.equal(f.item().processing!.manualCursor, "track");
  assert.equal(f.store.jobs().length, 0);
  f.submit("validate", "reopen");
  assert.equal(stepResolved(f.item().processing, "validate"), false);
  assert.equal(f.item().processing!.manualCursor, "validate");
  f.submit("validate", "complete", "我本地检查过，可以继续");
  assert.equal(f.item().processing!.manualCursor, "review");
  assert.equal(f.store.jobs().length, 0);
  f.submit("review", "complete", "人工审核完毕");
  f.submit("track", "complete", "已自行交付");
  assert.equal(f.item().processing!.lifecycle, "completed");
  assert.equal(f.item().state, "open");
  assert.equal(f.item().merged, undefined);
});

test("Bug timeline merges diagnosis and scope, preserves attempts and current confirmation; PR decision stays separate", async (t) => {
  const f = await setup(t);
  f.submit("triage", "skip");
  const id = f.wb.enqueue([f.item().id], "investigate").created[0],
    job = f.store.get<Job>("jobs", id)!;
  f.store.put("jobs", {
    ...job,
    status: "completed",
    result: fixtureAnalysis(f.item(), "investigate"),
  });
  const view = processingTimeline(f.store, f.item().id);
  assert.equal(
    view.nodes.find((n) => n.id === view.currentNodeId)!.label,
    "定位与范围",
  );
  assert.equal(
    view.nodes.find((n) => n.id === view.currentNodeId)!.scopeConfirmation,
    true,
  );
  assert.equal(
    view.nodes.some((n) => n.stage === "decision"),
    false,
  );
  assert.ok(
    view.nodes.find((n) => n.stage === "investigate")!.attemptIds.includes(id),
  );
  const pr = f.store.issues()[1];
  f.store.put("issues", { ...pr, type: "pr" });
  assert.ok(
    processingTimeline(f.store, pr.id).nodes.some(
      (n) => n.stage === "decision",
    ),
  );
});

test("manual validation bypasses failed validation acceptance without changing its recorded outcome", async (t) => {
  const f = await setup(t);
  f.submit("triage", "skip");
  f.submit("investigate", "skip");
  f.submit("fix", "complete", "已手动完成修改");
  const base: Job = {
    id: "impl",
    repoId: f.item().repoId,
    issueId: f.item().id,
    issueSnapshot: f.item(),
    kind: "fix",
    status: "awaiting_review",
    revision: revision(f.item(), f.store.repos()[0], "fix"),
    baseSha: f.store.repos()[0].headSha,
    caseId: f.item().processing!.id,
    patch: "actual patch",
    result: fixtureAnalysis(f.item(), "fix"),
    attempt: 1,
    createdAt: "2026-10-11",
    updatedAt: "2026-10-11",
  };
  const check: Job = {
    ...base,
    id: "failed-check",
    kind: "validate",
    status: "failed",
    sourceJobId: base.id,
    createdAt: "2026-10-12",
    error: "environment failure",
  };
  assert.equal(validationAcceptance(base, [check]).allowed, false);
  f.submit("validate", "skip");
  assert.equal(
    validationAcceptance({ ...base, issueSnapshot: f.item() }, [check]).allowed,
    true,
  );
  assert.equal(check.status, "failed");
  assert.equal(check.artifact, undefined);
});

test("manual completion resumes an explicitly authorized goal after takeover, without reviving the cancelled investigation", async (t) => {
  const f = await setup(t);
  f.submit("triage", "skip");
  const investigation = f.wb.enqueue([f.item().id], "investigate", {
    goal: "resolve",
    goalId: "resolve-owned",
  }).created[0];
  f.submit("investigate", "takeover");
  f.submit("investigate", "complete", "只修改解析器，我来处理复现。");
  const fix = f.store.jobs().find((j) => j.kind === "fix")!;
  assert.ok(fix);
  assert.equal(fix.goal, "resolve");
  assert.equal(fix.goalId, "resolve-owned");
  assert.equal(f.store.get<Job>("jobs", investigation)!.status, "cancelled");
  assert.match(fix.instructions!, /只修改解析器/);
  assert.equal(fix.sourceJobId, undefined);
  assert.equal(f.item().processing!.currentRunId, fix.id);
});

test("manual completion resumes the existing authorized plan with the original run identity", async (t) => {
  const f = await setup(t);
  f.submit("triage", "skip");
  const current = f.item();
  const { planInputKey } = await import("../src/core/change-plan.ts");
  const plan = { ...defaultPlan(current), decision: "accepted" as const };
  const run = {
    id: "authorized-run",
    caseId: current.processing!.id,
    inputKey: planInputKey(current, f.store.repos()[0]),
    planVersion: "p1",
    plan,
    route: "investigate" as const,
    status: "running" as const,
    completedJobIds: [],
    reason: "authorized",
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    maxSteps: 6,
  };
  f.store.put("issues", { ...current, plan, orchestration: { run } });
  const id = f.wb.enqueue([current.id], "investigate", {
    workflowRunId: run.id,
  }).created[0];
  f.submit("investigate", "takeover");
  f.submit("investigate", "complete", "根因和范围已确定，继续修复");
  const fix = f.store.jobs().find((j) => j.kind === "fix")!;
  assert.equal(fix.workflowRunId, run.id);
  assert.equal(f.item().orchestration!.run!.currentJobId, fix.id);
  assert.equal(f.item().orchestration!.run!.status, "running");
  assert.equal(f.store.get<Job>("jobs", id)!.status, "cancelled");
});

test("cancellation failure cannot reject the saved decision or let a revoked queued task execute", async (t) => {
  const f = await setup(t);
  const id = f.wb.enqueue([f.item().id], "triage").created[0];
  const cancel = f.wb.cancel.bind(f.wb);
  f.wb.cancel = () => {
    throw new Error("executor cleanup failed");
  };
  const result = f.submit("triage", "skip");
  assert.equal(result.ok, true);
  assert.match(result.cleanupWarnings![0], /已生效/);
  assert.equal(f.item().processing!.manualCursor, "investigate");
  f.wb.pump();
  await f.wb.drain();
  assert.equal(f.store.get<Job>("jobs", id)!.status, "queued");
  assert.equal(f.store.get<Job>("jobs", id)!.result, undefined);
  f.wb.cancel = cancel;
});

test("a concurrent source update preserves both the user decision and the originally viewed source version", async (t) => {
  const f = await setup(t);
  f.submit("triage", "skip");
  const original = f.item().processing!;
  f.store.put("issues", { ...f.item(), updatedAt: "2026-10-13T00:00:00Z" });
  const result = f.wb.manualSteps.submit({
    issueId: f.item().id,
    caseId: original.id,
    stage: "investigate",
    mode: "complete",
    text: "按我给出的结论继续，不重新复现",
    requestId: "source-race",
    expectedVersion: original.version,
    sourceFingerprint: original.sourceFingerprint,
  });
  assert.equal(result.ok, true);
  assert.equal(
    f.item().processing!.manualSteps!.at(-1)!.sourceFingerprint,
    original.sourceFingerprint,
  );
  assert.notEqual(
    f.item().processing!.sourceFingerprint,
    original.sourceFingerprint,
  );
  assert.equal(f.item().processing!.manualCursor, "fix");
  assert.match(result.cleanupWarnings![0], /决定仍生效/);
});


test("skipped validation advances the primary action to patch review", () => {
  const issue = {
    id: "i1", type: "issue", state: "open",
    plan: { decision: "accepted", category: "bug", goal: "g", acceptanceCriteria: ["a"], reproductionMode: "optional" },
    analysis: { category: "bug" },
    processing: {
      id: "c1", workItemId: "i1", version: 3, phase: "review", lifecycle: "waiting",
      sourceFingerprint: "fp", manualCursor: "validate",
      manualSteps: [
        { id: "s3", stage: "fix", mode: "complete", actor: "user", at: "t", runIds: [] },
        { id: "s4", stage: "validate", mode: "skip", actor: "user", at: "t", runIds: [] },
      ],
      revokedRunIds: [], activeRunIds: [], currentRunId: undefined, waits: [],
    },
  } as unknown as Issue;
  const fix = {
    id: "impl", issueId: "i1", caseId: "c1", kind: "fix", status: "awaiting_review",
    patch: "diff", result: { stage: "fix" }, artifactState: "fresh",
    attempt: 1, createdAt: "2026-10-11", updatedAt: "2026-10-11",
  } as unknown as Job;
  const actions = availableActions(issue, fix, [fix]);
  assert.equal(actions.primary?.kind, "review");
  assert.equal(actions.primary?.enabled, true);
  assert.equal(actions.stages.find((s) => s.kind === "review")?.enabled, true);
  assert.match(String(actions.stages.find((s) => s.kind === "validate")?.blockedReasons[0]), /已跳过/);
});