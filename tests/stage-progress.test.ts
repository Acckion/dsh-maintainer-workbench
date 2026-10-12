import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StageProgress } from "../src/client/StageProgress.tsx";
import { StageExecutionDetails } from "../src/client/StageExecutionDetails.tsx";
import { AssistantActions } from "../src/client/AssistantActions.tsx";
import type { Audit, Issue, Job } from "../src/core/types.ts";
import type {
  ProcessingCase,
  ProcessingWait,
} from "../src/domain/processing.ts";
const issue: Issue = {
  id: "issue",
  repoId: "repo",
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
const job: Job = {
  id: "run",
  repoId: issue.repoId,
  issueId: issue.id,
  kind: "preflight",
  status: "running",
  revision: "fixture",
  baseSha: "a".repeat(40),
  issueSnapshot: issue,
  attempt: 1,
  createdAt: issue.updatedAt,
  updatedAt: issue.updatedAt,
  sessionId: "session",
};
const audit = (detail: string, at = "2026-10-09T00:00:01Z"): Audit => ({
  id: Date.parse(at),
  jobId: job.id,
  action: "job.progress",
  detail,
  at,
});
const wait = (
  type: ProcessingWait["type"],
  requestedByRunId = job.id,
): ProcessingWait => ({
  id: "wait",
  type,
  requestedByRunId,
  state: "open",
  targetFingerprint: "fixture",
  reason: "A concrete reason",
  createdAt: issue.updatedAt,
});
const withWait = (w: ProcessingWait): Issue => ({
  ...issue,
  processing: { waits: [w], currentRunId: job.id } as ProcessingCase,
});
const progress = (
  props: Partial<React.ComponentProps<typeof StageProgress>> = {},
) =>
  renderToStaticMarkup(
    React.createElement(StageProgress, {
      issue,
      job,
      audit: [],
      readOnly: false,
      ...props,
    }),
  );
test("running progress uses the latest timestamp without presenting session setup as completed source work", () => {
  const markup = progress({
    audit: [
      audit("Old progress"),
      audit("Current progress", "2026-10-09T00:00:03Z"),
    ],
  });
  assert.match(markup, /Current progress/);
  assert.doesNotMatch(markup, /Old progress/);
  assert.match(markup, /当前无需操作/);
  const setup = progress({
    audit: [
      audit("已创建 Harness Session；可在宿主会话中查看工具执行与处理审批"),
    ],
  });
  assert.match(setup, /等待新的执行信息/);
  assert.doesNotMatch(setup, /已创建 Harness Session|读取源码|%/);
});
test("real host permission wait becomes an explicit action while historical and unrelated runs expose no permission prompt", () => {
  const markup = progress({
    issue: withWait(wait("host_permission")),
    openSession: () => {},
  });
  assert.match(markup, /需要你授权工具执行/);
  assert.match(markup, /前往授权/);
  assert.doesNotMatch(markup, /当前无需操作/);
  assert.doesNotMatch(
    progress({
      issue: withWait(wait("host_permission", "other")),
      openSession: () => {},
    }),
    /前往授权/,
  );
  assert.doesNotMatch(
    progress({
      issue: withWait(wait("host_permission")),
      readOnly: true,
      openSession: () => {},
    }),
    /前往授权/,
  );
  assert.match(
    progress({ issue: withWait(wait("host_permission")) }),
    /对应宿主会话/,
  );
});
test("input requests show the actual form in primary content rather than hiding it in history", () => {
  const markup = progress({
    job: { ...job, status: "waiting_input" },
    issue: withWait(wait("user_input")),
    input: React.createElement("form", null, "Actual questions"),
  });
  assert.match(markup, /需要补充资料/);
  assert.match(markup, /Actual questions/);
  assert.doesNotMatch(markup, /当前无需操作/);
});
test("queue, environment wait and failure each explain the real state", () => {
  assert.match(
    progress({ job: { ...job, status: "queued" } }),
    /任务已加入队列/,
  );
  assert.match(
    progress({
      job: { ...job, status: "waiting_environment" },
      issue: withWait(wait("environment_ready")),
    }),
    /A concrete reason/,
  );
  const failure = progress({
    job: { ...job, status: "failed", error: "Network unavailable" },
  });
  assert.match(failure, /本次执行失败/);
  assert.match(failure, /Network unavailable/);
  assert.doesNotMatch(failure, /当前无需操作/);
});
test("execution details retain raw session progress and hide empty evidence groups", () => {
  const markup = renderToStaticMarkup(
    React.createElement(StageExecutionDetails, {
      job,
      audit: [audit("已创建 Harness Session")],
      tools: null,
      openEvidence: () => {},
    }),
  );
  assert.match(markup, /已创建 Harness Session/);
  assert.match(markup, /来源与执行环境/);
  assert.doesNotMatch(markup, /分析依据 · 0/);
});
test("cancel is a secondary menu action preserving the projected control", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AssistantActions, {
      issue,
      job,
      history: [job],
      busy: false,
      act: async () => {},
      openEvidence: () => {},
      projected: {
        controls: [
          {
            kind: "cancel",
            runId: job.id,
            label: "停止任务",
            enabled: true,
            blockedReasons: [],
          },
        ],
        stages: [],
        expectedVersion: 7,
      },
    }),
  );
  assert.match(markup, /<summary>更多<\/summary>/);
  assert.match(markup, /<div><button[^>]*>停止任务<\/button><\/div>/);
});

test("execution detail retains its view when results arrive and surfaces live permission waits without enabling historical prompts", async () => {
  const { StagePanel } = await import("../src/client/StagePanel.tsx");
  const node = {
    id: "node",
    stage: "preflight" as const,
    status: "running" as const,
    label: "预检",
    result: "执行中",
    attemptIds: [job.id],
    waits: [],
    conditions: [],
  };
  const timeline = {
    historical: false,
    currentNodeId: node.id,
    currentRunId: job.id,
    nodes: [node],
    events: [],
    profile: { category: "maintenance" },
  } as unknown as import("../src/domain/timeline.ts").ProcessingTimeline;
  const calls: unknown[][] = [];
  const props: React.ComponentProps<typeof StagePanel> = {
    selected: node,
    timeline,
    issue: withWait(wait("host_permission")),
    attempt: job,
    currentJob: job,
    history: [job],
    readOnly: false,
    viewingHistory: false,
    selection: { view: "stage", detail: "execution" },
    choose: () => {
      throw Error("render must not change selection");
    },
    render: (...args) => {
      calls.push(args);
      return null;
    },
    track: () => null,
  };
  const waiting = renderToStaticMarkup(React.createElement(StagePanel, props));
  assert.match(waiting, /等待授权/);
  assert.deepEqual(
    calls.map((c) => c[4]),
    [undefined, true],
  );
  calls.length = 0;
  renderToStaticMarkup(
    React.createElement(StagePanel, {
      ...props,
      readOnly: true,
      viewingHistory: true,
    }),
  );
  assert.deepEqual(
    calls.map((c) => c[4]),
    [true],
  );
  calls.length = 0;
  const completed = {
    ...job,
    status: "completed" as const,
    result: { summary: "New result" } as Job["result"],
  };
  const markup = renderToStaticMarkup(
    React.createElement(StagePanel, { ...props, issue, attempt: completed }),
  );
  assert.match(markup, /结果已生成/);
  assert.deepEqual(
    calls.map((c) => c[4]),
    [true],
  );
});

test("unsatisfied input wait offers its form instead of a redundant disabled continue control", () => {
  const markup = renderToStaticMarkup(
    React.createElement(AssistantActions, {
      issue,
      job: { ...job, status: "waiting_input" },
      history: [job],
      busy: false,
      act: async () => {},
      openEvidence: () => {},
      projected: {
        controls: [
          {
            kind: "resume",
            runId: job.id,
            label: "等待填写补充信息",
            enabled: false,
            blockedReasons: ["Answer the question first"],
          },
        ],
        stages: [],
        expectedVersion: 7,
      },
    }),
  );
  assert.equal(markup, "");
});
