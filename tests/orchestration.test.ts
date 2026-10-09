import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Store } from "../src/core/store.ts";
import { Workbench } from "../src/core/workbench.ts";
import { GitHub } from "../src/core/github.ts";
import { seedFixture, fixtureAnalysis } from "./support/fixtures.ts";
import { asAnalysis, artifactSchemas } from "../src/core/artifacts.ts";
import { git, collectPatch } from "../src/core/git.ts";
import { documentCheckCommand } from "../src/core/document-acceptance.ts";
import { planInputKey } from "../src/core/change-plan.ts";
import type { Issue, Job, Runner } from "../src/core/types.ts";
import { handler, localRejection } from "../src/server/http.ts";
const common = {
  schemaVersion: 1 as const,
  summary: "文档修改",
  coverage: "本次补丁",
  evidence: [],
  nextSteps: [],
  responseDraft: "",
};
const draft = {
  category: "docs" as const,
  goal: "补充使用说明",
  scope: "仅 README.md 的使用说明",
  reproduction: "",
  expected: "",
  actual: "",
  acceptanceCriteria: ["新增说明准确，无重复或失效链接"],
  route: "docs" as const,
  sources: [
    { field: "goal" as const, source: "README.md", detail: "明确的文档需求" },
  ],
  missingInfo: [],
};
function setup(github?: GitHub) {
  const store = new Store(":memory:");
  seedFixture(store);
  const wb = new Workbench(
    store,
    "/tmp/mw-orchestration-unit",
    async ({ issue, job }) => ({
      result: fixtureAnalysis(issue, job.kind),
      engine: "unit fixture",
    }),
    github,
    false,
  );
  const issue = store.issues()[0],
    repo = store.repos()[0];
  store.put("issues", {
    ...issue,
    orchestration: {
      draft: {
        ...draft,
        inputKey: planInputKey(issue, repo),
        generatedAt: new Date().toISOString(),
      },
    },
  });
  return { store, wb, issue: store.issues()[0], repo };
}
const accept = { ...draft, decision: "accepted" as const };

test("snapshot retains durable processing state alongside orchestration status", async () => {
  const { store, wb, issue } = setup();
  try {
    const wait = wb.processing.requestInput(issue.id, {
      reason: "明确文档预期",
      fields: [{ id: "expected", question: "期望哪项说明？" }],
    });
    const snapshot = wb.snapshot().issues[0];
    assert.equal(snapshot.processing?.id, store.processing.current(issue.id)?.id);
    assert.equal(snapshot.processing?.waits[0].id, wait.id);
    assert.equal(snapshot.orchestrationView?.status, "blocked");
    assert.throws(() => wb.orchestration.start(issue.id, issue.orchestration!.draft!.inputKey, accept), /补充输入/);
    assert.equal(store.jobs().length, 0);
  } finally { await wb.close(); }
});

test("waiting input preserves partial results and resumes within the same authorized workflow", async () => {
  const { store, wb, issue } = setup();
  try {
    wb.orchestration.start(issue.id, issue.orchestration!.draft!.inputKey, accept);
    const job = store.jobs()[0];
    store.put("jobs", { ...job, status: "waiting_input", result: fixtureAnalysis(issue, "docs"), patch: "partial patch" });
    const wait = wb.processing.requestInput(issue.id, {
      reason: "需要文档措辞",
      fields: [{ id: "wording", question: "使用哪项术语？" }],
    }, job.id);
    wb.orchestration.completed(store.jobs()[0]);
    assert.equal(store.jobs().length, 1);
    assert.equal(store.issues()[0].orchestration?.run?.status, "blocked");
    assert.deepEqual(store.issues()[0].orchestration?.run?.completedJobIds, []);
    wb.processing.submitInput(issue.id, wait.id, { wording: "完整使用说明" }, store.processing.current(issue.id)!.version);
    assert.equal(store.jobs().length, 1);
    const ready = store.issues()[0];
    store.put("issues", { ...ready, orchestration: { ...ready.orchestration, run: { ...ready.orchestration!.run!, deadlineAt: new Date(0).toISOString() } } });
    assert.throws(() => wb.resume(job.id), /预算/);
    assert.equal(store.jobs().length, 1);
    store.put("issues", ready);
    const resumed = wb.orchestration.resume(issue.id);
    const next = store.get<Job>("jobs", resumed.created[0])!;
    assert.equal(next.workflowRunId, job.workflowRunId);
    assert.equal(next.sourceJobId, job.id);
    assert.match(next.instructions!, /完整使用说明/);
    assert.equal(store.issues()[0].orchestration?.run?.currentJobId, next.id);
    wb.orchestration.completed(store.jobs()[0]);
    assert.equal(store.issues()[0].orchestration?.run?.status, "running");
    assert.equal(store.get<Job>("jobs", job.id)?.patch, "partial patch");
  } finally { await wb.close(); }
});

test("fresh confirmation renews the source binding even when the accepted plan is unchanged", async () => {
  const { store, wb, issue, repo } = setup();
  try {
    wb.orchestration.start(issue.id, issue.orchestration!.draft!.inputKey, accept);
    wb.orchestration.pause(issue.id, true);
    const old = store.issues()[0];
    const updated = { ...old, body: "补充了来源事实，计划范围不变", orchestration: { draft: { ...old.orchestration!.draft!, inputKey: "updated" } } };
    updated.orchestration.draft.inputKey = planInputKey(updated, repo);
    store.put("issues", updated);
    const result = wb.orchestration.start(issue.id, updated.orchestration.draft.inputKey, accept);
    assert.equal(result.created.length, 1);
    assert.equal(store.processing.current(issue.id)?.planSourceFingerprint, store.processing.current(issue.id)?.sourceFingerprint);
  } finally { await wb.close(); }
});

test("checkpoint recovery preserves confirmed feedback and never duplicates the queued execution", async () => {
  const { store, wb, issue } = setup();
  try {
    const first = wb.orchestration.start(issue.id, issue.orchestration!.draft!.inputKey, accept, undefined, undefined, "必须保留术语 A");
    const saved = store.issues()[0];
    store.put("issues", { ...saved, orchestration: { ...saved.orchestration, run: { ...saved.orchestration!.run!, currentJobId: undefined } } });
    wb.orchestration.reconcile();
    assert.equal(store.jobs().length, 1);
    assert.equal(store.issues()[0].orchestration?.run?.currentJobId, first.created[0]);
    assert.match(store.jobs()[0].instructions!, /必须保留术语 A/);
  } finally { await wb.close(); }
});

test("repository synchronization preserves orchestration and saved policy settings", async () => {
  const github = new GitHub("", async () => { throw new Error("Unexpected external request"); });
  const { store, wb, issue, repo } = setup(github);
  try {
    wb.orchestration.start(issue.id, issue.orchestration!.draft!.inputKey, accept);
    const runId = store.issues()[0].orchestration!.run!.id;
    wb.updatePolicy(repo.id, { autoTriage: false, autoReview: true, syncIntervalMinutes: 0, timeoutMs: 600000, maxTokens: 6000 });
    assert.equal(store.repos()[0].policy?.autoReview, true);
    wb.updateSettings({ ...store.settings(), autoReview: true });
    assert.equal(store.settings().autoReview, true);
    github.sync = async () => ({ repo: store.repos()[0], issues: [{ ...issue, body: "updated remotely" }] });
    await wb.sync(repo.fullName);
    assert.equal(store.issues()[0].orchestration?.run?.id, runId);
    assert.equal(store.issues()[0].orchestration?.run?.status, "blocked");
  } finally { await wb.close(); }
});

test("batch dispatch reports a blocked environment as an error without claiming a task was created", async () => {
  const { store, wb, issue, repo } = setup();
  try {
    const emptyRepo = { ...repo, mode: "local" as const, headSha: "" };
    store.put("repos", emptyRepo);
    const inputKey = planInputKey(issue, emptyRepo);
    store.put("issues", { ...issue, orchestration: { ...issue.orchestration, draft: { ...issue.orchestration!.draft!, inputKey } } });
    const result = wb.orchestration.startBatch([{ issueId: issue.id, inputKey, plan: accept }]);
    assert.match(result.results[0].error!, /无 Git 提交/);
    assert.ok("created" in result.results[0]);
    assert.equal(result.results[0].created?.length, 0);
    assert.equal(store.jobs().length, 0);
    assert.equal(store.issues()[0].orchestration?.run?.status, "blocked");
  } finally { await wb.close(); }
});

test("workflow HTTP actions honor durable version conflicts before changing authorization", async () => {
  const { store, wb, issue } = setup();
  const server = createServer(handler(wb, localRejection));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const version = issue.processing!.version;
    wb.decide(issue.id, "decision", "需要确认");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/maintainer/api/workflow/start`;
    const post = (expectedVersion: number) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issueId: issue.id, inputKey: issue.orchestration!.draft!.inputKey, plan: accept, expectedVersion }) });
    const obsolete = await post(version);
    assert.equal(obsolete.status, 409);
    assert.equal(store.jobs().length, 0);
    const response = await post(store.processing.current(issue.id)!.version);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).created.length, 1);
    assert.equal(store.issues()[0].orchestration?.run?.status, "running");
    const staleBatch = wb.orchestration.startBatch([{ issueId: issue.id, inputKey: issue.orchestration!.draft!.inputKey, plan: accept, expectedVersion: version }]);
    assert.match(staleBatch.results[0].error!, /状态已变化/);
    assert.equal(store.jobs().length, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await wb.close();
  }
});

test("reanalyzing a stopped plan archives its authorization and requires a fresh confirmation", async () => {
  const { store, wb, issue } = setup();
  try {
    wb.orchestration.start(
      issue.id,
      issue.orchestration!.draft!.inputKey,
      accept,
    );
    wb.orchestration.pause(issue.id, true);
    const oldRun = store.issues()[0].orchestration!.run!;
    wb.orchestration.analyze([issue.id], true);
    const job = store.jobs().find((j) => j.kind === "triage")!;
    const artifact = artifactSchemas.triage.parse({
      ...common,
      stage: "triage",
      category: "docs",
      priority: "P2",
      labels: [],
      module: "README",
      impact: "文档",
      missingInfo: [],
      duplicateOf: null,
      duplicateReason: "",
      route: "implement",
      routeReason: "重新整理文档计划",
      planDraft: draft,
    });
    const completed = {
      ...job,
      status: "completed" as const,
      artifact,
      result: asAnalysis(artifact),
    };
    store.put("jobs", completed);
    wb.orchestration.completed(completed);
    wb.orchestration.completed(completed);
    const next = store.issues()[0];
    assert.equal(next.orchestration?.run, undefined);
    assert.equal(next.orchestration?.previousRuns?.length, 1);
    assert.equal(next.orchestration?.previousRuns?.[0].id, oldRun.id);
    assert.equal(wb.orchestration.view(next)?.status, "plan");
    wb.orchestration.start(
      issue.id,
      next.orchestration!.draft!.inputKey,
      accept,
    );
    assert.equal(
      store.issues()[0].orchestration?.previousRuns?.[0].id,
      oldRun.id,
    );
    assert.notEqual(store.issues()[0].orchestration?.run?.id, oldRun.id);
  } finally {
    await wb.close();
  }
});

test("confirmation is idempotent and changed plans cannot overwrite a running authorization", async () => {
  const { store, wb, issue } = setup();
  try {
    const key = issue.orchestration!.draft!.inputKey;
    const first = wb.orchestration.start(issue.id, key, accept);
    assert.equal(first.created.length, 1);
    assert.deepEqual(wb.orchestration.start(issue.id, key, accept), {
      created: [],
      reused: first.created,
    });
    assert.throws(
      () =>
        wb.orchestration.start(issue.id, key, { ...accept, scope: "扩大范围" }),
      /正在执行/,
    );
    assert.equal(store.jobs().length, 1);
    assert.equal(store.issues()[0].orchestration?.run?.status, "running");
  } finally {
    await wb.close();
  }
});

test("stale materials reject confirmation and queued checkpoints never count as completed", async () => {
  const { store, wb, issue, repo } = setup();
  try {
    wb.orchestration.start(
      issue.id,
      issue.orchestration!.draft!.inputKey,
      accept,
    );
    wb.orchestration.reconcile();
    assert.equal(
      store.issues()[0].orchestration?.run?.completedJobIds.length,
      0,
    );
    assert.equal(store.jobs().length, 1);
    store.put("repos", { ...repo, headSha: "new" });
    assert.throws(
      () =>
        wb.orchestration.start(
          issue.id,
          issue.orchestration!.draft!.inputKey,
          accept,
        ),
      /变化/,
    );
    assert.equal(wb.snapshot().issues[0].orchestrationView?.status, "stale");
  } finally {
    await wb.close();
  }
});

test("cancellation stops the chain and retains task history", async () => {
  const { store, wb, issue } = setup();
  try {
    wb.orchestration.start(
      issue.id,
      issue.orchestration!.draft!.inputKey,
      accept,
    );
    wb.orchestration.pause(issue.id, true);
    assert.equal(store.jobs()[0].status, "cancelled");
    assert.equal(store.issues()[0].orchestration?.run?.status, "cancelled");
    wb.orchestration.completed(store.jobs()[0]);
    assert.equal(store.jobs().length, 1);
  } finally {
    await wb.close();
  }
});

test("interrupted running jobs are blocked on restart without replaying modifications", async () => {
  const { store, wb, issue } = setup();
  wb.orchestration.start(
    issue.id,
    issue.orchestration!.draft!.inputKey,
    accept,
  );
  store.put("jobs", { ...store.jobs()[0], status: "running" });
  const restarted = new Workbench(
    store,
    "/tmp/mw-orchestration-unit",
    undefined,
    undefined,
    false,
  );
  restarted.orchestration.reconcile();
  assert.equal(store.jobs().length, 1);
  assert.equal(store.jobs()[0].status, "failed");
  assert.equal(store.issues()[0].orchestration?.run?.status, "blocked");
  await restarted.close();
});

test("a persisted consumed implementation checkpoint schedules exactly one validation", async () => {
  const { store, wb, issue } = setup();
  try {
    wb.orchestration.start(
      issue.id,
      issue.orchestration!.draft!.inputKey,
      accept,
    );
    const j = store.jobs()[0];
    store.put("jobs", {
      ...j,
      status: "awaiting_review",
      patch: "patch",
      result: fixtureAnalysis(issue, "docs"),
    });
    const i = store.issues()[0],
      run = i.orchestration!.run!;
    store.put("issues", {
      ...i,
      orchestration: {
        ...i.orchestration,
        run: { ...run, completedJobIds: [j.id] },
      },
    });
    wb.orchestration.reconcile();
    wb.orchestration.reconcile();
    assert.deepEqual(
      store.jobs().map((j) => j.kind),
      ["docs", "validate"],
    );
  } finally {
    await wb.close();
  }
});

test("validation failure stays actionable and never dispatches a repair automatically", async () => {
  const { store, wb, issue } = setup();
  try {
    wb.orchestration.start(
      issue.id,
      issue.orchestration!.draft!.inputKey,
      accept,
    );
    let j = store.jobs()[0];
    store.put("jobs", {
      ...j,
      status: "awaiting_review",
      patch: "patch",
      result: fixtureAnalysis(issue, "docs"),
    });
    wb.orchestration.completed(store.jobs()[0]);
    j = store.jobs()[1];
    const artifact = artifactSchemas.validate.parse({
      ...common,
      stage: "validate",
      environment: "fixture",
      tests: [{ command: "check", status: "failed", output: "bad link" }],
      blockers: [],
    });
    store.put("jobs", {
      ...j,
      status: "completed",
      artifact,
      result: asAnalysis(artifact),
    });
    wb.orchestration.completed(store.jobs()[1]);
    assert.equal(store.jobs().length, 2);
    assert.equal(store.issues()[0].orchestration?.run?.status, "blocked");
    assert.match(store.issues()[0].orchestration!.run!.reason, /文档/);
  } finally {
    await wb.close();
  }
});

test("batch start reports per-item failures without making a failed item look started", async () => {
  const { store, wb, issue } = setup();
  try {
    const result = wb.orchestration.startBatch([
      {
        issueId: issue.id,
        inputKey: issue.orchestration!.draft!.inputKey,
        plan: accept,
      },
      { issueId: "missing", inputKey: "x", plan: accept },
    ]);
    assert.ok("created" in result.results[0]);
    assert.equal(result.results[0].created?.length, 1);
    assert.match(result.results[1].error!, /不存在|开放事项/);
    assert.equal(store.jobs().length, 1);
  } finally {
    await wb.close();
  }
});

test("author handoff waits for confirmed publication and reviews only a new head", async () => {
  const { store, wb, issue, repo } = setup();
  try {
    const pr = {
      ...issue,
      type: "pr" as const,
      headSha: "b".repeat(40),
      prBaseSha: repo.headSha,
    };
    store.put("issues", {
      ...pr,
      orchestration: {
        draft: {
          ...draft,
          route: "review",
          inputKey: planInputKey(pr, repo),
          generatedAt: new Date().toISOString(),
        },
      },
    });
    wb.orchestration.start(pr.id, planInputKey(pr, repo), accept, "review");
    let j = store.jobs()[0];
    assert.throws(() => wb.orchestration.waitAuthor(j.id), /发布/);
    j = {
      ...j,
      status: "approved",
      result: fixtureAnalysis(pr, "review"),
      prContext: {
        headSha: pr.headSha,
        baseSha: repo.headSha,
        headRef: "feature",
        baseRef: "main",
        headRepo: repo.fullName,
        draft: false,
        merged: false,
        mergeable: true,
        checks: [],
        reviews: [],
        warnings: [],
      },
      publications: {
        review: {
          status: "published",
          urls: ["fixture"],
          at: new Date().toISOString(),
        },
      },
    };
    store.put("jobs", j);
    wb.orchestration.completed(j);
    store.put("jobs", { ...j, workflowRunId: "previous-authorization" });
    assert.throws(() => wb.orchestration.waitAuthor(j.id), /当前计划/);
    assert.equal(store.issues()[0].orchestration?.run?.status, "review");
    store.put("jobs", j);
    wb.orchestration.waitAuthor(j.id);
    wb.orchestration.synced(repo.id);
    assert.equal(store.jobs().length, 1);
    const current = store.issues()[0];
    store.put("issues", { ...current, headSha: "c".repeat(40) });
    wb.orchestration.synced(repo.id);
    wb.orchestration.synced(repo.id);
    assert.equal(store.jobs().length, 2);
    assert.equal(store.jobs()[1].kind, "preflight");
    assert.equal(store.issues()[0].plan?.scope, accept.scope);
  } finally {
    await wb.close();
  }
});

test("explicit retry preserves authorization and resumes a failed current step without deleting history", async () => {
  const { store, wb, issue } = setup();
  try {
    wb.orchestration.start(
      issue.id,
      issue.orchestration!.draft!.inputKey,
      accept,
    );
    const first = store.jobs()[0];
    store.put("jobs", {
      ...first,
      status: "failed",
      error: "inspect workspace first",
    });
    wb.orchestration.completed(store.jobs()[0]);
    const result = wb.orchestration.retry(issue.id);
    assert.equal(result.created.length, 1);
    assert.equal(store.jobs().length, 2);
    assert.equal(store.jobs()[1].workflowRunId, first.workflowRunId);
    assert.equal(
      store.issues()[0].orchestration?.run?.currentJobId,
      result.created[0],
    );
    assert.equal(store.jobs()[0].status, "failed");
  } finally {
    await wb.close();
  }
});

test("repository read-only review policy requires a complete ready preflight and never authorizes modifications", async () => {
  const { store, wb, issue, repo } = setup();
  try {
    store.put("repos", {
      ...repo,
      policy: {
        autoTriage: false,
        autoReview: true,
        syncIntervalMinutes: 0,
        timeoutMs: 600000,
        maxTokens: 6000,
      },
    });
    const pr = {
      ...issue,
      type: "pr" as const,
      headSha: "b".repeat(40),
      prBaseSha: repo.headSha,
      orchestration: undefined,
    };
    store.put("issues", pr);
    const id = wb.enqueue([pr.id], "preflight").created[0],
      job = store.jobs()[0];
    const artifact = artifactSchemas.preflight.parse({
      ...common,
      stage: "preflight",
      intent: "review documented change",
      risks: [],
      readiness: "review",
      blockers: [],
      planDraft: { ...draft, route: "review" },
    });
    store.put("jobs", {
      ...job,
      status: "completed",
      artifact,
      result: asAnalysis(artifact),
    });
    wb.orchestration.completed(store.jobs()[0]);
    wb.orchestration.completed(store.jobs()[0]);
    assert.deepEqual(
      store.jobs().map((j) => j.kind),
      ["preflight", "review"],
    );
    assert.equal(store.issues()[0].orchestration?.run?.route, "review");
    assert.ok(store.jobs().every((j) => !j.publications));
  } finally {
    await wb.close();
  }
});

test("document plan runs real git changes and document checks continuously then stops for final review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mw-doc-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, [
    "remote",
    "add",
    "origin",
    "https://github.com/fixture/queue.git",
  ]);
  await writeFile(
    join(root, "README.md"),
    "# Fixture\n\n## Usage\n\nExisting instructions.\n",
  );
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "base",
  ]);
  const sha = await git(root, ["rev-parse", "HEAD"]);
  const store = new Store(":memory:");
  seedFixture(store);
  const repo = store.repos()[0];
  store.put("repos", { ...repo, localPath: root, headSha: sha });
  const issue = store.issues()[0];
  store.put("issues", { ...issue, body: "在 README 使用说明加入文档提示。" });
  const calls: string[] = [];
  const runner: Runner = async ({ job, issue, progress, recordExecution }) => {
    calls.push(job.kind);
    const artifact =
      job.kind === "triage"
        ? artifactSchemas.triage.parse({
            ...common,
            stage: "triage",
            category: "docs",
            priority: "P2",
            labels: [],
            module: "README",
            impact: "文档",
            missingInfo: [],
            duplicateOf: null,
            duplicateReason: "",
            route: "implement",
            routeReason: "明确文档修改",
            planDraft: draft,
          })
        : job.kind === "docs"
          ? artifactSchemas.docs.parse({
              ...common,
              stage: "docs",
              changes: ["追加使用说明"],
              acceptanceCriteria: draft.acceptanceCriteria,
              limitations: [],
              tests: [],
            })
          : job.kind === "validate"
            ? artifactSchemas.validate.parse({
                ...common,
                stage: "validate",
                environment: "local fixture",
                tests: [],
                blockers: [],
              })
            : artifactSchemas.review.parse({
                ...common,
                stage: "review",
                findings: [],
                verdict: "no_findings",
                blockers: [],
              });
    if (job.kind === "docs")
      await writeFile(
        join(job.worktree!, "README.md"),
        "# Fixture\n\n## Usage\n\nExisting instructions.\n\nNew documentation guidance.\n",
      );
    if (job.kind === "validate") {
      const session = "fixture-validation-" + job.id;
      progress("run document checks", session);
      const command = documentCheckCommand(job);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          resolve("scripts/verify-document-patch.mjs"),
          job.worktree!,
          job.baseSha,
        ],
        { cwd: job.worktree },
      );
      const patch = await collectPatch(job.worktree!, job.baseSha);
      recordExecution?.(
        {
          id: session + ":1",
          sessionId: session,
          callId: "1",
          tool: "bash",
          command,
          cwd: job.worktree!,
          checkoutSha: job.baseSha,
          patchHash: createHash("sha256").update(patch).digest("hex"),
          exitCode: 0,
          isError: false,
          recordedAt: new Date().toISOString(),
          output: stdout,
          truncated: false,
        },
        stdout,
      );
    }
    return {
      artifact,
      result: asAnalysis(artifact),
      engine: "deterministic orchestration fixture",
    };
  };
  const wb = new Workbench(store, join(root, "data"), runner, undefined, true);
  t.after(() => wb.close());
  wb.orchestration.analyze([issue.id]);
  await wb.drain();
  const current = store.issues()[0];
  assert.equal(current.orchestration?.draft?.goal, draft.goal);
  wb.orchestration.start(
    issue.id,
    current.orchestration!.draft!.inputKey,
    accept,
  );
  await wb.drain();
  assert.deepEqual(
    calls,
    ["triage", "docs", "validate", "review"],
    JSON.stringify({
      jobs: store
        .jobs()
        .map((j) => ({ kind: j.kind, error: j.error, status: j.status })),
      state: store.issues()[0].orchestration,
    }),
  );
  assert.equal(
    store.issues()[0].orchestration?.run?.status,
    "review",
    JSON.stringify(
      store
        .jobs()
        .map((j) => ({ kind: j.kind, status: j.status, error: j.error })),
    ),
  );
  assert.equal(
    store.jobs().filter((j) => j.kind === "validate")[0].artifact?.stage,
    "validate",
  );
  assert.equal(
    store.jobs().find((j) => j.kind === "validate")?.result?.tests[0].status,
    "passed",
  );
  assert.ok(store.jobs().find((j) => j.kind === "docs")?.patch);
  assert.ok(store.jobs().every((j) => !j.publications));
});
