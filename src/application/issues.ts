import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ServiceBase,
  type Enqueue,
  type ServiceDependencies,
} from "../application/service.ts";
import { issuePlanSchema, sameQuestions } from "../core/issue-flow.ts";
import {
  organizeActions,
  organizeModes,
  type OrganizeMode,
} from "../core/organize.ts";
import { type Issue } from "../core/types.ts";

export class IssueService extends ServiceBase {
  constructor(
    deps: ServiceDependencies,
    private enqueue?: Enqueue,
  ) {
    super(deps);
  }
  organize(
    repoId: string,
    mode: OrganizeMode,
    issueId?: string,
    instructions = "",
  ) {
    z.enum(organizeModes).parse(mode);
    const repo = this.repo(repoId),
      action = organizeActions[mode];
    if (
      (repo.localKind === "folder" ||
        (repo.mode === "local" && !repo.headSha)) &&
      mode !== "audit"
    )
      throw new Error(
        "已发现此目录，但当前整理执行需要至少一个 Git 提交；不会自动初始化或提交你的文件",
      );
    if (!this.nativeRunner) throw new Error("仓库整理需要 Harness 原生执行器");
    let id = issueId;
    if (id) {
      const issue = this.store.get<Issue>("issues", id);
      if (
        !issue ||
        issue.repoId !== repoId ||
        issue.type !== "pr" ||
        mode !== "docs"
      )
        throw new Error("PR 整理仅支持同一仓库的文档同步");
    } else {
      id = `${repo.id}:organize:${mode}`;
      if (!this.store.get<Issue>("issues", id))
        this.store.put("issues", {
          id,
          repoId,
          origin: "repository",
          organizeMode: mode,
          number: 0,
          type: "issue",
          title: action.title,
          body: action.description,
          author: "维护者",
          labels: [],
          state: "open",
          comments: 0,
          updatedAt: new Date().toISOString(),
          url: repo.githubName
            ? `https://github.com/${repo.githubName}`
            : repo.mode === "github"
              ? `https://github.com/${repo.fullName}`
              : "",
        });
    }
    if (!this.enqueue) throw new Error("仓库整理未配置执行器");
    return this.enqueue([id], action.kind, {
      instructions: action.instructions + "\nMaintainer scope: " + instructions,
    });
  }
  decide(issueId: string, stage: string, reason: string): void {
    const issue = this.store.get<Issue>("issues", issueId);
    if (!issue) throw new Error("事项不存在");
    if (issue.state !== "open") throw new Error("只能为开放事项记录处理决策");
    if (
      !["accepted", "needs_info", "deferred", "decision", "answered"].includes(
        stage,
      )
    )
      throw new Error("无效的处理阶段");
    if (
      stage === "answered" &&
      ((issue.plan?.category ?? issue.analysis?.category) !== "question" ||
        !reason.trim())
    )
      throw new Error(
        "仅使用提问可记录答复并结束本地处理，请填写答复或已发布链接。",
      );
    this.store.transaction(() => {
      this.store.processing.dispatch(
        issueId,
        {
          type: "decision.recorded",
          phase: stage as import("../domain/processing.ts").ProcessingPhase,
          reason,
        },
        "user",
        `decision:${randomUUID()}`,
      );
      this.store.audit("item.decision", `${issueId}: ${stage} · ${reason}`);
    });
  }
  savePlan(issueId: string, value: unknown): void {
    const issue = this.store.get<Issue>("issues", issueId);
    if (!issue || issue.type !== "issue" || issue.state !== "open")
      throw new Error("只能为开放 Issue 保存类型和验收计划");
    if (
      this.store
        .jobs()
        .some(
          (job) =>
            job.issueId === issueId &&
            ["queued", "running"].includes(job.status),
        )
    )
      throw new Error("任务运行中，请先停止任务再确认新计划");
    const plan = issuePlanSchema.parse(value);
    this.store.put("issues", {
      ...issue,
      plan,
    });
    this.store.audit(
      "item.plan",
      `${issueId}: ${plan.category} · ${plan.decision}`,
    );
  }
  askInformation(
    issueId: string,
    questions: string[],
    waitingFor: string,
    askedAt?: string,
    published?: { id: string },
  ): { id: string; reused: boolean } {
    const issue = this.store.get<Issue>("issues", issueId);
    if (!issue || issue.type !== "issue" || issue.state !== "open")
      throw new Error("只能为开放 Issue 记录追问");
    const values = [
      ...new Set(
        z
          .array(z.string().trim().min(1).max(1000))
          .min(1)
          .max(20)
          .parse(questions),
      ),
    ];
    const login = z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/)
      .parse(waitingFor);
    const requests = issue.informationRequests ?? [];
    const previous = requests.find((request) =>
      sameQuestions(request, values, login),
    );
    if (previous) return { id: previous.id, reused: true };
    const pending = requests.filter(
      (r) =>
        ["asked", "reply_received"].includes(r.state) &&
        r.waitingFor.toLowerCase() === login.toLowerCase(),
    );
    const asked = new Set(
      pending.flatMap((r) =>
        r.questions.map((q) => q.trim().replace(/\s+/g, " ").toLowerCase()),
      ),
    );
    const fresh = values.filter(
      (q) => !asked.has(q.trim().replace(/\s+/g, " ").toLowerCase()),
    );
    if (!fresh.length) return { id: pending[0].id, reused: true };
    if (requests.length >= 100)
      throw new Error("追问记录已达到 100 条，请导出历史后整理事项。");
    const now = new Date().toISOString(),
      id = published?.id ?? randomUUID();
    const time = askedAt ? z.string().datetime().parse(askedAt) : now;
    if (Date.parse(time) > Date.now() + 1000)
      throw new Error("实际提问时间不能在未来");
    this.store.put("issues", {
      ...issue,
      informationRequests: [
        ...requests,
        {
          id,
          questions: fresh,
          waitingFor: login,
          askedAt: time,
          baselineComments: issue.comments,
          state: "asked",
          source: published ? "published_comment" : "maintainer_record",
          replies: [],
        },
      ],
    });
    this.store.audit(
      "information.asked",
      `${issueId}: 已记录向 ${login} 提出的 ${fresh.length} 项追问；${published ? "GitHub 发布已确认" : "未发送外部消息"}`,
    );
    return { id, reused: false };
  }
  finishInformation(
    issueId: string,
    requestId: string,
    state: "fulfilled" | "dismissed",
  ): void {
    const issue = this.store.get<Issue>("issues", issueId);
    const request = issue?.informationRequests?.find((r) => r.id === requestId);
    if (
      !issue ||
      !request ||
      !["asked", "reply_received"].includes(request.state)
    )
      throw new Error("没有可核对的追问记录");
    const requests = issue.informationRequests!.map((r) =>
      r.id === requestId ? { ...r, state } : r,
    );
    this.store.put("issues", {
      ...issue,
      informationRequests: requests,
    });
    this.store.audit(
      "information.finished",
      `${issueId}: ${requestId} · ${state}`,
    );
  }
}
