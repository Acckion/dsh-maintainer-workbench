import { z } from "zod";
export const kinds = [
  "triage",
  "preflight",
  "investigate",
  "fix",
  "review",
  "docs",
  "validate",
  "ci",
] as const;
export type JobKind = (typeof kinds)[number];
export const kindNames: Record<JobKind, string> = {
  preflight: "变更预检",
  validate: "验证变更",
  ci: "诊断 CI",
  triage: "快速分诊",
  investigate: "问题调查",
  fix: "实施变更",
  review: "代码审查",
  docs: "文档维护",
};
export const analysisSchema = z.object({
  summary: z.string().min(1).max(12000),
  category: z.enum(["bug", "feature", "docs", "question", "maintenance"]),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  confidence: z.number().min(0).max(1),
  labels: z.array(z.string().max(80)).max(8),
  missingInfo: z.array(z.string().max(1000)).max(12),
  duplicateOf: z.number().int().positive().nullable(),
  duplicateReason: z.string().max(2000),
  evidence: z
    .array(
      z.object({ source: z.string().max(300), detail: z.string().max(4000) }),
    )
    .max(30),
  nextSteps: z.array(z.string().max(2000)).max(15),
  responseDraft: z.string().max(12000),
  tests: z
    .array(
      z.object({
        command: z.string().max(500),
        status: z.enum(["passed", "failed", "not_run"]),
        output: z.string().max(4000),
      }),
    )
    .max(20),
});
export type Analysis = z.infer<typeof analysisSchema>;
export type IssueCategory = Analysis["category"];
export interface IssuePlan {
  category: IssueCategory;
  goal: string;
  reproduction: string;
  expected: string;
  actual: string;
  scope: string;
  acceptanceCriteria: string[];
  decision: "proposed" | "accepted" | "deferred";
}
export interface InformationRequest {
  id: string;
  questions: string[];
  waitingFor: string;
  state: "asked" | "reply_received" | "fulfilled" | "dismissed";
  askedAt: string;
  baselineComments: number;
  source: "maintainer_record";
  replies: {
    id: number;
    author: string;
    url: string;
    body: string;
    createdAt: string;
  }[];
  checkedAt?: string;
  warning?: string;
}
export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  url: string;
  body: string;
}
export interface ThreadSnapshot {
  headSha: string;
  baseSha: string;
  threads: ReviewThread[];
  syncedAt: string;
  partial: boolean;
}
export interface FindingFollowup {
  sourceJobId: string;
  findingId: string;
  status: "resolved" | "still_present" | "unverified";
  evidence: string;
  threadId?: string;
}
export interface ExecutionRecord {
  id: string;
  sessionId: string;
  callId: string;
  tool: string;
  sourcePath?: string;
  command?: string;
  cwd?: string;
  checkoutSha: string;
  patchHash?: string;
  exitCode: number | null;
  signal?: string;
  isError: boolean;
  recordedAt: string;
  output: string;
  truncated: boolean;
}
export interface ToolDiagnostics {
  contextRecovery?: { attempts: number; lastAction: string; error?: string };
  validationRepair?: { attempts: number; reason: string };
  implementationRepair?: { attempts: number; reason: string };
  evidenceRepair?: { attempts: number; reasons: string[] };
  sessionId: string;
  provider: string;
  model: string;
  preset: string;
  permission: string;
  mountedTools: string[];
  requests: {
    tools: string[];
    purpose?: string;
    budget?: {
      messageChars: number;
      toolChars: number;
      systemChars: number;
      estimatedInputTokens: number;
      roles: { role: string; chars: number }[];
    };
  }[];
  calls: number;
  results: number;
  canonicalResults: number;
  errors: number;
  finished: boolean;
}
export interface RepositoryProfile {
  revision: string;
  scannedAt: string;
  languages: string[];
  roots: string[];
  testPaths: string[];
  workflows: string[];
  manifests: string[];
  commands: { source: string; command: string }[];
  sources: { path: string; content: string }[];
  warnings: string[];
}
export interface Repo {
  syncLimited?: boolean;
  discovered?: boolean;
  discoveryActive?: boolean;
  localKind?: "git" | "folder";
  workspacePaths?: string[];
  githubName?: string;
  remoteCandidates?: string[];
  dirty?: boolean;
  policy?: Pick<
    Settings,
    | "syncLimit"
    | "autoReview"
    | "autoPreflight"
    | "autoTriage"
    | "syncIntervalMinutes"
    | "timeoutMs"
    | "maxTokens"
  >;
  private?: boolean;
  id: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  headSha: string;
  localPath: string;
  mode: "github" | "local";
  syncedAt: string | null;
  syncWarning: string | null;
  profile?: RepositoryProfile;
}
export interface PRContext {
  headSha: string;
  baseSha: string;
  headRef: string;
  headRepo: string | null;
  baseRef: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  checks: unknown;
  reviews: unknown;
  reviewComments?: unknown;
  commitStatus?: unknown;
  warnings: string[];
}
export interface Issue {
  orchestration?: import("./orchestration.ts").WorkflowState;
  processing?: { status: "plan" | "running" | "blocked" | "review" | "waiting" | "stale" | "deferred"; reason: string };
  remotePRs?: import("./remote-progress.ts").RemotePR[];
  actions?: import("./remote-progress.ts").ActionsSnapshot;
  remoteWarning?: string;
  plan?: IssuePlan;
  informationRequests?: InformationRequest[];
  origin?: "repository";
  organizeMode?: import("./organize.ts").OrganizeMode;
  merged?: boolean;
  linkedPullRequests?: string[];
  prBaseSha?: string;
  workflow?: { stage: string; reason: string; updatedAt: string };
  id: string;
  repoId: string;
  number: number;
  type: "issue" | "pr";
  title: string;
  body: string;
  author: string;
  labels: string[];
  state: "open" | "closed";
  comments: number;
  updatedAt: string;
  url: string;
  headSha?: string;
  analysis?: Analysis;
  analysisRevision?: string;
}
export type JobStatus =
  | "completed"
  | "queued"
  | "running"
  | "awaiting_review"
  | "approved"
  | "rejected"
  | "failed"
  | "cancelled";
export interface Job {
  workflowRunId?: string;
  reviewRequiredSources?: string[];
  toolDiagnostics?: ToolDiagnostics;
  evidenceGate?: { allowed: boolean; reasons: string[] };
  ciEvidence?: {
    snapshot: import("./remote-progress.ts").ActionsSnapshot;
    logs: import("./remote-progress.ts").ActionsLog[];
  };
  patchSha256?: string;
  executionRecords?: ExecutionRecord[];
  reviewThreads?: ThreadSnapshot;
  findingThreadLinks?: Record<string, string>;
  findingFollowups?: FindingFollowup[];
  deliveryReviewId?: string;
  formatRecovery?: { baseSha: string; patchHash: string };
  waitingReason?: string;
  artifactState?: string;
  formatOnly?: boolean;
  artifact?: import("./artifacts.ts").Artifact;
  sourceJobId?: string;
  handoff?: {
    stale?: boolean;
    id: string;
    kind: JobKind;
    revision: string;
    artifact?: import("./artifacts.ts").Artifact;
    result?: Analysis;
    feedback?: string;
    followups?: FindingFollowup[];
    findings?: Record<string, import("./artifacts.ts").FindingDecision>;
  }[];
  instructions?: string;
  findingDecisions?: Record<string, import("./artifacts.ts").FindingDecision>;
  prContext?: PRContext;
  rawOutput?: string;
  id: string;
  repoId: string;
  issueId: string;
  kind: JobKind;
  status: JobStatus;
  revision: string;
  baseSha: string;
  issueSnapshot: Issue;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  worktree?: string;
  analysisPath?: string;
  branch?: string;
  result?: Analysis;
  patch?: string;
  error?: string;
  engine?: string;
  tokens?: number;
  reviewNote?: string;
  publishedCommit?: string;
  publications?: Partial<
    Record<
      "comment" | "labels" | "pr" | "update_pr" | "review",
      {
        status: "publishing" | "published" | "failed";
        urls: string[];
        error?: string;
        remoteUpdatedAt?: string;
        at: string;
      }
    >
  >;
}
export interface Audit {
  id: number;
  at: string;
  jobId: string | null;
  action: string;
  detail: string;
}
export interface Settings {
  syncLimit?: number;
  autoPreflight?: boolean;
  autoReview?: boolean;
  triageMaxTokens?: number;
  concurrency: number;
  maxJobsPerBatch: number;
  timeoutMs: number;
  provider: string;
  model: string;
  maxTokens: number;
  agentPreset: string;
  permissionPreset: string;
  syncIntervalMinutes: number;
  autoTriage: boolean;
}
export interface HostStatus {
  contextServices?: {
    tokenMeter: boolean;
    pruner: boolean;
    compactor: boolean;
  };
  provider: string;
  model: string;
  reasoningEffort?: string;
  adapterRegistered: boolean;
  agentPreset: string;
}
export interface Snapshot {
  repos: Repo[];
  issues: Issue[];
  jobs: Job[];
  audit: Audit[];
  settings: Settings;
  capabilities: {
    harness: boolean;
    model: boolean;
    github: boolean;
    modelName: string;
    baseUrl: string;
    running: number;
    host?: HostStatus;
  };
  version: string;
}
export type Runner = (input: {
  repo: Repo;
  issue: Issue;
  related: Issue[];
  job: Job;
  settings: Settings;
  signal: AbortSignal;
  progress: (
    message: string,
    sessionId?: string,
    waitingReason?: string,
  ) => void;
  recordDiagnostics?: (diagnostics: ToolDiagnostics) => void;
  recordOutput?: (text: string) => void;
  recordExecution?: (record: ExecutionRecord, raw: string) => void;
}) => Promise<{
  artifact?: import("./artifacts.ts").Artifact;
  result: Analysis;
  engine: string;
  tokens?: number;
}>;
