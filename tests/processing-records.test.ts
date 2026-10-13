import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Job } from "../src/core/types.ts";
import type { ProcessingEvent } from "../src/domain/processing.ts";
import type { ProcessingTimeline } from "../src/domain/timeline.ts";
import { processingRecords } from "../src/client/processing-records.ts";
import { ProcessingRecords } from "../src/client/ProcessingRecords.tsx";

const job = (id: string, at: string, caseId = "current"): Job => ({
  id,
  caseId,
  repoId: "owner/repo",
  issueId: "owner/repo#1",
  kind: "investigate",
  status: "completed",
  revision: "r",
  baseSha: "sha",
  attempt: 1,
  createdAt: at,
  updatedAt: at,
  worktree: `/worktrees/${id}`,
  branch: `task/${id}`,
  sessionId: `session-${id}`,
  issueSnapshot: {
    id: "owner/repo#1",
    repoId: "owner/repo",
    type: "issue",
    number: 1,
    title: "Bug",
    body: "",
    author: "owner",
    labels: [],
    state: "open",
    comments: 0,
    updatedAt: at,
    url: "",
  },
});
const event = (
  id: string,
  at: string,
  payload: ProcessingEvent["payload"],
): ProcessingEvent =>
  ({
    id,
    caseId: "current",
    workItemId: "owner/repo#1",
    source: "user",
    deduplicationKey: id,
    occurredAt: at,
    receivedAt: at,
    payload,
  }) as ProcessingEvent;
const runEvent = (id: string, at: string, runId: string): ProcessingEvent =>
  event(id, at, {
    type: "run.observed",
    runId,
    kind: "investigate",
    status: "completed",
    current: true,
    phase: "investigate",
    reason: "源码判断已保存",
  });
const scope = {
  caseId: "current",
  issueId: "owner/repo#1",
  cycle: 2,
  events: [] as ProcessingEvent[],
};

test("lifecycle events attach once to their exact run while human actions retain their chronology", () => {
  const first = job("first", "2026-10-12T00:00:01Z");
  const retry = job("retry", "2026-10-12T00:00:04Z");
  const events = [
    runEvent("done", "2026-10-12T00:00:02Z", first.id),
    event("approval", "2026-10-12T00:00:03Z", {
      type: "decision.recorded",
      phase: "accepted",
      reason: "接受范围",
    }),
    runEvent("retry-done", "2026-10-12T00:00:05Z", retry.id),
  ];
  const before = JSON.stringify({ jobs: [retry, first], events });
  const records = processingRecords({ ...scope, events }, [retry, first]);
  assert.deepEqual(
    records.map((r) => r.id),
    ["run:retry", "event:approval", "run:first"],
  );
  const run = records[0];
  assert.ok("job" in run);
  assert.equal(run.attempt, 2);
  assert.deepEqual(
    run.events.map((e) => e.id),
    ["retry-done"],
  );
  assert.equal(JSON.stringify({ jobs: [retry, first], events }), before);
});

test("records stay in the selected cycle and preserve unlinked events and legacy runs only in cycle one", () => {
  const current = job("current-run", "2026-10-12T00:00:01Z");
  const old = job("old-run", "2026-10-11T00:00:01Z", "old");
  const legacy = {
    ...job("legacy", "2026-10-10T00:00:01Z"),
    caseId: undefined,
  };
  const unknown = runEvent("unloaded", "2026-10-12T00:00:02Z", "unloaded-run");
  const foreign = { ...unknown, id: "foreign", workItemId: "other/repo#1" };
  const records = processingRecords({ ...scope, events: [unknown, foreign] }, [
    current,
    old,
    legacy,
  ]);
  assert.deepEqual(
    records.map((r) => r.id),
    ["event:unloaded", "run:current-run"],
  );
  assert.deepEqual(
    processingRecords({ ...scope, caseId: "old", cycle: 1 }, [
      current,
      old,
      legacy,
    ]).map((r) => r.id),
    ["run:old-run", "run:legacy"],
  );
});

test("observations with the same occurrence time retain their receipt order", () => {
  const run = job("run", "2026-10-12T00:00:00Z");
  const early = {
    ...runEvent("z", "2026-10-12T00:00:01Z", run.id),
    receivedAt: "2026-10-12T00:00:01.100Z",
  };
  const later = {
    ...runEvent("a", "2026-10-12T00:00:01Z", run.id),
    receivedAt: "2026-10-12T00:00:01.200Z",
  };
  const records = processingRecords({ ...scope, events: [later, early] }, [
    run,
  ]);
  assert.ok("job" in records[0]);
  assert.deepEqual(
    records[0].events.map((e) => e.id),
    ["z", "a"],
  );
});

test("one disclosure exposes paths, sessions, source links and run events directly", () => {
  const first = job("first", "2026-10-12T00:00:01Z");
  const second = {
    ...job("second", "2026-10-12T00:00:02Z"),
    sourceJobId: first.id,
  };
  const timeline = {
    ...scope,
    eventTotal: 3,
    events: [runEvent("done", "2026-10-12T00:00:03Z", second.id)],
  } as ProcessingTimeline;
  const html = renderToStaticMarkup(
    React.createElement(ProcessingRecords, {
      timeline,
      jobs: [first, second],
      openSession: () => {},
      openExecution: () => {},
    }),
  );
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.match(html, /处理记录.*2 次执行/);
  assert.match(html, /\/worktrees\/first/);
  assert.match(html, /\/worktrees\/second/);
  assert.match(html, /打开会话/);
  assert.match(html, /来源：.*问题调查/);
  assert.match(html, /复制路径/);
  assert.match(html, /执行详情/);
  assert.match(html, /源码判断已保存/);
  assert.match(html, /最近 1 条活动，共 3 条/);
  assert.doesNotMatch(html, /mw-stage-resources|阶段活动记录|工作区与会话/);
});
