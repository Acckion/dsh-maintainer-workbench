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
