import { githubDetail, type DetailSection } from './github-details.ts';
import { discoverWorkspace } from './workspace-discovery.ts';
import { organizeActions, organizeModes, type OrganizeMode } from './organize.ts';
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
import { kinds, type Issue, type Job, type JobKind, type Repo, type Runner, type Settings, type Snapshot, type HostStatus } from './types.ts';
export function revision(issue: Issue, repo: Repo, kind: JobKind = 'triage'): string { return createHash('sha256').update(JSON.stringify([issue.updatedAt, issue.title, issue.body, issue.state, issue.headSha ?? '', issue.type === 'pr' ? [issue.prBaseSha ?? repo.headSha, issue.headSha ?? 'unknown'] : lightweight(kind) ? 'issue-v2' : repo.headSha])).digest('hex'); }
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
  async discover(paths: string[]): Promise<void> {
    for (const path of paths) {
      if(this.closed)return;
      try {
        const found = await discoverWorkspace(path,this.dataDir); if (!found || this.closed) continue;
        const old = this.store.repos().find(r=>r.localPath===found.localPath || !r.discovered && found.githubName && r.fullName.toLowerCase()===found.githubName.toLowerCase()) ?? this.store.get<Repo>('repos',found.id);
        this.store.put('repos',{description:'Harness 自动发现的工作区',syncedAt:null,syncWarning:null,defaultBranch:'',...old,...found,id:old?.id ?? found.id,workspacePaths:[...new Set([...(old?.workspacePaths ?? []),...(found.workspacePaths ?? [])])]});
      } catch { /* Removed or inaccessible host workspaces do not block other directories. */ }
    }
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
          const ids = this.store.issues().filter(i => i.repoId === repo.id && i.state === 'open' && i.type === 'issue' && !i.origin && (!i.analysis || i.analysisRevision !== revision(i, current)) && !this.store.jobs().some(j => j.issueId === i.id && j.kind === 'triage' && j.revision === revision(i, current))).slice(0, settings.maxJobsPerBatch).map(i => i.id);
          if (ids.length) this.enqueue(ids, 'triage');
        } catch (error) { if (!this.closed) this.store.audit('automation.failed', `${repo.fullName}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } finally { this.polling = false; }
  }
  async itemDetail(id: string, section: DetailSection, page = 1) {
    const issue = this.store.get<Issue>('issues', id);
    if (!issue) throw new Error('事项不存在，请同步仓库后重试');
    return githubDetail(this.github, this.repo(issue.repoId), issue, section, page);
  }
  githubConnection() { return this.github.connection(); }
  snapshot(): Snapshot {
    const host = this.hostStatus?.();
    return { repos: this.store.repos(), issues: this.store.issues(), jobs: this.store.jobs().reverse().map(j => ({ ...j, artifactState: this.store.get<Issue>('issues', j.issueId) && j.revision === revision(this.store.get<Issue>('issues', j.issueId)!, this.repo(j.repoId), j.kind) ? 'current' : 'stale' })), audit: this.store.audits(), settings: this.store.settings(), capabilities: { harness: !!this.nativeRunner, model: this.nativeRunner ? !!host?.adapterRegistered : !!(process.env.MAINTAINER_API_KEY || process.env.DEEPSEEK_API_KEY), github: !!process.env.GITHUB_TOKEN, modelName: host?.model ?? this.store.settings().model, baseUrl: process.env.MAINTAINER_BASE_URL ?? 'https://api.deepseek.com', running: this.active.size, ...(host ? { host } : {}) }, version: '0.1.1' };
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
    const prev = this.store.repos().find(r=>r.discovered && r.githubName?.toLowerCase()===repo.fullName.toLowerCase()) ?? this.store.get<Repo>('repos', repo.id);
    if(prev?.discovered) { const remoteId=repo.id; Object.assign(repo,{id:prev.id,mode:'local',discovered:true,localKind:prev.localKind,workspacePaths:prev.workspacePaths,githubName:prev.githubName,remoteCandidates:prev.remoteCandidates,dirty:prev.dirty,headSha:prev.headSha});for(const issue of issues){issue.repoId=repo.id;issue.id=issue.id.replace(remoteId,repo.id);} }
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
  organize(repoId: string, mode: OrganizeMode, issueId?: string, instructions = '') {
    z.enum(organizeModes).parse(mode);
    const repo = this.repo(repoId), action = organizeActions[mode];
    if ((repo.localKind === 'folder' || repo.mode === 'local' && !repo.headSha) && mode !== 'audit') throw new Error('已发现此目录，但当前整理执行需要至少一个 Git 提交；不会自动初始化或提交你的文件');
    if (repo.mode === 'local' && repo.dirty && mode !== 'audit') throw new Error('当前目录有未提交修改。本版隔离任务读取 HEAD，请先提交；不会悄悄忽略或覆盖这些修改');
    if (!this.nativeRunner) throw new Error('仓库整理需要 Harness 原生执行器');
    let id = issueId;
    if (id) {
      const issue = this.store.get<Issue>('issues', id);
      if (!issue || issue.repoId !== repoId || issue.type !== 'pr' || mode !== 'docs') throw new Error('PR 整理仅支持同一仓库的文档同步');
    } else {
      id = `${repo.id}:organize:${mode}`;
      if (!this.store.get<Issue>('issues', id)) this.store.put('issues', {id,repoId,origin:'repository',organizeMode:mode,number:0,type:'issue',title:action.title,body:action.description,author:'维护者',labels:[],state:'open',comments:0,updatedAt:new Date().toISOString(),url:repo.githubName ? `https://github.com/${repo.githubName}` : repo.mode === 'github' ? `https://github.com/${repo.fullName}` : ''});
    }
    return this.enqueue([id], action.kind, {instructions:action.instructions + '\nMaintainer scope: ' + instructions});
  }
  enqueue(issueIds: string[], kind: JobKind, options: { sourceJobId?: string; instructions?: string } = {}): { created: string[]; reused: string[] } {
    z.enum(kinds).parse(kind);
    const ids = [...new Set(z.array(z.string()).min(1).max(this.store.settings().maxJobsPerBatch).parse(issueIds))];
    const candidates = ids.map(id => {
      const issue = this.store.get<Issue>('issues', id); if (!issue) throw new Error(`Issue 不存在：${id}`);
      const repo = this.repo(issue.repoId);
      if (repo.mode === 'local' && !repo.headSha && !(issue.organizeMode === 'audit' && kind === 'investigate')) throw new Error('无 Git 提交的目录当前仅支持只读仓库检查');
      if (repo.mode === 'local' && repo.dirty && !(issue.organizeMode === 'audit' && kind === 'investigate')) throw new Error('当前工作区有未提交修改；隔离修改任务需先提交，只读检查仍可使用');
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
    if (this.nativeRunner && job.rawOutput && !job.result && (job.worktree || job.analysisPath)) {
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
    try {
      let repo = this.repo(job.repoId);
      if (job.revision !== revision(this.store.get<Issue>('issues',job.issueId)!, repo, job.kind)) throw new Error('排队期间输入版本已变化，请重新派发');
      const related = retrieveRelated(job.issueSnapshot, this.store.issues().filter(i => i.repoId === repo.id && i.id !== job.issueId && i.state === 'open'));
      let output: Awaited<ReturnType<Runner>>;
      const directAudit = repo.mode === 'local' && job.issueSnapshot.organizeMode === 'audit' && job.kind === 'investigate';
      if(directAudit) { job={...job,analysisPath:repo.localPath};this.saveJob(job); }
      if (this.nativeRunner && !job.formatOnly && !repo.localPath && !lightweight(job.kind)) {
        progress('自动准备仓库克隆；首次运行可能需要一些时间');
        await waitFor(this.prepareRepository(repo.id), controller.signal); controller.signal.throwIfAborted(); repo = this.repo(repo.id);
      }
      if (job.issueSnapshot.type === 'pr') {
        progress('固定 PR head/base，并读取可见 CI 与审查状态');
        job.prContext = await this.github.pullRequest(repo, job.issueSnapshot.number, controller.signal);
        if (job.prContext.merged) throw new Error('PR 已合并，请重新同步');
        if (job.issueSnapshot.headSha && job.issueSnapshot.headSha !== job.prContext.headSha) throw new Error('PR 已更新，请先同步仓库再派发');
        job.baseSha = job.prContext.headSha;
        if (!job.formatOnly && !lightweight(job.kind) && repo.localPath) {
          await fetchPullRequestRevision(repo, job.issueSnapshot.number, job.prContext, controller.signal);
        }
        this.saveJob(job);
      }
      if (this.nativeRunner && !job.formatOnly && !lightweight(job.kind) && repo.localPath && !directAudit && job.issueSnapshot.type !== 'pr') {
        await validateCheckout(repo.localPath, repo);
        try { await git(repo.localPath, ['cat-file','-e',`${job.baseSha}^{commit}`],false,controller.signal); }
        catch { if(repo.mode === 'local') throw new Error('本地提交已不可用，请重新检测工作区'); await git(repo.localPath, ['fetch','origin',job.baseSha],true,controller.signal,120000); }
      }
      progress(lightweight(job.kind) ? '使用缓存仓库摘要；轻量任务不创建代码工作区' : '读取仓库结构、开发约定、构建配置与测试入口');
      repo = { ...repo, headSha: job.baseSha };
      if (lightweight(job.kind) && repo.profile) repo.profile = { ...repo.profile, sources: [], warnings: [...repo.profile.warnings, '轻量分诊仅使用缓存结构摘要，未读取源代码'] };
      if (!job.formatOnly && !lightweight(job.kind) && !directAudit) repo.profile = await this.understand(repo, controller.signal);
      if (this.nativeRunner && !job.formatOnly && repo.localPath && !lightweight(job.kind) && !directAudit) {
        const worktree = await prepareWorktree(repo, job, this.dataDir);
        job = { ...job, worktree: worktree.path, branch: worktree.branch };
        controller.signal.throwIfAborted();
        this.saveJob(job); progress(`已创建独立分支 ${worktree.branch}`);
      }
      controller.signal.throwIfAborted();
      if (this.nativeRunner && !job.worktree && !job.analysisPath) {
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
      const readOnlyStage = ['review','validate','ci'].includes(job.kind) || job.issueSnapshot.organizeMode === 'audit' && job.kind === 'investigate';
      const inputPatch = job.worktree && readOnlyStage ? await collectPatch(job.worktree, job.baseSha) : '';
      const runner = this.nativeRunner ?? modelRunner;
      output = await runner({ repo, issue: job.issueSnapshot, related, job, settings, signal: controller.signal, progress, recordOutput: text => {
        if (controller.signal.aborted) return;
        job = { ...job, rawOutput: text.slice(0, 200000) };
        this.saveJob({ ...this.job(job.id), rawOutput: job.rawOutput });
      } });
      controller.signal.throwIfAborted();
      const patch = job.worktree ? await collectPatch(job.worktree, job.baseSha) : '';
      controller.signal.throwIfAborted();
      if (readOnlyStage && patch !== inputPatch) throw new Error('分析或验证修改了代码；差异保留在工作区，不能作为已完成产物交付');
      if ((job.kind === 'fix' || job.kind === 'docs') && !patch && !job.issueSnapshot.origin && !job.instructions?.startsWith('Repository documentation maintenance.')) throw new Error('Agent 未产生可审核的代码差异。该任务不能作为已完成的修复交付。');
      this.store.transaction(() => {
        const currentIssue = this.store.get<Issue>('issues', job.issueId)!;
        if (job.kind === 'triage' && revision(currentIssue, this.repo(job.repoId), job.kind) === job.revision) this.store.put('issues', { ...currentIssue, analysis: output.result, analysisRevision: job.revision });
        this.saveJob({ ...job, ...output, patch, waitingReason: undefined, status: ((job.issueSnapshot.origin || job.instructions?.startsWith('Repository documentation maintenance.')) && !patch) || lightweight(job.kind) || ['investigate','validate','ci'].includes(job.kind) ? 'completed' : 'awaiting_review', finishedAt: new Date().toISOString() });
        const artifact = output.artifact;
        const stage = artifact?.stage === 'triage' ? artifact.route : artifact?.stage === 'preflight' ? artifact.readiness : job.kind === 'fix' || job.kind === 'docs' ? 'review' : job.kind;
        if (revision(currentIssue, this.repo(job.repoId), job.kind) === job.revision) this.store.put('issues', { ...this.store.get<Issue>('issues', job.issueId)!, workflow: { stage, reason: artifact?.summary ?? output.result.summary, updatedAt: new Date().toISOString() } });
        this.store.audit('job.completed', `${output.engine} · 产物已保存，未发布远端`, job.id);
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
