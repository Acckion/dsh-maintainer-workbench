import { lightweight, type FindingDecision } from './artifacts.ts';
import { localRepositoryProfile } from './repository-context.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { publish, type PublishAction } from './publish.ts';
import { retrieveRelated } from './retrieval.ts';
import { Store } from './store.ts';
import { GitHub } from './github.ts';
import { collectPatch, prepareWorktree, validateCheckout, prepareManagedCheckout, git, fetchPullRequestRevision } from './git.ts';
import { modelRunner } from './intelligence.ts';
import { ArtifactFormatError } from './execution-errors.ts';
import { kinds, type Issue, type Job, type JobKind, type Repo, type Runner, type Settings, type Snapshot, type HostStatus } from './types.ts';
export function revision(issue: Issue, repo: Repo, kind: JobKind = 'triage'): string { return createHash('sha256').update(JSON.stringify([issue.updatedAt, issue.title, issue.body, issue.state, issue.headSha ?? '', issue.type === 'pr' ? [issue.prBaseSha ?? repo.headSha, issue.headSha ?? 'unknown'] : lightweight(kind) ? 'issue-v2' : repo.headSha])).digest('hex'); }
const patchHash = (patch: string): string => createHash('sha256').update(patch).digest('hex');
const readOnlyCode = (kind: JobKind): boolean => ['review', 'validate', 'ci'].includes(kind);
const settingsSchema = z.object({ concurrency: z.number().int().min(1).max(4), maxJobsPerBatch: z.number().int().min(1).max(50), timeoutMs: z.number().int().min(1000).max(1800000), provider: z.string().min(1).max(100), model: z.string().min(1).max(100), maxTokens: z.number().int().min(500).max(32000), agentPreset: z.string().min(1).max(100), permissionPreset: z.string().min(1).max(100), syncIntervalMinutes: z.number().int().min(0).max(1440), autoTriage: z.boolean() });

export class Workbench {
  private active = new Map<string, AbortController>();
  private completions = new Set<Promise<void>>();
  private closed = false;
  private lastRepo = '';
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
    if (this.closed || this.polling || (settings.syncIntervalMinutes === 0 && !this.store.repos().some(r => r.policy?.syncIntervalMinutes))) return;
    this.polling = true;
    try {
      for (const repo of this.store.repos().filter(r => r.mode === 'github')) {
        if (this.closed) break;
        const interval = repo.policy?.syncIntervalMinutes ?? settings.syncIntervalMinutes;
        if (!interval || Date.now() - new Date(repo.syncedAt ?? 0).getTime() < interval * 60000) continue;
        try {
          await this.sync(repo.fullName);
          if (this.closed || !(repo.policy?.autoTriage ?? settings.autoTriage)) continue;
          const current = this.repo(repo.id);
          const ids = this.store.issues().filter(i => i.repoId === repo.id && i.state === 'open' && i.type === 'issue' && (!i.analysis || i.analysisRevision !== revision(i, current)) && !this.store.jobs().some(j => j.issueId === i.id && j.kind === 'triage' && j.revision === revision(i, current))).slice(0, settings.maxJobsPerBatch).map(i => i.id);
          if (ids.length) this.enqueue(ids, 'triage');
        } catch (error) { if (!this.closed) this.store.audit('automation.failed', `${repo.fullName}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } finally { this.polling = false; }
  }
  githubConnection() { return this.github.connection(); }
  snapshot(): Snapshot {
    const host = this.hostStatus?.();
    return { repos: this.store.repos(), issues: this.store.issues(), jobs: this.store.jobs().reverse().map(j => ({ ...j, artifactState: this.store.get<Issue>('issues', j.issueId) && j.revision === revision(this.store.get<Issue>('issues', j.issueId)!, this.repo(j.repoId), j.kind) ? 'current' : 'stale' })), audit: this.store.audits(), settings: this.store.settings(), capabilities: { harness: !!this.nativeRunner, model: this.nativeRunner ? !!host?.adapterRegistered : !!(process.env.MAINTAINER_API_KEY || process.env.DEEPSEEK_API_KEY), github: !!process.env.GITHUB_TOKEN, modelName: host?.model ?? this.store.settings().model, baseUrl: process.env.MAINTAINER_BASE_URL ?? 'https://api.deepseek.com', running: this.active.size, ...(host ? { host } : {}) }, version: '0.1.0' };
  }
  saveJob(job: Job): void { this.store.put('jobs', { ...job, updatedAt: new Date().toISOString() }); }
  async syncMany(names: string[]) {
    const unique = [...new Set(names.map(n => n.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '').toLowerCase()))];
    if (!unique.length || unique.length > 20 || unique.some(n => !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(n))) throw new Error('请输入 1–20 个有效的 owner/repository 或 GitHub 仓库地址');
    const results: { fullName: string; repoId?: string; error?: string }[] = [];
    for (const fullName of unique) {
      try { await this.sync(fullName); results.push({ fullName, repoId: this.store.repos().find(r => r.fullName.toLowerCase() === fullName)?.id }); }
      catch (error) { results.push({ fullName, error: error instanceof Error ? error.message : '同步失败' }); }
    }
    return { results };
  }
  async sync(fullName: string): Promise<void> {
    const key = fullName.toLowerCase();
    const existing = this.syncs.get(key); if (existing) return existing;
    const task = this.performSync(fullName).finally(() => this.syncs.delete(key)); this.syncs.set(key, task); return task;
  }
  private async performSync(fullName: string): Promise<void> {
    const { repo, issues } = await this.github.sync(fullName);
    const prev = this.store.get<Repo>('repos', repo.id);
    repo.localPath = prev?.localPath ?? ''; repo.policy = prev?.policy;
    if (prev?.profile?.revision === repo.headSha) repo.profile = prev.profile;
    this.store.transaction(() => {
      this.store.put('repos', repo);
      for (const issue of issues) {
        const old = this.store.get<Issue>('issues', issue.id);
        if (old?.analysis && old.analysisRevision === revision(issue, repo)) { issue.analysis = old.analysis; issue.analysisRevision = old.analysisRevision; }
        this.store.put('issues', { ...issue, linkedPullRequests: old?.linkedPullRequests, workflow: old?.workflow && revision(old, prev ?? repo) === revision(issue, repo) ? old.workflow : undefined });
      }
      this.store.audit('repo.sync', `${repo.fullName}：同步 ${issues.length} 条记录${repo.syncWarning ? '（部分覆盖）' : ''}`);
    });
  }
  async bindPath(repoId: string, localPath: string): Promise<void> {
    const repo = this.repo(repoId);
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
  enqueue(issueIds: string[], kind: JobKind, options: { sourceJobId?: string; instructions?: string } = {}): { created: string[]; reused: string[] } {
    z.enum(kinds).parse(kind);
    const ids = [...new Set(z.array(z.string()).min(1).max(this.store.settings().maxJobsPerBatch).parse(issueIds))];
    const candidates = ids.map(id => {
      const issue = this.store.get<Issue>('issues', id); if (!issue) throw new Error(`Issue 不存在：${id}`);
      const repo = this.repo(issue.repoId);
      if ((['preflight', 'ci'].includes(kind) || kind === 'review' && !options.sourceJobId) && issue.type !== 'pr') throw new Error('PR 审查只能选择 Pull Request');
      if (kind === 'triage' && issue.type === 'pr') throw new Error('PR 请使用变更预检，不执行 Issue 分诊');
      if (issue.state === 'closed') throw new Error('已关闭记录不可派发任务');
      if ((kind === 'fix' || kind === 'docs') && !this.nativeRunner) throw new Error('修复与文档编辑需要在 Harness 中运行；工作区会自动准备');
      return { issue, repo };
    });
    if (options.sourceJobId) {
      const source = this.job(options.sourceJobId);
      if (ids.length !== 1 || source.issueId !== ids[0] || !source.result || ['failed','cancelled','running','queued'].includes(source.status)) throw new Error('交接来源必须是同一事项的已完成产物');
      if (source.revision !== revision(candidates[0].issue, candidates[0].repo, source.kind) && !(source.kind === 'review' && ['review','fix','investigate','ci'].includes(kind))) throw new Error('来源产物已过期，请先重新分析');
    }
    const created: string[] = [], reused: string[] = [];
    this.store.transaction(() => {
      for (const { issue, repo } of candidates) {
        const rev = revision(issue, repo, kind);
        const prior = this.store.jobs().find(j => j.issueId === issue.id && j.kind === kind && j.revision === rev && j.sourceJobId === options.sourceJobId && (j.instructions ?? '') === (options.instructions ?? '') && !['failed', 'cancelled', 'rejected'].includes(j.status));
        if (prior) { reused.push(prior.id); this.store.audit('job.deduplicated', `重复派发复用已有任务 #${issue.number}`, prior.id); continue; }
        const now = new Date().toISOString();
        const handoff = this.store.jobs().filter(j => j.issueId === issue.id && j.result && (j.revision === revision(issue, repo, j.kind) || j.kind === 'review' || j.id === options.sourceJobId)).slice(-8).map(j => ({ stale: j.revision !== revision(issue, repo, j.kind), id: j.id, kind: j.kind, revision: j.revision, artifact: j.artifact, result: j.artifact ? undefined : j.result, feedback: j.reviewNote, findings: j.findingDecisions }));
        const job: Job = { handoff, sourceJobId: options.sourceJobId, instructions: options.instructions?.slice(0, 8000), id: randomUUID(), repoId: repo.id, issueId: issue.id, kind, status: 'queued', revision: rev, baseSha: repo.headSha, issueSnapshot: structuredClone(issue), attempt: 1 + Math.max(0, ...this.store.jobs().filter(j => j.issueId === issue.id && j.kind === kind && j.revision === rev).map(j => j.attempt)), createdAt: now, updatedAt: now };
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
    if (revision(current, this.repo(job.repoId), job.kind) !== job.revision) throw new Error('输入版本已变化，请从收件箱重新派发');
    if (this.nativeRunner && job.status === 'failed' && job.formatRecovery && job.rawOutput && !job.result && (job.worktree || job.analysisPath)) {
      const now = new Date().toISOString();
      const recovered: Job = { ...job, id: randomUUID(), formatOnly: true, status: 'queued', attempt: job.attempt + 1, createdAt: now, updatedAt: now, startedAt: undefined, finishedAt: undefined, error: undefined, sessionId: undefined, publications: undefined };
      this.store.put('jobs', recovered); this.store.audit('job.format_retry', `仅整理 ${job.id} 的已保存输出，不重新实施`, recovered.id); if (this.autoStart) this.pump();
      return;
    }
    this.enqueue([job.issueId], job.kind, { sourceJobId: job.sourceJobId, instructions: job.instructions });
  }
  async review(id: string, decision: 'approve' | 'reject', note: string): Promise<void> {
    const job = this.job(id); if (!['awaiting_review', 'completed'].includes(job.status)) throw new Error('任务不在待审核状态');
    if (decision === 'approve') {
      if (job.prContext) { const live = await this.github.pullRequest(this.repo(job.repoId), job.issueSnapshot.number); if (live.headSha !== job.prContext.headSha || live.baseSha !== job.prContext.baseSha) throw new Error('PR head/base 已更新，请重新审查'); }
      const current = this.store.get<Issue>('issues', job.issueId)!;
      if (revision(current, this.repo(job.repoId), job.kind) !== job.revision) throw new Error('输入已变化，旧结果不可批准；请重新派发任务');
      if (job.worktree && await collectPatch(job.worktree, job.baseSha) !== (job.patch ?? '')) throw new Error('worktree 内容已变化，原差异已过期；请重新执行');
    }
    this.saveJob({ ...job, status: decision === 'approve' ? 'approved' : 'rejected', reviewNote: note });
    this.store.audit(`job.${decision}`, note || (decision === 'approve' ? '审核通过，仅记录本地决定；未推送代码或发布回复' : '退回，等待重新调查'), id);
  }
  finding(id: string, findingId: string, decision: FindingDecision): void {
    const job = this.job(id);
    if (job.publications?.review?.status === 'published') throw new Error('此审查已发布，新的处置请创建后续审查任务');
    if (job.artifact?.stage !== 'review' || !job.artifact.findings.some(f => f.id === findingId)) throw new Error('审查发现不存在');
    if (job.revision !== revision(this.store.get<Issue>('issues', job.issueId)!, this.repo(job.repoId), job.kind)) throw new Error('审查版本已过期');
    this.saveJob({ ...job, status: 'awaiting_review', findingDecisions: { ...job.findingDecisions, [findingId]: decision } });
    this.store.audit('finding.decision', `${findingId}: ${decision}`, id);
  }
  decide(issueId: string, stage: string, reason: string): void {
    const issue = this.store.get<Issue>('issues', issueId); if (!issue) throw new Error('事项不存在');
    if (!['accepted', 'needs_info', 'deferred', 'decision'].includes(stage)) throw new Error('无效的处理阶段');
    this.store.put('issues', { ...issue, workflow: { stage, reason, updatedAt: new Date().toISOString() } });
    this.store.audit('item.decision', `${issueId}: ${stage} · ${reason}`);
  }
  async publish(id: string, action: PublishAction): Promise<string[]> {
    if (this.publishing.has(id)) throw new Error('此任务正在发布，请等待当前操作完成');
    const targetJob = this.job(id);
    const target = `${targetJob.repoId}:${targetJob.prContext?.headRef ?? targetJob.branch ?? targetJob.issueId}`;
    if (this.publishing.has(target)) throw new Error('同一目标分支正在发布，请稍后重试');
    this.publishing.add(id); this.publishing.add(target);
    try { const job = this.job(id); return await publish(this.store, job, this.repo(job.repoId), action, this.github); }
    finally { this.publishing.delete(id); this.publishing.delete(target); }
  }
  updatePolicy(repoId: string, input: unknown): void {
    const policy = z.object({ autoTriage:z.boolean(), syncIntervalMinutes:z.number().int().min(0).max(1440), timeoutMs:z.number().int().min(1000).max(1800000), maxTokens:z.number().int().min(500).max(32000) }).parse(input);
    this.store.put('repos', { ...this.repo(repoId), policy }); this.store.audit('repo.policy', `${repoId}: 更新仓库策略`);
  }
  updateSettings(input: unknown): void { const settings = settingsSchema.parse(input); this.store.put('settings', { ...settings, id: 'main' }); this.store.audit('settings.updated', '更新并发、批量上限和模型配置'); if (this.autoStart) this.pump(); }
  pump(): void {
    if (this.closed) return;
    const queued = this.store.jobs().filter(j => j.status === 'queued');
    const repos = [...new Set(queued.map(j => j.repoId))];
    const pivot = repos.indexOf(this.lastRepo); if (pivot >= 0) repos.push(...repos.splice(0, pivot + 1));
    const ordered: Job[] = []; while (queued.length) for (const repo of repos) { const i = queued.findIndex(j => j.repoId === repo); if (i >= 0) ordered.push(...queued.splice(i, 1)); }
    for (const job of ordered) {
      if (this.store.jobs().some(j => this.active.has(j.id) && j.issueId === job.issueId)) continue;
      if (this.active.size >= this.store.settings().concurrency) break;
      this.lastRepo = job.repoId;
      const controller = new AbortController(); this.active.set(job.id, controller);
      const completion = this.execute(job, controller).finally(() => { this.active.delete(job.id); this.completions.delete(completion); this.pump(); });
      this.completions.add(completion);
    }
  }
  private async execute(initial: Job, controller: AbortController): Promise<void> {
    let job = { ...initial, status: 'running' as const, startedAt: new Date().toISOString() } as Job;
    this.saveJob(job);
    const defaults = this.store.settings();
    const policy = this.repo(job.repoId).policy;
    const settings = { ...defaults, timeoutMs: policy?.timeoutMs ?? defaults.timeoutMs, maxTokens: policy?.maxTokens ?? defaults.maxTokens };
    const timer = setTimeout(() => controller.abort(new Error('任务超出配置的执行时间')), lightweight(job.kind) ? Math.min(settings.timeoutMs, 120000) : settings.timeoutMs);
    const progress = (message: string, sessionId?: string, waitingReason?: string) => {
      if (controller.signal.aborted) return;
      this.store.audit('job.progress', message, job.id);
      if (waitingReason !== undefined) { job.waitingReason = waitingReason; this.saveJob({ ...this.job(job.id), waitingReason }); }
      if (sessionId) { job.sessionId = sessionId; this.saveJob({ ...this.job(job.id), sessionId }); }
    };
    let inputPatchHash: string | undefined;
    try {
      let repo = this.repo(job.repoId);
      if (job.revision !== revision(this.store.get<Issue>('issues',job.issueId)!, repo, job.kind)) throw new Error('排队期间输入版本已变化，请重新派发');
      const related = retrieveRelated(job.issueSnapshot, this.store.issues().filter(i => i.repoId === repo.id && i.id !== job.issueId && i.state === 'open'));
      let output: Awaited<ReturnType<Runner>>;
      if (this.nativeRunner && !job.formatOnly && !repo.localPath && !lightweight(job.kind)) {
        progress('自动准备仓库克隆；首次运行可能需要一些时间');
        await waitFor(this.prepareRepository(repo.id), controller.signal); controller.signal.throwIfAborted(); repo = this.repo(repo.id);
      }
      if (job.issueSnapshot.type === 'pr') {
        progress('固定 PR head/base，并读取可见 CI 与审查状态');
        const livePR = await this.github.pullRequest(repo, job.issueSnapshot.number, controller.signal);
        if (job.formatOnly && (!job.prContext || livePR.headSha !== job.prContext.headSha || livePR.baseSha !== job.prContext.baseSha)) throw new Error('PR head/base 已变化，不能整理旧版本产物；请重新同步并派发');
        job.prContext = livePR;
        if (job.prContext.merged) throw new Error('PR 已合并，请重新同步');
        if (job.issueSnapshot.headSha && job.issueSnapshot.headSha !== job.prContext.headSha) throw new Error('PR 已更新，请先同步仓库再派发');
        job.baseSha = job.prContext.headSha;
        if (!job.formatOnly && !lightweight(job.kind) && repo.localPath) {
          await fetchPullRequestRevision(repo, job.issueSnapshot.number, job.prContext, controller.signal);
        }
        this.saveJob(job);
      }
      progress(lightweight(job.kind) ? '使用缓存仓库摘要；轻量任务不创建代码工作区' : '读取仓库结构、开发约定、构建配置与测试入口');
      repo = { ...repo, headSha: job.baseSha };
      if (lightweight(job.kind) && repo.profile) repo.profile = { ...repo.profile, sources: [], warnings: [...repo.profile.warnings, '轻量分诊仅使用缓存结构摘要，未读取源代码'] };
      if (!job.formatOnly && !lightweight(job.kind)) repo.profile = await this.understand(repo, controller.signal);
      if (this.nativeRunner && !job.formatOnly && repo.localPath && !lightweight(job.kind)) {
        const worktree = await prepareWorktree(repo, job, this.dataDir);
        job = { ...job, worktree: worktree.path, branch: worktree.branch };
        controller.signal.throwIfAborted();
        this.saveJob(job); progress(`已创建独立分支 ${worktree.branch}`);
      }
      controller.signal.throwIfAborted();
      if (this.nativeRunner && !job.worktree) {
        const analysisPath = join(this.dataDir, 'analysis', job.id);
        await mkdir(analysisPath, { recursive: true }); controller.signal.throwIfAborted();
        job = { ...job, analysisPath }; this.saveJob(job);
      }
      if (!job.formatOnly && job.sourceJobId && job.worktree) {
        const source = this.job(job.sourceJobId);
        if (source.revision === job.revision && source.patch && ['fix','docs','validate','review'].includes(job.kind) && ['fix','docs','review','validate'].includes(source.kind)) {
          if (source.baseSha !== job.baseSha || !source.worktree || await collectPatch(source.worktree, source.baseSha) !== source.patch) throw new Error('交接补丁或基础版本已变化');
          const { writeFile } = await import('node:fs/promises');
          const patchFile = join(this.dataDir, 'analysis', `${job.id}.patch`);
          await mkdir(join(this.dataDir, 'analysis'), { recursive: true }); await writeFile(patchFile, source.patch + '\n');
          await git(job.worktree, ['apply', '--index', patchFile]);
          progress('已将来源补丁应用到新的隔离工作区');
        }
      }
      if (job.formatOnly) {
        const checkpoint = job.formatRecovery;
        if (!checkpoint || checkpoint.baseSha !== job.baseSha) throw new Error('缺少可信的输出整理检查点；请重新派发');
        const currentPatch = job.worktree ? await collectPatch(job.worktree, job.baseSha) : '';
        if (patchHash(currentPatch) !== checkpoint.patchHash || (job.worktree && await git(job.worktree, ['rev-parse', 'HEAD']) !== job.baseSha)) throw new Error('工作区在输出失败后已变化，不能整理旧产物；请重新派发');
      }
      inputPatchHash = patchHash(job.worktree && readOnlyCode(job.kind) ? await collectPatch(job.worktree, job.baseSha) : '');
      const runner = this.nativeRunner ?? modelRunner;
      output = await runner({ repo, issue: job.issueSnapshot, related, job, settings, signal: controller.signal, progress, recordOutput: text => {
        if (controller.signal.aborted) return;
        job = { ...job, rawOutput: text.slice(0, 200000) };
        this.saveJob({ ...this.job(job.id), rawOutput: job.rawOutput });
      } });
      controller.signal.throwIfAborted();
      const patch = job.worktree ? await collectPatch(job.worktree, job.baseSha) : '';
      controller.signal.throwIfAborted();
      if (job.formatOnly && (patchHash(patch) !== job.formatRecovery!.patchHash || (job.worktree && await git(job.worktree, ['rev-parse', 'HEAD']) !== job.baseSha))) throw new Error('工作区在结果整理期间已变化，不能接受旧产物；请重新派发');
      controller.signal.throwIfAborted();
      if (readOnlyCode(job.kind) && patchHash(patch) !== inputPatchHash) throw new Error('分析或验证修改了代码；差异保留在工作区，不能作为已完成产物交付');
      if ((job.kind === 'fix' || job.kind === 'docs') && !patch) throw new Error('Agent 未产生可审核的代码差异。该任务不能作为已完成的修复交付。');
      this.store.transaction(() => {
        const currentIssue = this.store.get<Issue>('issues', job.issueId)!;
        if (job.kind === 'triage' && revision(currentIssue, this.repo(job.repoId), job.kind) === job.revision) this.store.put('issues', { ...currentIssue, analysis: output.result, analysisRevision: job.revision });
        this.saveJob({ ...job, ...output, patch, formatRecovery: undefined, waitingReason: undefined, status: lightweight(job.kind) || ['investigate','validate','ci'].includes(job.kind) ? 'completed' : 'awaiting_review', finishedAt: new Date().toISOString() });
        const artifact = output.artifact;
        const stage = artifact?.stage === 'triage' ? artifact.route : artifact?.stage === 'preflight' ? artifact.readiness : job.kind === 'fix' || job.kind === 'docs' ? 'review' : job.kind;
        if (revision(currentIssue, this.repo(job.repoId), job.kind) === job.revision) this.store.put('issues', { ...this.store.get<Issue>('issues', job.issueId)!, workflow: { stage, reason: artifact?.summary ?? output.result.summary, updatedAt: new Date().toISOString() } });
        this.store.audit('job.completed', `${output.engine} · 产物已保存，未发布远端`, job.id);
      });
    } catch (error) {
      const current = this.job(job.id);
      let formatRecovery: Job['formatRecovery'];
      if (error instanceof ArtifactFormatError && current.status !== 'cancelled' && current.rawOutput && !controller.signal.aborted) {
        try {
          const patch = current.worktree ? await collectPatch(current.worktree, current.baseSha) : '';
          const digest = patchHash(patch);
          if (current.formatOnly && (!current.formatRecovery || current.formatRecovery.baseSha !== current.baseSha || digest !== current.formatRecovery.patchHash)) throw new Error('工作区在结果整理期间已变化，不能整理旧产物；请重新派发');
          if (readOnlyCode(current.kind) && digest !== inputPatchHash) throw new Error('分析或验证修改了代码；差异保留在工作区，不能作为已完成产物交付');
          if (current.worktree && await git(current.worktree, ['rev-parse', 'HEAD']) !== current.baseSha) throw new Error('工作区 HEAD 已变化，不能仅整理输出；请重新派发');
          if (['fix', 'docs'].includes(current.kind) && !patch) throw new Error('Agent 未产生可审核的代码差异，请重新派发');
          formatRecovery = { baseSha: current.baseSha, patchHash: digest };
        } catch (integrityError) { error = integrityError; }
      }
      const latest = this.job(job.id);
      if (latest.status !== 'cancelled') this.saveJob({ ...latest, status: 'failed', formatRecovery: controller.signal.aborted ? undefined : formatRecovery, error: controller.signal.aborted ? String(controller.signal.reason?.message ?? '已中断') : error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
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
