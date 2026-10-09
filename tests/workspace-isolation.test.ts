import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { artifactSchemas, asAnalysis } from "../src/core/artifacts.ts";
import { git } from "../src/core/git.ts";
import { GitHub } from "../src/core/github.ts";
import { Store } from "../src/core/store.ts";
import type { Issue, Job, Runner } from "../src/core/types.ts";
import { Workbench } from "../src/core/workbench.ts";
import { WorkspaceManager } from "../src/infrastructure/git/workspace-manager.ts";
import { fixtureAnalysis, seedFixture } from "./support/fixtures.ts";

async function fixture(t: TestContext, runner: Runner) {
  const dir = await mkdtemp(join(tmpdir(), "mw-isolation-")),
    path = join(dir, "repo");
  await mkdir(path);
  await git(path, ["init", "-b", "main"]);
  await git(path, [
    "remote",
    "add",
    "origin",
    "https://github.com/fixture/queue.git",
  ]);
  await writeFile(join(path, "value.txt"), "baseline\n");
  await git(path, ["add", "."]);
  await git(path, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "baseline",
  ]);
  const sha = await git(path, ["rev-parse", "HEAD"]),
    store = new Store(":memory:");
  seedFixture(store);
  store.put("repos", { ...store.repos()[0], headSha: sha, localPath: path });
  const gh = new GitHub("", async () => Response.json({ sha })),
    w = new Workbench(store, dir, runner, gh, false);
  t.after(async () => {
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, path, store, w };
}

test("concurrent changes to the same path never mix worktrees, indexes, or frozen snapshots", async (t) => {
  const seen: Job[] = [];
  let release!: () => void;
  const both = new Promise<void>((r) => (release = r));
  const f = await fixture(t, async ({ job, issue }) => {
    seen.push(job);
    if (seen.length === 2) release();
    await both;
    await writeFile(
      join(job.worktree!, "value.txt"),
      `issue-${issue.number}\n`,
    );
    await writeFile(join(job.worktree!, "added.txt"), `new-${issue.number}\n`);
    return { result: fixtureAnalysis(issue, "fix"), engine: "local fixture" };
  });
  f.w.enqueue(
    f.store
      .issues()
      .slice(0, 2)
      .map((i) => i.id),
    "fix",
  );
  f.w.pump();
  await f.w.drain();
  assert.equal(new Set(seen.map((j) => j.worktree)).size, 2);
  assert.equal(new Set(seen.map((j) => j.branch)).size, 2);
  assert.equal(await readFile(join(f.path, "value.txt"), "utf8"), "baseline\n");
  assert.equal(await git(f.path, ["status", "--porcelain"]), "");
  const manager = new WorkspaceManager(f.store, f.dir);
  for (const job of f.store.jobs()) {
    assert.equal(job.status, "awaiting_review", job.error);
    assert.match(job.patch!, new RegExp(`issue-${job.issueSnapshot.number}`));
    assert.doesNotMatch(
      job.patch!,
      new RegExp(`issue-${job.issueSnapshot.number === 128 ? 131 : 128}`),
    );
    const snapshot = manager.snapshot(job.id)!;
    assert.ok(snapshot.resultTreeHash);
    assert.match(
      (await manager.patchFor(job))!,
      new RegExp(`new-${job.issueSnapshot.number}`),
    );
  }
  assert.ok(manager.records().every((record) => record.status === "retained"));
});

test("immutable handoff reconstructs the exact tree and rejects a corrupted snapshot", async (t) => {
  const f = await fixture(t, async ({ job, issue }) => {
    if (job.kind === "fix")
      await writeFile(join(job.worktree!, "value.txt"), "after\n");
    else
      assert.equal(
        await readFile(join(job.worktree!, "value.txt"), "utf8"),
        "after\n",
      );
    return {
      result: fixtureAnalysis(issue, job.kind),
      engine: "local fixture",
    };
  });
  const id = f.w.enqueue([f.store.issues()[0].id], "fix").created[0];
  f.w.pump();
  await f.w.drain();
  const validation = f.w.enqueue([f.store.issues()[0].id], "validate", {
    sourceJobId: id,
  }).created[0];
  f.w.pump();
  await f.w.drain();
  const manager = new WorkspaceManager(f.store, f.dir),
    original = manager.snapshot(id)!,
    verified = manager.snapshot(validation)!;
  assert.equal(original.resultTreeHash, verified.resultTreeHash);
  assert.equal(verified.parentId, original.id);
  await writeFile(original.patchPath, "corrupted\n");
  await assert.rejects(
    manager.patchFor(f.store.get<Job>("jobs", id)!),
    /快照|冻结补丁/,
  );
});

test("interrupted workspace ownership cannot be reclaimed for formatting recovery", async (t) => {
  const f = await fixture(t, async ({ job, issue }) => ({
    result: fixtureAnalysis(issue, job.kind),
    engine: "local fixture",
  }));
  const manager = new WorkspaceManager(f.store, f.dir),
    issue = f.store.issues()[0];
  const job = {
    id: "interrupted-run",
    caseId: issue.processing?.id,
    kind: "fix",
    issueId: issue.id,
    repoId: issue.repoId,
    issueSnapshot: issue,
    baseSha: f.store.repos()[0].headSha,
  } as Job;
  const workspace = await manager.prepare(f.store.repos()[0], job);
  const restarted = new WorkspaceManager(f.store, f.dir);
  assert.equal(restarted.records()[0].status, "interrupted");
  await assert.rejects(
    restarted.acquireFormatRecovery({
      ...job,
      id: "format-retry",
      worktree: workspace.path,
    }),
    /被占用|不明确/,
  );
  await assert.rejects(restarted.prepare(f.store.repos()[0], job), /已存在/);
  assert.equal(
    await readFile(join(workspace.path, "value.txt"), "utf8"),
    "baseline\n",
  );
});

test("format recovery accepts an aliased data root but rejects a substituted worktree leaf", async (t) => {
  const f = await fixture(t, async ({ job, issue }) => ({
    result: fixtureAnalysis(issue, job.kind), engine: "fixture",
  }));
  const alias = f.dir + "-alias";
  await symlink(f.dir, alias, "dir");
  t.after(() => rm(alias, { force: true }));
  const manager = new WorkspaceManager(f.store, alias), issue = f.store.issues()[0];
  const job = { id: "alias-run", kind: "fix", issueId: issue.id,
    repoId: issue.repoId, issueSnapshot: issue, baseSha: f.store.repos()[0].headSha } as Job;
  const workspace = await manager.prepare(f.store.repos()[0], job);
  manager.release(job);
  const retry = { ...job, id: "alias-retry", worktree: workspace.path };
  await manager.acquireFormatRecovery(retry);
  assert.equal(manager.records()[0].ownerRunId, retry.id);
  manager.release(retry);
  await rename(workspace.path, workspace.path + ".original");
  await symlink(f.path, workspace.path, "dir");
  await assert.rejects(manager.acquireFormatRecovery(retry), /所有权|管理范围/);
  assert.equal(await readFile(join(f.path, "value.txt"), "utf8"), "baseline\n");
});

test("legacy workspace migration registers only task directories managed by this data directory", async (t) => {
  const f = await fixture(t, async ({ job, issue }) => ({
    result: fixtureAnalysis(issue, job.kind),
    engine: "fixture",
  }));
  const issue = f.store.issues()[0],
    repo = f.store.repos()[0];
  const base: Job = {
    id: "legacy-run",
    repoId: repo.id,
    issueId: issue.id,
    issueSnapshot: issue,
    revision: "old",
    baseSha: repo.headSha,
    kind: "fix",
    status: "failed",
    attempt: 1,
    createdAt: "now",
    updatedAt: "now",
    worktree: join(f.dir, "worktrees", "legacy-run"),
    branch: "maintainer/fix-128-legacy",
  };
  f.store.put("jobs", base);
  f.store.put("jobs", {
    ...base,
    id: "foreign-run",
    worktree: join(f.dir, "foreign", "foreign-run"),
  });
  const manager = new WorkspaceManager(f.store, f.dir);
  assert.equal(manager.records().length, 1);
  assert.equal(manager.records()[0].ownerRunId, base.id);
  assert.equal(manager.records()[0].status, "retained");
  assert.equal(new WorkspaceManager(f.store, f.dir).records().length, 1);
});

test("continuing after user input rebuilds a partial patch in a fresh worktree", async (t) => {
  const runs: Job[] = [];
  const f = await fixture(t, async ({ job }) => {
    runs.push(job);
    if (runs.length === 1) {
      await writeFile(join(job.worktree!, "value.txt"), "partial\n");
    } else {
      assert.equal(
        await readFile(join(job.worktree!, "value.txt"), "utf8"),
        "partial\n",
      );
      assert.match(job.instructions ?? "", /Keep queue order/);
      await writeFile(join(job.worktree!, "value.txt"), "finished\n");
    }
    const artifact = artifactSchemas.fix.parse({
      schemaVersion: 1,
      stage: "fix",
      summary: "Fixture change",
      coverage: "value.txt",
      evidence: [],
      nextSteps: [],
      responseDraft: "",
      changes: ["Update value"],
      acceptanceCriteria: [],
      limitations: [],
      tests: [],
      ...(runs.length === 1
        ? {
            inputRequest: {
              reason: "Confirm queue order",
              fields: [
                { id: "behavior", question: "Expected queue behavior?" },
              ],
            },
          }
        : {}),
    });
    return { artifact, result: asAnalysis(artifact), engine: "local fixture" };
  });
  const issue = f.store.issues()[0],
    id = f.w.enqueue([issue.id], "fix").created[0];
  f.w.pump();
  await f.w.drain();
  const waiting = f.store.get<Job>("jobs", id)!;
  assert.equal(waiting.status, "waiting_input");
  const state = f.store.processing.current(issue.id)!,
    wait = state.waits.find((w) => w.type === "user_input")!;
  f.w.processing.submitInput(
    issue.id,
    wait.id,
    { behavior: "Keep queue order" },
    state.version,
  );
  const continued = f.w.resume(id).created[0];
  f.w.pump();
  await f.w.drain();
  const finished = f.store.get<Job>("jobs", continued)!;
  assert.equal(finished.status, "awaiting_review", finished.error);
  assert.notEqual(finished.worktree, waiting.worktree);
  assert.equal(
    await readFile(join(waiting.worktree!, "value.txt"), "utf8"),
    "partial\n",
  );
  assert.equal(await readFile(join(f.path, "value.txt"), "utf8"), "baseline\n");
  const manager = new WorkspaceManager(f.store, f.dir);
  assert.equal(manager.snapshot(continued)?.parentId, manager.snapshot(id)?.id);
});

test("cleanup removes an ended directory but preserves its branch, snapshot and execution evidence", async (t) => {
  const f = await fixture(t, async ({ job, issue }) => {
    await writeFile(join(job.worktree!, "value.txt"), "preserved\n");
    return { result: fixtureAnalysis(issue, "fix"), engine: "fixture" };
  });
  const issue = f.store.issues()[0],
    id = f.w.enqueue([issue.id], "fix").created[0];
  f.w.pump();
  await f.w.drain();
  const job = f.store.get<Job>("jobs", id)!;
  const blocked = await f.w.workspaces.inspect(id);
  assert.ok(blocked.cleanupReasons.length);
  await assert.rejects(f.w.workspaces.cleanup(id, blocked.stamp), /等待|交付/);
  f.store.put("issues", {
    ...f.store.get<Issue>("issues", issue.id)!,
    state: "closed",
  });
  const preview = await f.w.workspaces.inspect(id);
  assert.deepEqual(preview.cleanupReasons, []);
  await f.w.workspaces.cleanup(id, preview.stamp);
  assert.equal(
    f.w.workspaces.list().find((w) => w.id === id)!.status,
    "removed",
  );
  await assert.rejects(readFile(join(job.worktree!, "value.txt")), {
    code: "ENOENT",
  });
  assert.equal(await git(f.path, ["rev-parse", job.branch!]), job.baseSha);
  const manager = new WorkspaceManager(f.store, f.dir);
  assert.match((await manager.patchFor(job))!, /preserved/);
  assert.equal(f.store.get<Job>("jobs", id)!.patch, job.patch);
});

test("cleanup rejects patch drift and a stale preview without deleting new work", async (t) => {
  const f = await fixture(t, async ({ issue, job }) => ({
    result: fixtureAnalysis(issue, job.kind),
    engine: "fixture",
  }));
  const id = f.w.enqueue([f.store.issues()[0].id], "investigate").created[0];
  f.w.pump();
  await f.w.drain();
  const job = f.store.get<Job>("jobs", id)!;
  const preview = await f.w.workspaces.inspect(id);
  assert.deepEqual(preview.cleanupReasons, []);
  await writeFile(join(job.worktree!, "unrecorded.txt"), "new user work\n");
  await assert.rejects(f.w.workspaces.cleanup(id, preview.stamp), /变化/);
  assert.equal(
    await git(job.worktree!, ["diff", "--cached", "--name-only"]),
    "",
  );
  const drift = await f.w.workspaces.inspect(id);
  assert.ok(drift.cleanupReasons.some((r) => r.includes("额外变更")));
  await assert.rejects(f.w.workspaces.cleanup(id, drift.stamp), /额外变更/);
  assert.equal(
    await readFile(join(job.worktree!, "unrecorded.txt"), "utf8"),
    "new user work\n",
  );
});

test("interrupted ownership requires confirmed shutdown and does not replay Agent execution", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    throw Error("Fixture crash");
  });
  const id = f.w.enqueue([f.store.issues()[0].id], "investigate").created[0];
  f.w.pump();
  await f.w.drain();
  const manager = new WorkspaceManager(f.store, f.dir);
  manager.setStatus(id, "in_use");
  new WorkspaceManager(f.store, f.dir);
  const preview = await f.w.workspaces.inspect(id);
  assert.deepEqual(preview.recoveryReasons, []);
  await assert.rejects(
    f.w.workspaces.recover(id, preview.stamp, false),
    /停止/,
  );
  await f.w.workspaces.recover(id, preview.stamp, true);
  assert.equal(calls, 1);
  assert.equal(
    f.w.workspaces.list().find((w) => w.id === id)!.status,
    "retained",
  );
  const released = await f.w.workspaces.inspect(id);
  await f.w.workspaces.cleanup(id, released.stamp);
  assert.equal(calls, 1);
});

test("restart reconciles removal completed before the durable cleanup receipt", async (t) => {
  const f = await fixture(t, async ({ issue, job }) => ({
    result: fixtureAnalysis(issue, job.kind),
    engine: "fixture",
  }));
  const id = f.w.enqueue([f.store.issues()[0].id], "investigate").created[0];
  f.w.pump();
  await f.w.drain();
  const job = f.store.get<Job>("jobs", id)!,
    manager = new WorkspaceManager(f.store, f.dir);
  manager.setStatus(id, "cleaning");
  await git(f.path, ["worktree", "remove", "--force", job.worktree!]);
  new WorkspaceManager(f.store, f.dir);
  const preview = await f.w.workspaces.inspect(id);
  assert.equal(preview.removalCompleted, true);
  assert.deepEqual(preview.recoveryReasons, []);
  await f.w.workspaces.recover(id, preview.stamp, true);
  assert.equal(
    f.w.workspaces.list().find((w) => w.id === id)!.status,
    "removed",
  );
  assert.equal(await git(f.path, ["rev-parse", job.branch!]), job.baseSha);
});

test("a substituted worktree symlink never permits inspecting or deleting the user checkout", async (t) => {
  const f = await fixture(t, async ({ issue, job }) => ({
    result: fixtureAnalysis(issue, job.kind),
    engine: "fixture",
  }));
  const id = f.w.enqueue([f.store.issues()[0].id], "investigate").created[0];
  f.w.pump();
  await f.w.drain();
  const job = f.store.get<Job>("jobs", id)!;
  await rename(job.worktree!, job.worktree! + ".original");
  await symlink(f.path, job.worktree!, "dir");
  const preview = await f.w.workspaces.inspect(id);
  assert.ok(preview.cleanupReasons.some((r) => r.includes("管理范围")));
  await assert.rejects(f.w.workspaces.cleanup(id, preview.stamp), /管理范围/);
  assert.equal(await readFile(join(f.path, "value.txt"), "utf8"), "baseline\n");
  assert.equal(await git(f.path, ["status", "--porcelain"]), "");
});
