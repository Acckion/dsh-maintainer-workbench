import { prNumber, type RemotePR, type ActionsSnapshot, type ActionsLog } from './remote-progress.ts';
import { resolveGitHubAuth } from './github-auth.ts';
import { contextPaths, repositoryProfile } from './repository-context.ts';
import { z } from 'zod';
import type { InformationRequest, Issue, Repo, ReviewThread, ThreadSnapshot } from './types.ts';
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const issueSchema = z.object({ number: z.number(), title: z.string(), body: z.string().nullable(), user: z.object({ login: z.string() }).nullable(), labels: z.array(z.union([z.string(), z.object({ name: z.string() })])), state: z.enum(['open', 'closed']), comments: z.number(), updated_at: z.string(), html_url: z.string().url(), pull_request: z.object({ url: z.string(), merged_at:z.string().nullable().optional() }).optional() });
export class GitHub {
  constructor(private token?: string, private fetcher: typeof fetch = fetch) {}
  async request(path: string, init: RequestInit = {}, beforeSend?: () => void): Promise<unknown> {
    const auth = await resolveGitHubAuth(this.token);
    beforeSend?.();
    const response = await this.fetcher(`https://api.github.com${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(30000), headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'maintainer-workbench/0.1', ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}), ...init.headers } });
    if (!response.ok) throw new Error(`GitHub ${response.status}${response.status === 403 || response.status === 429 ? '：权限不足或 API 限流，请检查账号的仓库权限、组织 SSO 授权或 API 限额' : response.status === 404 ? '：仓库不存在，或令牌无读取权限' : response.status === 401 ? '：GitHub 登录已失效，请重新登录或更新令牌' : '：请求失败'}`);
    return response.json();
  }
  async connection() {
    const auth = await resolveGitHubAuth(this.token);
    if (!auth.token) return { source: auth.source, authenticated: false };
    try {
      const user = z.object({ login: z.string() }).parse(await new GitHub(auth.token, this.fetcher).request('/user'));
      return { source: auth.source, authenticated: true, login: user.login };
    } catch (error) { return { source: auth.source, authenticated: false, error: error instanceof Error ? error.message : '连接验证失败' }; }
  }
  async sync(fullName: string): Promise<{ repo: Repo; issues: Issue[] }> {
    nameSchema.parse(fullName);
    const meta = z.object({ full_name: z.string(), description: z.string().nullable(), default_branch: z.string(), private: z.boolean().optional() }).parse(await this.request(`/repos/${fullName}`));
    const commit = z.object({ sha: z.string() }).parse(await this.request(`/repos/${fullName}/commits/${encodeURIComponent(meta.default_branch)}`));
    const issues: Issue[] = [];
    let truncated = false;
    for (let page = 1; page <= 10; page++) {
      const rows = z.array(issueSchema).parse(await this.request(`/repos/${fullName}/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`));
      for (const row of rows) issues.push({ id: `${meta.full_name}#${row.number}`, repoId: meta.full_name, number: row.number, type: row.pull_request ? 'pr' : 'issue', merged: row.pull_request?.merged_at ? true : row.pull_request?.merged_at === null ? false : undefined, title: row.title, body: row.body ?? '', author: row.user?.login ?? 'deleted', labels: row.labels.map(l => typeof l === 'string' ? l : l.name), state: row.state, comments: row.comments, updatedAt: row.updated_at, url: row.html_url });
      if (rows.length < 100) break;
      if (page === 10) truncated = true;
    }
    let prWarning = '';
    if (issues.some(i => i.type === 'pr' && i.state === 'open')) {
      try {
        for (let page = 1; page <= 10; page++) {
          const prs = z.array(z.object({ number: z.number(), head: z.object({ sha:z.string() }), base:z.object({ sha:z.string() }) })).parse(await this.request(`/repos/${fullName}/pulls?state=open&per_page=100&page=${page}`));
          for (const pr of prs) { const issue = issues.find(i => i.type === 'pr' && i.number === pr.number); if (issue) { issue.headSha = pr.head.sha; issue.prBaseSha = pr.base.sha; } }
          if (prs.length < 100) break;
        }
      } catch { prWarning = 'PR 版本列表未完整获取；执行和发布前会再次固定远端版本。'; }
    }
    return { repo: { id: meta.full_name, fullName: meta.full_name, description: meta.description ?? '', private: meta.private, defaultBranch: meta.default_branch, headSha: commit.sha, localPath: '', mode: 'github', syncedAt: new Date().toISOString(), syncWarning: [truncated ? '只同步最近更新的 1000 条记录，较早的记录未覆盖。' : '', prWarning].filter(Boolean).join(' ') || null }, issues };
  }
  async profile(repo: Repo, signal?: AbortSignal) {
    try {
      const tree = z.object({ truncated: z.boolean().optional(), tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string().optional() })) }).parse(await this.request(`/repos/${repo.fullName}/git/trees/${repo.headSha}?recursive=1`, { signal }));
      const files = tree.tree.filter(f => f.type === 'blob').map(f => f.path);
      const warnings = tree.truncated ? ['GitHub tree is truncated; repository map is partial.'] : [];
      const sources: { path: string; content: string }[] = [];
      const paths = contextPaths(files).filter(p => tree.tree.some(f => f.path === p && f.mode !== '120000')).slice(0, 6);
      for (const path of paths) {
        try {
          const blob = z.object({ content: z.string(), encoding: z.literal('base64') }).parse(await this.request(`/repos/${repo.fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${repo.headSha}`, { signal }));
          const content = Buffer.from(blob.content, 'base64').toString('utf8'); sources.push({ path, content: content.slice(0, 6000) });
          if (content.length > 6000) warnings.push(`Excerpt truncated: ${path}`);
        } catch (e) { if (signal?.aborted) throw e; warnings.push(`Could not read ${path}`); }
      }
      warnings.push('Remote map includes at most 6 document excerpts. Additional source and tests have not been read or executed.');
      return repositoryProfile(repo.headSha, files, sources, warnings);
    } catch (e) { if (signal?.aborted) throw e; return repositoryProfile(repo.headSha, [], [], ['Repository map unavailable; do not assume source was inspected.']); }
  }
  async pullRequest(repo: Repo, number: number, signal?: AbortSignal): Promise<import('./types.ts').PRContext> {
    const pr = z.object({ head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/), ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }), base: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/), ref: z.string() }), draft: z.boolean(), merged: z.boolean(), mergeable: z.boolean().nullable() }).parse(await this.request(`/repos/${repo.fullName}/pulls/${number}`, { signal }));
    const warnings: string[] = [];
    const optional = async (path: string) => { try { return await this.request(path, { signal }); } catch (e) { if (signal?.aborted) throw e; warnings.push(`无法读取 ${path}: ${e instanceof Error ? e.message : '未知错误'}`); return null; } };
    const [checks, reviews, reviewComments, commitStatus] = await Promise.all([optional(`/repos/${repo.fullName}/commits/${pr.head.sha}/check-runs?per_page=100`), optional(`/repos/${repo.fullName}/pulls/${number}/reviews?per_page=100`), optional(`/repos/${repo.fullName}/pulls/${number}/comments?per_page=100`), optional(`/repos/${repo.fullName}/commits/${pr.head.sha}/status`)]);
    return { headSha: pr.head.sha, baseSha: pr.base.sha, headRef: pr.head.ref, headRepo: pr.head.repo?.full_name ?? null, baseRef: pr.base.ref, draft: pr.draft, merged: pr.merged, mergeable: pr.mergeable, checks, reviews, reviewComments, commitStatus, warnings: [...warnings, '检查和审查最多各 100 条；分支保护规则和未解决讨论未完整覆盖，不构成合并许可。'] };
  }
  async context(repo: Repo, issue: Issue, signal: AbortSignal, metadataOnly = false, expected?: import('./types.ts').PRContext): Promise<string> {
    const comments = await this.request(`/repos/${repo.fullName}/issues/${issue.number}/comments?per_page=30`, { signal });
    let extra: unknown = null;
    if (issue.type === 'pr' && !metadataOnly) {
      const pr = z.object({ head: z.object({ sha: z.string() }), base: z.object({ sha: z.string() }), changed_files: z.number() }).parse(await this.request(`/repos/${repo.fullName}/pulls/${issue.number}`, { signal }));
      if (expected && (pr.head.sha !== expected.headSha || pr.base.sha !== expected.baseSha)) throw new Error('PR 在上下文读取期间已更新，请同步后重试');
      const files = await this.request(`/repos/${repo.fullName}/pulls/${issue.number}/files?per_page=100`, { signal });
      const after = z.object({ head:z.object({sha:z.string()}), base:z.object({sha:z.string()}) }).parse(await this.request(`/repos/${repo.fullName}/pulls/${issue.number}`, {signal}));
      if (after.head.sha !== pr.head.sha || after.base.sha !== pr.base.sha) throw new Error('读取 diff 时 PR 已更新，请同步后重试');
      extra = { ...pr, files, coverage: pr.changed_files > 100 ? 'Only first 100 files; partial review' : 'Up to 100 files; patches may be truncated by GitHub' };
    }
    return JSON.stringify({ comments, pullRequest: extra }).slice(0, metadataOnly ? 12000 : 65000);
  }
  async remotePR(repo: Repo, url: string): Promise<RemotePR> {
    const number = prNumber(url, repo.fullName), [owner, name] = repo.fullName.split('/');
    const raw = await this.graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){url number headRefOid baseRefOid state isDraft reviewDecision mergeStateStatus mergedAt closingIssuesReferences(first:100){pageInfo{hasNextPage} nodes{url}} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}}`, {owner,name,number});
    const pr = z.object({repository:z.object({pullRequest:z.object({url:z.string().url(),number:z.number(),headRefOid:z.string(),baseRefOid:z.string(),state:z.string(),isDraft:z.boolean(),reviewDecision:z.string().nullable(),mergeStateStatus:z.string(),mergedAt:z.string().nullable(),closingIssuesReferences:z.object({pageInfo:z.object({hasNextPage:z.boolean()}),nodes:z.array(z.object({url:z.string()}))}),commits:z.object({nodes:z.array(z.object({commit:z.object({statusCheckRollup:z.object({contexts:z.object({pageInfo:z.object({hasNextPage:z.boolean()}),nodes:z.array(z.object({__typename:z.string(),name:z.string().optional(),status:z.string().optional(),conclusion:z.string().nullable().optional(),context:z.string().optional(),state:z.string().optional()}))})}).nullable()})}))})})})}).parse(raw).repository.pullRequest;
    if (pr.number !== number || prNumber(pr.url, repo.fullName) !== number) throw Error('GitHub 返回的 PR 目标不一致');
    const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
    return {url:pr.url,number,headSha:pr.headRefOid,baseSha:pr.baseRefOid,state:pr.state,draft:pr.isDraft,review:pr.reviewDecision,mergeState:pr.mergeStateStatus,mergedAt:pr.mergedAt,checks:(contexts?.nodes ?? []).map(c=>({name:c.name ?? c.context ?? 'unknown',status:c.status ?? (c.state === 'PENDING' ? 'IN_PROGRESS':'COMPLETED'),conclusion:c.conclusion ?? c.state ?? null})),closingIssues:pr.closingIssuesReferences.nodes.map(i=>i.url),partial:!contexts || contexts.pageInfo.hasNextPage || pr.closingIssuesReferences.pageInfo.hasNextPage,syncedAt:new Date().toISOString()};
  }
  async actions(repo: Repo, headSha: string, signal?: AbortSignal): Promise<ActionsSnapshot> {
    z.string().regex(/^[a-f0-9]{40,64}$/).parse(headSha);
    const root = `/repos/${repo.fullName}/actions`, warnings: string[] = [], jobs: ActionsSnapshot['jobs'] = [];
    const runs = z.object({total_count:z.number(),workflow_runs:z.array(z.object({id:z.number().int().positive(),head_sha:z.string(),run_attempt:z.number().int().positive()}))}).parse(await this.request(`${root}/runs?head_sha=${headSha}&per_page=20`,{signal}));
    if (runs.total_count > 20) warnings.push('仅覆盖当前提交最近 20 个 workflow run');
    for (const run of runs.workflow_runs) {
      if (run.head_sha !== headSha) { warnings.push('忽略了其他提交的 run'); continue; }
      if (run.run_attempt > 3) warnings.push(`run ${run.id} 仅覆盖最近 3 次执行`);
      for (let attempt=run.run_attempt;attempt>=Math.max(1,run.run_attempt-2);attempt--) {
        try {
          const list=z.object({total_count:z.number(),jobs:z.array(z.object({id:z.number().int().positive(),run_id:z.number(),head_sha:z.string(),name:z.string(),html_url:z.string().url(),status:z.string(),conclusion:z.string().nullable(),steps:z.array(z.object({name:z.string(),number:z.number(),status:z.string(),conclusion:z.string().nullable()})).optional()}))}).parse(await this.request(`${root}/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`,{signal}));
          if (list.total_count>100) warnings.push(`run ${run.id}/${attempt} 仅覆盖前 100 个 job`);
          for (const j of list.jobs) if(j.head_sha===headSha && j.run_id===run.id) jobs.push({id:j.id,runId:run.id,attempt,headSha,name:j.name,url:j.html_url,status:j.status,conclusion:j.conclusion,steps:j.steps ?? []}); else warnings.push('忽略了目标不一致的 job');
        } catch(e) { if(signal?.aborted) throw e; warnings.push(`run ${run.id}/${attempt} 读取失败：${e instanceof Error ? e.message:'未知错误'}`); }
      }
    }
    return {headSha,syncedAt:new Date().toISOString(),jobs,warnings};
  }
  async actionLog(repo: Repo, snapshot: ActionsSnapshot, jobId: number, signal?: AbortSignal): Promise<ActionsLog> {
    const job=snapshot.jobs.find(j=>j.id===jobId); if(!job) throw Error('任务不在已同步的 Actions 范围');
    const actual=z.object({id:z.number(),run_id:z.number(),head_sha:z.string()}).parse(await this.request(`/repos/${repo.fullName}/actions/jobs/${jobId}`,{signal}));
    if(actual.id!==job.id || actual.run_id!==job.runId || actual.head_sha!==snapshot.headSha) throw Error('Actions job 目标已变化');
    const auth=await resolveGitHubAuth(this.token);
    const response=await this.fetcher(`https://api.github.com/repos/${repo.fullName}/actions/jobs/${jobId}/logs`,{redirect:'manual',signal:signal ?? AbortSignal.timeout(30000),headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(auth.token ? {Authorization:`Bearer ${auth.token}`} : {})}});
    if(response.status!==302) throw Error(`日志不可读取（HTTP ${response.status}），可能未生成、已过期或无权限`);
    const target=new URL(response.headers.get('location') ?? '');
    if(target.protocol!=='https:' || target.username || target.password || !/(^|\.)(githubusercontent\.com|blob\.core\.windows\.net|actions\.githubusercontent\.com)$/.test(target.hostname)) throw Error('日志下载地址不受支持');
    // Signed log URL receives no GitHub credential and cannot redirect again.
    const log=await this.fetcher(target,{redirect:'error',signal:signal ?? AbortSignal.timeout(30000)});
    if(!log.ok || !log.body) throw Error(`日志下载失败（HTTP ${log.status}）`);
    const reader=log.body.getReader(), chunks:Uint8Array[]=[], limit=512*1024; let size=0,truncated=false;
    try { while(true) {const {done,value}=await reader.read(); if(done) break; const available=limit-size; chunks.push(value.slice(0,available));size+=Math.min(available,value.length);if(value.length>available || size===limit){truncated=true;await reader.cancel();break;}} } finally {reader.releaseLock();}
    return {jobId,runId:job.runId,attempt:job.attempt,headSha:snapshot.headSha,text:Buffer.concat(chunks).toString('utf8'),truncated,fetchedAt:new Date().toISOString()};
  }
  async informationReplies(repo: Repo, issue: Issue, since: string): Promise<{ replies: InformationRequest['replies']; partial: boolean }> {
    const rows = z.array(z.object({ id: z.number(), body: z.string().nullable(), created_at: z.string().datetime(), html_url: z.string().url(), user: z.object({ login: z.string() }).nullable() })).parse(
      await this.request(`/repos/${repo.fullName}/issues/${issue.number}/comments?since=${encodeURIComponent(since)}&per_page=100`));
    return { replies: rows.map(row => ({ id: row.id, body: (row.body ?? '').slice(0, 6000), author: row.user?.login ?? 'deleted', createdAt: row.created_at, url: row.html_url })), partial: rows.length === 100 };
  }
  async graphql(query: string, variables: Record<string, unknown>, beforeSend?: () => void): Promise<unknown> {
    const payload = z.object({ data: z.unknown().optional(), errors: z.array(z.object({ message: z.string() })).optional() }).parse(await this.request('/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }, beforeSend));
    if (payload.errors?.length || !payload.data) throw new Error(`GitHub 讨论串请求失败：${payload.errors?.map(error => error.message).join('; ') ?? '没有可读取的数据'}`);
    return payload.data;
  }
  async threads(repo: Repo, number: number): Promise<ThreadSnapshot> {
    const [owner, name] = repo.fullName.split('/');
    const data = await this.graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid reviewThreads(first:100){pageInfo{hasNextPage} nodes{id path line isResolved isOutdated viewerCanResolve viewerCanUnresolve comments(first:1){nodes{url body}}}}}}}`, { owner, name, number });
    const thread = z.object({ id: z.string(), path: z.string(), line: z.number().nullable(), isResolved: z.boolean(), isOutdated: z.boolean(), viewerCanResolve: z.boolean(), viewerCanUnresolve: z.boolean(), comments: z.object({ nodes: z.array(z.object({ url: z.string().url(), body: z.string() })) }) });
    const pr = z.object({ repository: z.object({ pullRequest: z.object({ headRefOid: z.string(), baseRefOid: z.string(), reviewThreads: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(thread) }) }) }) }).parse(data).repository.pullRequest;
    const threads: ReviewThread[] = pr.reviewThreads.nodes.map(({ comments, ...item }) => ({ ...item, url: comments.nodes[0]?.url ?? '', body: (comments.nodes[0]?.body ?? '').slice(0, 6000) }));
    return { headSha: pr.headRefOid, baseSha: pr.baseRefOid, threads, partial: pr.reviewThreads.pageInfo.hasNextPage, syncedAt: new Date().toISOString() };
  }
  async setThreadResolved(threadId: string, resolved: boolean, beforeSend?: () => void): Promise<void> {
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const data = await this.graphql(`mutation($id:ID!){${mutation}(input:{threadId:$id}){thread{id isResolved}}}`, { id: threadId }, beforeSend);
    const result = z.record(z.object({ thread: z.object({ id: z.string(), isResolved: z.boolean() }) })).parse(data)[mutation]?.thread;
    if (result?.id !== threadId || result.isResolved !== resolved) throw new Error('GitHub 未确认讨论串状态，请重新同步核对。');
  }
}
