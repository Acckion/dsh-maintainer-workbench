import type {
  ProcessingCase,
  ProcessingEvent,
  ProcessingWait,
} from "../domain/processing.ts";

const pending = (wait: ProcessingWait) => wait.state === "open";
const terminal = (state: ProcessingCase) =>
  ["completed", "cancelled", "deferred"].includes(state.lifecycle);
const putWait = (state: ProcessingCase, wait: ProcessingWait) => {
  state.waits = [...state.waits.filter((w) => w.id !== wait.id), wait];
};

/** Pure transition: no I/O, model calls, timers, or publication permissions. */
export function transition(
  state: ProcessingCase,
  event: ProcessingEvent,
): ProcessingCase {
  if (event.caseId !== state.id || event.workItemId !== state.workItemId)
    throw new Error("事件不属于当前处理周期");
  const next = structuredClone(state);
  const payload = event.payload;
  if (payload.type === "planning.recorded") {
    if (payload.planning.run && payload.planning.run.caseId !== next.id)
      throw new Error("计划授权不属于当前处理周期");
    next.planning = structuredClone(payload.planning);
    const run = next.planning.run;
    // Intermediate artifacts are consumed by the confirmed chain, not individually approved.
    // Preserve final approval and all explicit input/environment waits.
    if (run?.status === "running")
      next.waits = next.waits.map((wait) =>
        pending(wait) &&
        wait.type === "approval" &&
        wait.requestedByRunId &&
        wait.requestedByRunId !== run.currentJobId &&
        run.completedJobIds.includes(wait.requestedByRunId)
          ? { ...wait, state: "superseded" }
          : wait,
      );
  } else if (payload.type === "workflow.upgraded") {
    if (next.workflowDefinitionVersion !== payload.from)
      throw new Error("流程迁移的来源版本不一致");
    next.workflowDefinitionVersion = payload.to;
    next.waits = [
      ...new Map(next.waits.map((wait) => [wait.id, wait])).values(),
    ];
  } else if (payload.type === "source.observed") {
    const changed = next.sourceFingerprint !== payload.fingerprint;
    next.sourceFingerprint = payload.fingerprint;
    if (payload.state === "closed") {
      next.lifecycle =
        payload.itemType === "pr" && !payload.merged
          ? "cancelled"
          : "completed";
      next.phase = "closed";
      next.reason = payload.merged ? "GitHub 已合并" : "GitHub 已关闭";
      next.waits = next.waits.map((w) =>
        pending(w) ? { ...w, state: "superseded" } : w,
      );
    } else if (changed) {
      next.waits = next.waits.map((w) =>
        pending(w) &&
        w.type === "author_revision" &&
        w.targetHeadSha &&
        payload.headSha &&
        payload.headSha !== w.targetHeadSha
          ? { ...w, state: "satisfied" }
          : w,
      );
      next.waits = next.waits.map((w) =>
        pending(w) && ["approval", "user_input"].includes(w.type)
          ? { ...w, state: "superseded" }
          : w,
      );
      if (!terminal(next)) {
        next.phase = "decision";
        next.lifecycle = "waiting";
        next.reason =
          "事项输入已更新，请核对受影响的结论；旧运行仅保留为历史证据";
      }
    }
  } else if (payload.type === "decision.recorded") {
    if (next.phase === "closed") return next;
    next.phase = payload.phase;
    next.reason = payload.reason;
    next.planFingerprint = payload.planFingerprint ?? next.planFingerprint;
    if (payload.phase === "accepted")
      next.planSourceFingerprint = next.sourceFingerprint;
    next.lifecycle =
      payload.phase === "deferred"
        ? "deferred"
        : payload.phase === "answered"
          ? "completed"
          : payload.phase === "accepted"
            ? "active"
            : "waiting";
    next.waits = next.waits.map((w) =>
      pending(w) && ["approval", "user_input"].includes(w.type)
        ? { ...w, state: "superseded" }
        : w,
    );
  } else if (payload.type === "information.observed") {
    for (const request of payload.requests) {
      const id = `information:${request.id}`;
      const existing = next.waits.find((w) => w.id === id);
      const wait: ProcessingWait = {
        id,
        type: "reporter_reply",
        expectedActor: request.waitingFor,
        state:
          request.state === "asked"
            ? "open"
            : request.state === "dismissed"
              ? "cancelled"
              : "satisfied",
        reason: `等待 ${request.waitingFor} 补充信息`,
        targetFingerprint: next.sourceFingerprint,
        createdAt: existing?.createdAt ?? request.askedAt,
        resumeAction: "reassess_information",
      };
      next.waits = [...next.waits.filter((w) => w.id !== id), wait];
    }
    if (!terminal(next)) {
      const waiting = next.waits.some(
        (w) => w.type === "reporter_reply" && pending(w),
      );
      const replies = payload.requests.some(
        (r) => r.state === "reply_received",
      );
      if (waiting || replies) {
        next.lifecycle = "waiting";
        next.phase = replies ? "decision" : "needs_info";
        next.reason = replies
          ? "等待对象有新回复，请核对补充内容后重新评估"
          : "等待补充信息";
      } else if (next.phase === "needs_info") {
        next.phase = "decision";
        next.lifecycle = "waiting";
        next.reason = "追问已核对，请根据当前证据决定下一步";
      }
    }
  } else if (payload.type === "run.observed") {
    const executing = ["queued", "running"].includes(payload.status);
    next.activeRunIds = [
      ...new Set(
        next.activeRunIds
          .filter((id) => id !== payload.runId)
          .concat(executing ? [payload.runId] : []),
      ),
    ];
    if (["cancelled", "rejected"].includes(payload.status))
      next.waits = next.waits.map((w) =>
        pending(w) && w.requestedByRunId === payload.runId
          ? { ...w, state: "cancelled" }
          : w,
      );
    if (payload.status === "queued" && payload.current)
      next.waits = next.waits.map((w) =>
        pending(w) &&
        ((w.type === "approval" && w.requestedByRunId !== payload.runId) ||
          (w.type === "author_revision" &&
            ["fix", "docs"].includes(payload.kind)))
          ? { ...w, state: "superseded" }
          : w,
      );
    if (
      (payload.status === "queued" || !next.currentRunId) &&
      payload.current &&
      !terminal(next)
    )
      next.currentRunId = payload.runId;
    // A late result may retain its evidence but cannot advance another run or input version.
    if (
      payload.current &&
      next.currentRunId === payload.runId &&
      !terminal(next)
    ) {
      next.phase = payload.phase;
      next.reason =
        payload.pauseReason ?? payload.waitingReason ?? payload.reason;
      next.waits = next.waits.map((w) =>
        w.requestedByRunId === payload.runId &&
        pending(w) &&
        ["approval", "host_permission"].includes(w.type)
          ? {
              ...w,
              state:
                payload.status === "approved"
                  ? "satisfied"
                  : payload.status === "rejected" ||
                      payload.status === "cancelled"
                    ? "cancelled"
                    : w.type === "host_permission" && !payload.waitingReason
                      ? "satisfied"
                      : "superseded",
            }
          : w,
      );
      next.lifecycle =
        executing && !payload.waitingReason ? "active" : "waiting";
      if (payload.waitingReason)
        putWait(next, {
          id: `permission:${payload.runId}`,
          type: "host_permission",
          state: "open",
          requestedByRunId: payload.runId,
          targetFingerprint: next.sourceFingerprint,
          reason: payload.waitingReason,
          createdAt: event.receivedAt,
        });
      if (payload.status === "awaiting_review")
        putWait(next, {
          id: `approval:${payload.runId}`,
          type: "approval",
          state: "open",
          requestedByRunId: payload.runId,
          targetFingerprint: next.sourceFingerprint,
          reason: "等待维护者审核此版本的产物",
          createdAt: event.receivedAt,
        });
    }
  } else if (payload.type === "input.requested") {
    if (!terminal(next)) {
      next.waits = [
        ...next.waits.filter((w) => w.id !== payload.wait.id),
        payload.wait,
      ];
      next.lifecycle = "waiting";
      next.reason = payload.wait.reason;
    }
  } else if (payload.type === "input.submitted") {
    const wait = next.waits.find((w) => w.id === payload.waitId);
    if (
      !wait ||
      !pending(wait) ||
      wait.targetFingerprint !== payload.targetFingerprint ||
      next.sourceFingerprint !== payload.targetFingerprint
    )
      throw new Error("输入请求已过期或已结束");
    wait.state = "satisfied";
    if (!terminal(next)) {
      next.phase = "decision";
      next.lifecycle = "waiting";
      next.reason = "已保存用户输入，请基于新证据继续处理";
    }
  } else if (payload.type === "publication.confirmed") {
    if (payload.answerPublished && !terminal(next)) {
      next.phase = "answered";
      next.lifecycle = "completed";
      next.reason =
        "有依据的答复已确认发布，本地处理结束；GitHub Issue 状态保持独立";
      next.waits = next.waits.map((w) =>
        pending(w) ? { ...w, state: "satisfied" } : w,
      );
    }
    if (
      !terminal(next) &&
      ["pr", "update_pr", "review"].includes(payload.action)
    ) {
      next.phase = "track";
      next.lifecycle = "waiting";
      next.reason = "交付已确认，等待 GitHub 的后续 CI、审查与合并结果";
      next.waits = next.waits.map((w) =>
        w.requestedByRunId === payload.runId &&
        w.type === "approval" &&
        pending(w)
          ? { ...w, state: "satisfied" }
          : w,
      );
      if (payload.action === "review")
        putWait(next, {
          id: `author:${payload.runId}`,
          type: "author_revision",
          state: "open",
          requestedByRunId: payload.runId,
          targetFingerprint: next.sourceFingerprint,
          targetUrl: payload.targetUrl,
          targetHeadSha: payload.headSha,
          targetBaseSha: payload.baseSha,
          createdAt: event.receivedAt,
          reason: "审查意见已发布，等待作者修订",
          resumeAction: "review",
        });
      else
        putWait(next, {
          id: `ci:${payload.runId}`,
          type: "ci_completion",
          state: "open",
          requestedByRunId: payload.runId,
          targetFingerprint: next.sourceFingerprint,
          targetUrl: payload.targetUrl,
          targetHeadSha: payload.headSha,
          targetBaseSha: payload.baseSha,
          createdAt: event.receivedAt,
          reason: "交付已发布，等待此版本的 CI 结果",
          resumeAction: "sync_remote",
        });
    }
  } else if (payload.type === "remote.activity") {
    const observed = payload.observation;
    if (observed && !terminal(next)) {
      const mayAdvance = next.activeRunIds.length === 0;
      for (const wait of next.waits.filter(
        (w) =>
          pending(w) ||
          (w.type === "ci_completion" &&
            w.state === "satisfied" &&
            w.requestedByRunId === next.currentRunId),
      )) {
        if (wait.targetUrl && wait.targetUrl !== observed.url) continue;
        if (
          wait.type === "author_revision" &&
          observed.complete &&
          wait.targetHeadSha &&
          observed.headSha !== wait.targetHeadSha
        ) {
          wait.state = "satisfied";
          if (mayAdvance) {
            next.phase = "decision";
            next.reason = "作者已更新 PR，请审查新版本";
          }
        }
        if (
          wait.type === "ci_completion" &&
          (!wait.targetHeadSha || wait.targetHeadSha === observed.headSha) &&
          (!wait.targetBaseSha || wait.targetBaseSha === observed.baseSha) &&
          observed.complete &&
          ["passed", "failed"].includes(observed.ci ?? "")
        ) {
          wait.state = "satisfied";
          if (mayAdvance) {
            next.phase = observed.ci === "failed" ? "blocked" : "track";
            next.reason =
              observed.ci === "failed"
                ? "当前交付版本的 CI 失败，请诊断或修订"
                : "当前交付版本的 CI 已通过，等待审查与合并";
          }
        }
      }
      if (
        mayAdvance &&
        observed.complete &&
        observed.review === "changes_requested" &&
        next.phase === "track"
      ) {
        next.phase = "decision";
        next.reason = "远端审查要求修改，请选择交给作者或 Agent";
      }
      if (
        mayAdvance &&
        observed.complete &&
        observed.state === "merged" &&
        next.phase === "track"
      )
        next.reason = "关联 PR 已合并，请核对事项是否完整解决";
      if (
        mayAdvance &&
        observed.complete &&
        observed.state === "closed" &&
        next.phase === "track"
      ) {
        next.phase = "blocked";
        next.reason = "关联 PR 未合并已关闭，请决定是否继续处理";
      }
      if (next.lifecycle !== "active") next.lifecycle = "waiting";
    }
  } else if (payload.type === "environment.observed") {
    if (!terminal(next)) {
      if (payload.ready) {
        next.waits = next.waits.map((w) =>
          pending(w) && w.type === "environment_ready"
            ? { ...w, state: "satisfied" }
            : w,
        );
        next.reason = payload.reason;
        next.lifecycle = "waiting";
      } else {
        putWait(next, {
          id: `environment:${next.currentRunId ?? next.id}`,
          type: "environment_ready",
          state: "open",
          targetFingerprint: next.sourceFingerprint,
          requestedByRunId: next.currentRunId,
          reason: payload.reason,
          createdAt: event.receivedAt,
          resumeAction: "prepare_repository",
        });
        next.lifecycle = "waiting";
        next.reason = payload.reason;
      }
    }
  } else if (payload.type === "wait.cancelled") {
    const wait = next.waits.find((w) => w.id === payload.waitId && pending(w));
    if (!wait) throw new Error("等待已结束或不存在");
    if (wait.type === "host_permission")
      throw new Error("宿主权限审批需在 Harness 中处理");
    wait.state = "cancelled";
    if (!terminal(next)) {
      next.phase = "decision";
      next.lifecycle = "waiting";
      next.reason = payload.reason;
    }
  }
  next.updatedAt = event.receivedAt;
  next.version = state.version + 1;
  return next;
}
