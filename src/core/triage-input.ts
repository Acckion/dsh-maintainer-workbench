import type { Issue, Repo } from './types.ts';

/** Bounded metadata only; never send stored analysis, workflows or whole GitHub users. */
export function triageInput(repo: Repo, issue: Issue, related: Issue[], context: string) {
  const body = issue.body.slice(0, 6000);
  let comments: unknown[] = [];
  try {
    const raw = JSON.parse(context).comments;
    if (Array.isArray(raw)) comments = raw.slice(-5).map(c => ({author:c.user?.login ?? c.author,body:String(c.body ?? '').slice(0,800)}));
  } catch { /* Missing context is reported explicitly, never passed as broken JSON. */ }
  return {
    repository: {name:repo.githubName ?? repo.fullName,languages:repo.profile?.languages,roots:repo.profile?.roots.slice(0,12)},
    issue:{number:issue.number,title:issue.title,body,labels:issue.labels,comments:issue.comments},
    related:related.slice(0,6).map(i=>({number:i.number,title:i.title,body:i.body.slice(0,500)})),
    comments,
    coverage:{bodyTruncated:issue.body.length>body.length,commentsIncluded:comments.length,commentsTotal:issue.comments,commentsWindow:issue.comments>30 ? 'Sample from first 30 comments; newer discussion may be absent' : 'Up to 5 comments',relatedIncluded:Math.min(related.length,6),sourceCodeRead:false},
  };
}
export const triageBudgetPrompt = 'Metadata routing only. No tools, source inspection, testing or speculative diagnosis. Use supplied evidence to classify and suggest one next stage. At most 3 evidence items, 3 next steps and 3 missing-information items. Keep each short; responseDraft at most 150 Chinese characters. Do not repeat fields. Disclose truncated or unavailable discussion in coverage. Absence of source inspection is the scope, not a blocker.';

/** PR quick routing retains decisions/statuses, excluding full review bodies and diff. */
export function preflightInput(repo: Repo, issue: Issue, pr: import('./types.ts').PRContext | undefined) {
  function records(value: unknown, field?: string): unknown[] {
    const rows=field && value && typeof value==='object' ? (value as Record<string,unknown>)[field] : value;
    return Array.isArray(rows) ? rows.slice(0,30).map(row=>{
      const r=row as Record<string,unknown>;
      return {name:r.name ?? r.context,status:r.status,state:r.state,conclusion:r.conclusion,commit:r.commit_id};
    }) : [];
  }
  return { ...triageInput(repo,issue,[],''), pr:pr ? {headSha:pr.headSha,baseSha:pr.baseSha,draft:pr.draft,merged:pr.merged,mergeable:pr.mergeable,
    available:{checks:pr.checks!==null,reviews:pr.reviews!==null,statuses:pr.commitStatus!=null},checks:records(pr.checks,'check_runs'),reviews:records(pr.reviews),statuses:records(pr.commitStatus,'statuses'),warnings:pr.warnings,
    coverage:'Metadata only; no diff, source or inline review threads. At most 30 records per status group; unavailable groups are unknown.'} : undefined };
}
export const preflightBudgetPrompt='Quick PR metadata preflight only. No tools or source review. Summarize intent, draft state, visible checks and review decisions; choose review or a concrete blocker. Missing CI permissions mean unknown, not a failed check. Missing diff inspection is the scope, not a blocker. Do not grant merge approval. At most 3 risks, 3 evidence items and 3 next steps. Keep replies brief.';
