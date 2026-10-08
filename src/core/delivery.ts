import { documentAcceptance } from './document-acceptance.ts';
import { assertReviewEvidence } from './review-evidence.ts';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { collectPatch, git } from './git.ts';
import { GitHub } from './github.ts';
import { revision } from './revision.ts';
import { validationState } from './workflow-state.ts';
import type { Store } from './store.ts';
import type { Issue, Job, Repo } from './types.ts';

export interface DeliveryTarget { reviewJobId: string; validationJobId: string; implementationJobId: string; patchSha256: string; baseSha: string; bindingStamp: string }

function bindingStamp(store: Store, reviewId: string): string {
  const rows: Job[] = [], seen = new Set<string>();
  let id: string | undefined = reviewId;
  while (id) {
    if (seen.has(id) || rows.length >= 30) throw new Error('交接链已变化');
    seen.add(id);
    const job: Job | undefined = store.get<Job>('jobs', id);
    if (!job) throw new Error('交接来源已变化');
    // These fields are written by this same publication operation after validation.
    rows.push({ ...job, publications: undefined, publishedCommit: undefined });
    if (['fix', 'docs'].includes(job.kind)) break;
    id = job.sourceJobId;
  }
  const review = rows[0], repo = store.get<Repo>('repos', review.repoId), issue = store.get<Issue>('issues', review.issueId);
  if (!repo || !issue) throw new Error('交接输入已变化');
  return createHash('sha256').update(JSON.stringify({ rows, repo: [repo.id, repo.fullName, repo.defaultBranch, repo.headSha], issueRevision: revision(issue, repo, review.kind), state: issue.state })).digest('hex');
}

/** Synchronous last-moment check: do not let an intervening await publish a revoked approval. */
export function assertDeliveryCurrent(store: Store, delivery: DeliveryTarget): void {
  if (bindingStamp(store, delivery.reviewJobId) !== delivery.bindingStamp) throw new Error('审查或交接状态在发布前已变化，请重新确认');
}

/** Resolve only an approved review of the exact validated implementation; never approve or publish it. */
export async function resolveDelivery(store: Store, repo: Repo, reviewId: string, github = new GitHub(), options: { allowPublishedHead?: boolean } = {}): Promise<DeliveryTarget> {
  const read = (id: string) => { const job = store.get<Job>('jobs', id); if (!job) throw new Error('交接来源不存在'); return job; };
  const review = read(reviewId);
  if (review.kind !== 'review' || review.status !== 'approved' || review.artifact?.stage !== 'review') throw new Error('独立审查尚未批准，不能交接发布');
  if (review.artifact.verdict === 'incomplete' || review.artifact.blockers.length || review.artifact.findings.some(f => !['dismissed', 'resolved'].includes(review.findingDecisions?.[f.id] ?? ''))) throw new Error('审查仍有未处理的发现或阻塞');
  await assertReviewEvidence(review);
  const chain: Job[] = [review], seen = new Set([review.id]);
  let cursor = review, validation: Job | undefined;
  while (!['fix', 'docs'].includes(cursor.kind)) {
    if (!cursor.sourceJobId || seen.has(cursor.sourceJobId) || chain.length >= 30) throw new Error('未找到可靠的原实施产物交接链');
    cursor = read(cursor.sourceJobId); seen.add(cursor.id); chain.push(cursor);
    if (cursor.kind === 'validate' && !validation) validation = cursor;
    if (!['review', 'validate', 'fix', 'docs'].includes(cursor.kind)) throw new Error('审查未直接关联已验证的实施产物');
  }
  const implementation = cursor;
  if (!validation || !['completed', 'approved'].includes(validation.status) || validationState(validation.artifact ? documentAcceptance(validation.artifact, validation) : undefined)?.state !== 'passed') throw new Error('完整验证尚未通过，请先修订或补齐验证');
  if (!['awaiting_review', 'approved'].includes(implementation.status) || !implementation.patch) throw new Error('实施产物尚不可交接发布');
  const issue = store.get<Issue>('issues', review.issueId);
  if (!issue || issue.state !== 'open' || repo.id !== review.repoId) throw new Error('事项状态或仓库已变化');
  const fingerprint = (job: Job) => JSON.stringify(job);
  const originals = new Map(chain.map(job => [job.id, fingerprint(job)]));
  const workspaces = new Set<string>();
  for (const job of chain) {
    if (job.repoId !== review.repoId || job.issueId !== review.issueId || job.issueSnapshot.number !== issue.number || job.revision !== revision(issue, repo, job.kind) || job.baseSha !== review.baseSha || job.patch !== implementation.patch) throw new Error('审查、验证与实施不是同一事项的同一版本和补丁');
    if (!job.worktree || !job.branch) throw new Error('缺少可核验的独立工作区');
    const workspace = await realpath(job.worktree);
    if (workspaces.has(workspace)) throw new Error('实施、验证和审查必须使用独立工作区');
    workspaces.add(workspace);
    const expectedHead = job.kind === 'fix' || job.kind === 'docs' ? job.publishedCommit ?? job.baseSha : job.baseSha;
    if (await git(job.worktree, ['rev-parse', 'HEAD']) !== expectedHead || await git(job.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']) !== job.branch || await collectPatch(job.worktree, job.baseSha) !== job.patch) throw new Error('工作区分支、HEAD 或补丁已变化，请重新验证与审查');
    if (review.prContext && (!job.prContext || ['headSha', 'baseSha', 'headRef', 'headRepo', 'baseRef'].some(key => Reflect.get(job.prContext!, key) !== Reflect.get(review.prContext!, key)))) throw new Error('PR 审查目标不一致');
  }
  if (review.prContext) {
    const live = await github.pullRequest(repo, issue.number);
    const permittedHead = live.headSha === review.prContext.headSha || (options.allowPublishedHead && implementation.publishedCommit && live.headSha === implementation.publishedCommit);
    if (live.merged || !permittedHead || ['baseSha', 'headRef', 'headRepo', 'baseRef'].some(key => Reflect.get(live, key) !== Reflect.get(review.prContext!, key))) throw new Error('PR head/base 或目标分支已变化');
  } else {
    const live = await github.request(`/repos/${repo.fullName}/commits/${encodeURIComponent(repo.defaultBranch)}`) as { sha?: string };
    if (live.sha !== implementation.baseSha) throw new Error('远端代码基线已变化或无法核对，请同步后重新验证');
  }
  for (const job of chain) if (fingerprint(read(job.id)) !== originals.get(job.id)) throw new Error('核验期间产物状态已变化，请重试');
  const currentIssue = store.get<Issue>('issues', review.issueId);
  const currentRepo = store.get<Repo>('repos', review.repoId);
  if (!currentIssue || !currentRepo || currentRepo.defaultBranch !== repo.defaultBranch || currentRepo.fullName !== repo.fullName || currentIssue.state !== 'open' || review.revision !== revision(currentIssue, currentRepo, review.kind)) throw new Error('核验期间输入版本已变化');
  return { reviewJobId: review.id, validationJobId: validation.id, implementationJobId: implementation.id, patchSha256: createHash('sha256').update(implementation.patch).digest('hex'), baseSha: implementation.baseSha, bindingStamp: bindingStamp(store, review.id) };
}
