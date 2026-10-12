import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../core/store.ts";
import type { ProcessingWait } from "../domain/processing.ts";
import { ProcessingConflictError } from "../infrastructure/persistence/processing.ts";

import { inputRequestSchema, answerStateSchema, meaningfulAnswer, type InputAnswer } from "../domain/input.ts";

export class ProcessingService {
  constructor(private store: Store) {}
  detail(issueId: string) {
    return this.history(issueId);
  }
  history(issueId: string, caseId?: string) {
    const state = this.store.processing.current(issueId);
    if (!state) throw new Error("事项不存在");
    const selected = caseId
      ? this.store.processing.cases(issueId).find((c) => c.id === caseId)
      : state;
    if (!selected) throw new Error("处理周期不属于此事项");
    return {
      state,
      cases: this.store.processing.cases(issueId),
      selected,
      events: this.store.processing.events(selected.id),
      inputs: this.store.processing.inputs(selected.id),
    };
  }
  assertVersion(issueId: string, version?: number): void {
    const state = this.store.processing.current(issueId);
    if (!state) throw new Error("事项不存在");
    if (version !== undefined && state.version !== version)
      throw new ProcessingConflictError();
  }
  cancelWait(
    issueId: string,
    waitId: string,
    reason: string,
    version: number,
  ): void {
    if (!reason.trim()) throw new Error("请填写结束等待的原因");
    this.store.transaction(() => {
      this.store.processing.dispatch(
        issueId,
        { type: "wait.cancelled", waitId, reason },
        "user",
        `cancel-wait:${waitId}`,
        version,
      );
      if (waitId.startsWith("information:")) {
        const issue = this.store.get<import("../core/types.ts").Issue>(
          "issues",
          issueId,
        )!;
        this.store.put("issues", {
          ...issue,
          informationRequests: issue.informationRequests?.map((r) =>
            `information:${r.id}` === waitId ? { ...r, state: "dismissed" } : r,
          ),
        });
      }
      this.store.audit("processing.wait_cancelled", reason);
    });
  }
  environmentReady(repoId: string): void {
    for (const issue of this.store
      .issues()
      .filter(
        (i) =>
          i.repoId === repoId &&
          i.processing?.waits.some(
            (w) => w.type === "environment_ready" && w.state === "open",
          ),
      )) {
      this.store.processing.dispatch(
        issue.id,
        {
          type: "environment.observed",
          ready: true,
          reason: "仓库环境已准备，可显式继续原任务",
        },
        "system",
        `environment-ready:${issue.processing!.version}`,
      );
    }
  }
  requestInput(
    issueId: string,
    value: unknown,
    runId?: string,
    expectedVersion?: number,
  ): ProcessingWait {
    const request = inputRequestSchema.parse(value);
    return this.store.transaction(() => {
      this.assertVersion(issueId, expectedVersion);
      const state = this.store.processing.current(issueId)!;
      if (["completed", "cancelled", "deferred"].includes(state.lifecycle))
        throw new Error("当前处理周期不接受新的输入请求");
      const wait: ProcessingWait = {
        id: randomUUID(),
        type: "user_input",
        state: "open",
        reason: request.reason,
        requiredFields: request.fields.filter(f=>f.required!==false).map((f) => f.id),
        expectedActor: request.fields.every(f=>f.actor==="reporter") ? this.store.issues().find(i=>i.id===issueId)?.author : "maintainer",
        questions: request.fields,
        targetFingerprint: state.sourceFingerprint,
        requestedByRunId: runId,
        createdAt: new Date().toISOString(),
      };
      this.store.processing.dispatch(
        issueId,
        { type: "input.requested", wait },
        runId ? "agent" : "user",
        `input-request:${wait.id}`,
        expectedVersion,
      );
      this.store.audit(
        "processing.input_requested",
        request.reason,
        runId ?? null,
      );
      return wait;
    });
  }
  submitInput(
    issueId: string,
    waitId: string,
    values: Record<string, string>,
    expectedVersion: number,
    dispositions: Record<string, InputAnswer["state"]> = {},
  ): void {
    this.store.transaction(() => {
      this.assertVersion(issueId, expectedVersion);
      const state = this.store.processing.current(issueId)!;
      const wait = state.waits.find(
        (w) => w.id === waitId && w.type === "user_input",
      );
      if (!wait || wait.state !== "open")
        throw new Error("输入请求不存在或已结束");
      const parsed = z.record(z.string().trim().max(4000)).parse(values);
      const states = z.record(answerStateSchema).parse(dispositions);
      const fieldIds = new Set(wait.questions?.map(q=>q.id) ?? wait.requiredFields ?? []);
      if([...Object.keys(parsed),...Object.keys(states)].some(key=>!fieldIds.has(key)))
        throw new Error("请完整填写此输入请求的字段，不能提交其他字段");
      const answers:Record<string,InputAnswer>={...wait.answers};
      for(const key of new Set([...Object.keys(parsed),...Object.keys(states)])) {
        const value=parsed[key] ?? answers[key]?.value ?? "";
        const state=states[key] ?? (value ? "provided" : answers[key]?.state ?? "unknown");
        if(value || states[key]) answers[key]={value,state};
      }
      if(!Object.keys(answers).length) throw new Error("请提供资料或记录未知、无法提供状态");
      const complete=(wait.requiredFields ?? []).every(key=>answers[key] && meaningfulAnswer(answers[key]));
      const record = {
        id: randomUUID(),
        waitId,
        values: Object.fromEntries(Object.entries(answers).map(([key,a])=>[key,a.value])),
        answers,
        at: new Date().toISOString(),
      };
      this.store.processing.dispatch(
        issueId,
        {
          type: complete ? "input.submitted" : "input.recorded",
          answers,
          waitId,
          targetFingerprint: wait.targetFingerprint,
        },
        "user",
        `input-response:${record.id}`,
        expectedVersion,
      );
      this.store.db
        .prepare("INSERT INTO processing_inputs VALUES(?,?,?,?)")
        .run(record.id, state.id, waitId, JSON.stringify(record));
      this.store.audit(
        "processing.input_submitted",
        `已保存输入请求 ${waitId} 的答复`,
        wait.requestedByRunId ?? null,
      );
    });
  }
}
