import { localRepositoryProfile } from './repository-context.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { publish, type PublishAction } from './publish.ts';
import { retrieveRelated } from './retrieval.ts';
import { Store } from './store.ts';
import { demoAnalysis, seedDemo } from './demo.ts';
import { GitHub } from './github.ts';
import { collectPatch, prepareWorktree, validateCheckout, prepareManagedCheckout } from './git.ts';
import { modelRunner } from './intelligence.ts';
import { kinds, type Issue, type Job, type JobKind, type Repo, type Runner, type Settings, type Snapshot, type HostStatus } from './types.ts';
export function revision(issue: Issue, repo: Repo): string { return createHash('sha256').update(JSON.stringify([issue.updatedAt, issue.title, issue.body, issue.state, issue.headSha ?? '', repo.headSha])).digest('hex'); }
const settingsSchema = z.object({ concurrency: z.number().int().min(1).max(4), maxJobsPerBatch: z.number().int().min(1).max(50), timeoutMs: z.number().int().min(1000).max(1800000), provider: z.string().min(1).max(100), model: z.string().min(1).max(100), maxTokens: z.number().int().min(500).max(32000), agentPreset: z.string().min(1).max(100), permissionPreset: z.string().min(1).max(100), syncIntervalMinutes: z.number().int().min(0).max(1440), autoTriage: z.boolean() });

export class Workbench {
  private active = new Map<string, AbortController>();
  private completions = new Set<Promise<void>>();
  private closed = false;
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private publishing = new Set<string>();
  private preparationControllers = new Map<string, AbortController>();
  private preparations = new Map<string, Promise<void>>();
  private profiles = new Map<string, Promise<import("./types.ts").RepositoryProfile>>();
  private syncs = new Map<string, Promise<void>>();
  constructor(public store: Store, private dataDir: string, private nativeRunner?: Runner, private github = new GitHub(), private autoStart = true, private hostStatus?: () => HostStatus) {
    for (const job of store.jobs()) if (job.status === 'running') { this.saveJob({ ...job, status: 'failed', error: '上次进程中断。为避免重复修改，未自动重新执行；请检查 worktree 后重试。', finishedAt: new Date().toISOString() }); store.audit('job.interrupted', '进程重启后恢复为待人工重试', job.id); }
    for (const job of store.jobs()) if (job.publications) { let changed = false; for (const receipt of Object.values(job.publications)) if (receipt.status === 'publishing') { receipt.status = 'failed'; receipt.error = '上次发布过程被中断；重试时将先按任务标识核对远端结果'; changed = true; } if (changed) { this.saveJob(job); store.audit('publish.interrupted', '恢复中断的发布记录', job.id); } }
    if (autoStart) { queueMicrotask(() => this.pump()); this.pollTimer = setInterval(() => void this.poll(), 60000); this.pollTimer.unref(); }
  }
  async poll(): Promise<void> {
    const settings = this.store.settings();
    if (this.closed || this.polling || settings.syncIntervalMinutes === 0) return;
    this.polling = true;
    try {
      for (const repo of this.store.repos().filter(r => r.mode === 'github')) {
        if (this.closed) break;
        if (Date.now() - new Date(repo.syncedAt ?? 0).getTime() < settings.syncIntervalMinutes * 60000) continue;
        try {
          await this.sync(repo.fullName);
          if (this.closed || !settings.autoTriage) continue;
          const current = this.repo(repo.id);
          const ids = this.store.issues().filter(i => i.repoId === repo.id && i.state === 'open' && !i.analysis && !this.store.jobs().some(j => j.issueId === i.id && j.kind === 'triage' && j.revision === revision(i, current))).slice(0, settings.maxJobsPerBatch).map(i => i.id);
          if (ids.length) this.enqueue(ids, 'triage');
        } catch (error) { if (!this.closed) this.store.audit('automation.failed', `${repo.fullName}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } finally { this.polling = false; }
  }
  snapshot(): Snapshot {
    const host = this.hostStatus?.();
    return { repos: this.store.repos(), issues: this.store.issues(), jobs: this.store.jobs().reverse(), audit: this.store.audits(), settings: this.store.settings(), capabilities: { harness: !!this.nativeRunner, model: this.nativeRunner ? !!host?.adapterRegistered : !!(process.env.MAINTAINER_API_KEY || process.env.DEEPSEEK_API_KEY), github: !!process.env.GITHUB_TOKEN, modelName: host?.model ?? this.store.settings().model, baseUrl: process.env.MAINTAINER_BASE_URL ?? 'https://api.deepseek.com', running: this.active.size, ...(host ? { host } : {}) }, version: '0.1.0' };
  }
  seed(): void { seedDemo(this.store); }
  saveJob(job: Job): void { this.store.put('jobs', { ...job, updatedAt: new Date().toISOString() }); }
  async sync(fullName: string): Promise<void> {
    const key = fullName.toLowerCase();
    const existing = this.syncs.get(key); if (existing) return existing;
    const task = this.performSync(fullName).finally(() => this.syncs.delete(key)); this.syncs.set(key, task); return task;
  }
  private async performSync(fullName: string): Promise<void> {
    const { repo, issues } = await this.github.sync(fullName);
    const prev = this.store.get<Repo>('repos', repo.id);
    repo.localPath = prev?.localPath ?? '';
    if (prev?.profile?.revision === repo.headSha) repo.profile = prev.profile;
    this.store.transaction(() => {
      this.store.put('repos', repo);
      for (const issue of issues) {
        const old = this.store.get<Issue>('issues', issue.id);
        if (old?.analysis && old.analysisRevision === revision(issue, repo)) { issue.analysis = old.analysis; issue.analysisRevision = old.analysisRevision; }
        this.store.put('issues', issue);
      }
      this.store.audit('repo.sync', `${repo.fullName}：同步 ${issues.length} 条记录${repo.syncWarning ? '（部分覆盖）' : ''}`);
    });
  }
  async bindPath(repoId: string, localPath: string): Promise<void> {
    const repo = this.repo(repoId); if (repo.mode === 'demo') throw new Error('演示仓库不绑定真实工作目录');
    const path = await validateCheckout(localPath, repo);
    this.store.put('repos', { ...repo, localPath: path });
    this.store.audit('repo.bind', `${repo.fullName} 已绑定本地工作区`);
  }
  async prepareRepository(repoId: string): Promise<void> {
    const existing = this.preparations.get(repoId); if (existing) return existing;
    const repo = this.repo(repoId);
    if (!this.nativeRunner || repo.mode !== 'github') throw new Error('自动工作区需要 Harness 和真实 GitHub 仓库');
    if (repo.localPath) return;
    const controller = new AbortController(); this.preparationControllers.set(repoId, controller);
    const task = prepareManagedCheckout(repo, this.dataDir, controller.signal).then(localPath => {
      this.store.put('repos', { ...this.repo(repoId), localPath });
      this.store.audit('repo.prepared', `${repo.fullName} 已自动准备独立本地克隆`);
    }).finally(() => { this.preparations.delete(repoId); this.preparationControllers.delete(repoId); });
    this.preparations.set(repoId, task); return task;
  }
  private async understand(repo: Repo, signal: AbortSignal) {
    if (repo.profile?.revision === repo.headSha && repo.profile.sources.length && (!repo.localPath || !repo.profile.warnings.some(w => w.startsWith('Remote')))) return repo.profile;
    const key = `${repo.id}:${repo.headSha}:${!!repo.localPath}`;
    let task = this.profiles.get(key);
    if (!task) { task = (repo.localPath ? localRepositoryProfile(repo.localPath, repo.headSha) : this.github.profile(repo, AbortSignal.timeout(30000))).finally(() => this.profiles.delete(key)); this.profiles.set(key, task); }
    const profile = await waitFor(task, signal); signal.throwIfAborted();
    const current = this.repo(repo.id); if (current.headSha === repo.headSha) this.store.put('repos', { ...current, profile });
    return profile;
  }
  private repo(id: string): Repo { const repo = this.store.get<Repo>('repos', id); if (!repo) throw new Error('仓库不存在'); return repo; }
  private job(id: string): Job { const job = this.store.get<Job>('jobs', id); if (!job) throw new Error('任务不存在'); return job; }
  enqueue(issueIds: string[], kind: JobKind): { created: string[]; reused: string[] } {
    z.enum(kinds).parse(kind);
    const ids = [...new Set(z.array(z.string()).min(1).max(this.store.settings().maxJobsPerBatch).parse(issueIds))];
    const candidates = ids.map(id => {
      const issue = this.store.get<Issue>('issues', id); if (!issue) throw new Error(`Issue 不存在：${id}`);
      const repo = this.repo(issue.repoId);
      if (kind === 'review' && issue.type !== 'pr') throw new Error('PR 审查只能选择 Pull Request');
      if (issue.state === 'closed') throw new Error('已关闭记录不可派发任务');
      if (repo.mode !== 'demo' && (kind === 'fix' || kind === 'docs') && !this.nativeRunner) throw new Error('修复与文档编辑需要在 Harness 中运行；工作区会自动准备');
      return { issue, repo };
    });
    const created: string[] = [], reused: string[] = [];
    this.store.transaction(() => {
      for (const { issue, repo } of candidates) {
        const rev = revision(issue, repo);
        const prior = this.store.jobs().find(j => j.issueId === issue.id && j.kind === kind && j.revision === rev && !['failed', 'cancelled', 'rejected'].includes(j.status));
        if (prior) { reused.push(prior.id); this.store.audit('job.deduplicated', `重复派发复用已有任务 #${issue.number}`, prior.id); continue; }
        const now = new Date().toISOString();
        const job: Job = { id: randomUUID(), repoId: repo.id, issueId: issue.id, kind, status: 'queued', revision: rev, baseSha: repo.headSha, issueSnapshot: structuredClone(issue), attempt: 1 + Math.max(0, ...this.store.jobs().filter(j => j.issueId === issue.id && j.kind === kind && j.revision === rev).map(j => j.attempt)), createdAt: now, updatedAt: now };
        this.store.put('jobs', job); this.store.audit('job.queued', `${kind} · ${repo.fullName}#${issue.number}`, job.id); created.push(job.id);
      }
    });
    if (this.autoStart) this.pump(); return { created, reused };
  }
  cancel(id: string): void {
    const job = this.job(id); if (!['queued', 'running'].includes(job.status)) throw new Error('只能取消排队或执行中的任务');
    this.saveJob({ ...job, status: 'cancelled', finishedAt: new Date().toISOString() });
    this.active.get(id)?.abort(new Error('维护者取消了任务'));
    this.store.audit('job.cancelled', '由维护者取消；已生成的 worktree 保留供检查', id);
  }
  retry(id: string): void {
    const job = this.job(id); if (!['failed', 'cancelled', 'rejected'].includes(job.status)) throw new Error('当前状态不能重试');
    if (this.active.has(id)) throw new Error('任务仍在停止，请稍后重试');
    const current = this.store.get<Issue>('issues', job.issueId)!;
    if (revision(current, this.repo(job.repoId)) !== job.revision) throw new Error('输入版本已变化，请从收件箱重新派发');
    this.enqueue([job.issueId], job.kind);
  }
  async review(id: string, decision: 'approve' | 'reject', note: string): Promise<void> {
    const job = this.job(id); if (job.status !== 'awaiting_review') throw new Error('任务不在待审核状态');
    if (decision === 'approve') {
      const current = this.store.get<Issue>('issues', job.issueId)!;
      if (revision(current, this.repo(job.repoId)) !== job.revision) throw new Error('输入已变化，旧结果不可批准；请重新派发任务');
      if (job.worktree && await collectPatch(job.worktree, job.baseSha) !== (job.patch ?? '')) throw new Error('worktree 内容已变化，原差异已过期；请重新执行');
    }
    this.saveJob({ ...job, status: decision === 'approve' ? 'approved' : 'rejected', reviewNote: note });
    this.store.audit(`job.${decision}`, note || (decision === 'approve' ? '审核通过，仅记录本地决定；未推送代码或发布回复' : '退回，等待重新调查'), id);
  }
  async publish(id: string, action: PublishAction): Promise<string[]> {
    if (this.publishing.has(id)) throw new Error('此任务正在发布，请等待当前操作完成');
    this.publishing.add(id);
    try { const job = this.job(id); return await publish(this.store, job, this.repo(job.repoId), action, this.github); }
    finally { this.publishing.delete(id); }
  }
  updateSettings(input: unknown): void { const settings = settingsSchema.parse(input); this.store.put('settings', { ...settings, id: 'main' }); this.store.audit('settings.updated', '更新并发、批量上限和模型配置'); if (this.autoStart) this.pump(); }
  pump(): void {
    if (this.closed) return;
    for (const job of this.store.jobs().filter(j => j.status === 'queued')) {
      if (this.active.size >= this.store.settings().concurrency) break;
      const controller = new AbortController(); this.active.set(job.id, controller);
      const completion = this.execute(job, controller).finally(() => { this.active.delete(job.id); this.completions.delete(completion); this.pump(); });
      this.completions.add(completion);
    }
  }
  private async execute(initial: Job, controller: AbortController): Promise<void> {
    let job = { ...initial, status: 'running' as const, startedAt: new Date().toISOString() } as Job;
    this.saveJob(job);
    const settings = this.store.settings();
    const timer = setTimeout(() => controller.abort(new Error('任务超出配置的执行时间')), settings.timeoutMs);
    const progress = (message: string, sessionId?: string) => {
      if (controller.signal.aborted) return;
      this.store.audit('job.progress', message, job.id);
      if (sessionId) { job.sessionId = sessionId; this.saveJob({ ...this.job(job.id), sessionId }); }
    };
    try {
      let repo = this.repo(job.repoId);
      const related = retrieveRelated(job.issueSnapshot, this.store.issues().filter(i => i.repoId === repo.id && i.id !== job.issueId && i.state === 'open'));
      let output: Awaited<ReturnType<Runner>>;
      if (repo.mode === 'demo') {
        progress('演示执行：整理报告线索（不会调用模型或修改代码）');
        await delay(900, undefined, { signal: controller.signal });
        progress('演示执行：生成结构化结果与待审核草稿');
        output = { result: demoAnalysis(job.issueSnapshot, job.kind), engine: 'demo / simulated' };
      } else {
        if (this.nativeRunner && !repo.localPath && job.kind !== 'triage') {
          progress('自动准备仓库克隆；首次运行可能需要一些时间');
          await waitFor(this.prepareRepository(repo.id), controller.signal); controller.signal.throwIfAborted(); repo = this.repo(repo.id);
        }
        progress('读取仓库结构、开发约定、构建配置与测试入口');
        repo = { ...repo, headSha: job.baseSha };
        repo.profile = await this.understand(repo, controller.signal);
        if (this.nativeRunner && repo.localPath) {
          const worktree = await prepareWorktree(repo, job, this.dataDir);
          job = { ...job, worktree: worktree.path, branch: worktree.branch };
          controller.signal.throwIfAborted();
          this.saveJob(job); progress(`已创建独立分支 ${worktree.branch}`);
        }
        controller.signal.throwIfAborted();
        if (this.nativeRunner && !job.worktree) {
          const analysisPath = join(this.dataDir, 'analysis', job.id);
          await mkdir(analysisPath, { recursive: true });
          job = { ...job, analysisPath }; this.saveJob(job);
        }
        const runner = this.nativeRunner ?? modelRunner;
        output = await runner({ repo, issue: job.issueSnapshot, related, job, settings, signal: controller.signal, progress });
      }
      controller.signal.throwIfAborted();
      const patch = job.worktree ? await collectPatch(job.worktree, job.baseSha) : '';
      controller.signal.throwIfAborted();
      if (repo.mode !== 'demo' && (job.kind === 'fix' || job.kind === 'docs') && !patch) throw new Error('Agent 未产生可审核的代码差异。该任务不能作为已完成的修复交付。');
      this.store.transaction(() => {
        const currentIssue = this.store.get<Issue>('issues', job.issueId)!;
        if (job.kind === 'triage' && revision(currentIssue, this.repo(job.repoId)) === job.revision) this.store.put('issues', { ...currentIssue, analysis: output.result, analysisRevision: job.revision });
        this.saveJob({ ...job, ...output, patch, status: 'awaiting_review', finishedAt: new Date().toISOString() });
        this.store.audit('job.completed', `${output.engine} · 结果等待审核`, job.id);
      });
    } catch (error) {
      const current = this.job(job.id);
      if (current.status !== 'cancelled') this.saveJob({ ...current, status: 'failed', error: controller.signal.aborted ? String(controller.signal.reason?.message ?? '已中断') : error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
      this.store.audit('job.stopped', this.job(job.id).error ?? '已取消', job.id);
    } finally { clearTimeout(timer); }
  }
  async drain(): Promise<void> { while (this.completions.size) await Promise.allSettled([...this.completions]); }
  async close(): Promise<void> { this.closed = true; clearInterval(this.pollTimer); for (const controller of this.preparationControllers.values()) controller.abort(new Error('服务正在关闭')); for (const controller of this.active.values()) controller.abort(new Error('服务正在关闭')); await Promise.allSettled([...this.syncs.values(), ...this.preparations.values(), ...this.profiles.values()]); for (const controller of this.active.values()) controller.abort(new Error('服务正在关闭')); await this.drain(); this.store.close(); }
}

function waitFor<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    task.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
