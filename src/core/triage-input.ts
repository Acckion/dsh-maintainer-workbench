import {requiredCIGates} from './preflight-policy.ts';
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
    repository: {knownLabels:[...new Set([...issue.labels,...related.flatMap(item=>item.labels)])].slice(0,40),name:repo.githubName ?? repo.fullName,languages:repo.profile?.languages,roots:repo.profile?.roots.slice(0,12),guidance:repo.profile?.sources.filter(s=>/AGENTS|CONTRIBUTING|README/.test(s.path)).slice(0,3).map(s=>({path:s.path,excerpt:s.content.slice(0,800)})),guidanceCoverage:'At most 3 cached excerpts, 800 characters each; execution must read full applicable guidance.'},
    issue:{number:issue.number,title:issue.title,body,labels:issue.labels,comments:issue.comments},
    related:related.slice(0,6).map(i=>({number:i.number,title:i.title,body:i.body.slice(0,500)})),
    comments,
    coverage:{bodyTruncated:issue.body.length>body.length,commentsIncluded:comments.length,commentsTotal:issue.comments,commentsWindow:issue.comments>30 ? 'Sample from first 30 comments; newer discussion may be absent' : 'Up to 5 comments',relatedIncluded:Math.min(related.length,6),sourceCodeRead:false},
  };
}
export const triageBudgetPrompt = 'Metadata routing only. No tools, source inspection, testing or speculative diagnosis. Use supplied evidence to classify and suggest one next stage. At most 3 evidence items, 3 next steps and 3 missing-information items. Also bound planDraft to at most 3 acceptance criteria, 3 source references and 3 gaps; each goal/scope/reproduction/expected/actual string at most 100 Chinese characters, each source detail and gap summary/resolution at most 60 Chinese characters. Do not duplicate gap descriptions across missingInfo, responseDraft and plan fields; group related reporter facts into one gap. Submit the concise final report directly through the reporting interface, without lengthy explanatory prose. Keep each short; responseDraft at most 150 Chinese characters. Do not repeat fields. Disclose truncated or unavailable discussion in coverage. Absence of source inspection is the scope, not a blocker.';

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
    available:{checks:pr.checks!==null,reviews:pr.reviews!==null,statuses:pr.commitStatus!=null},checks:records(pr.checks,'check_runs'),reviews:records(pr.reviews),statuses:records(pr.commitStatus,'statuses'),warnings:pr.warnings,requiredCIGates:requiredCIGates(pr),requiredCICoverage:{protection:pr.branchProtection!=null,rules:pr.branchRules!=null},
    coverage:'Metadata only; no diff, source or inline review threads. At most 30 records per status group; unavailable groups are unknown.'} : undefined };
}
export const preflightBudgetPrompt='Quick PR metadata preflight only. No tools or source review. Summarize intent, draft state, visible checks and review decisions; choose review for a non-draft PR with usable head/base metadata unless a concrete local-review blocker exists. Readiness is independent of plan authorization: readiness=review and an unconfirmed planDraft coexist. Plan confirmation never changes readiness to draft. CI unavailable, empty, pending or failed checks are coverage limitations for local review, not review blockers. Only host-confirmed required CI gates can block operations that depend on them at delivery; never infer required gates from check existence, missing permissions or missing records. Do not block exporting patches, updating a PR or posting review findings for CI. Missing diff inspection is the scope, not a blocker. Do not grant merge approval. At most 3 risks, 3 evidence items and 3 next steps. Keep replies brief.';

export const classificationPrompt = 'Classify the Issue purpose or PR change intent as bug (incorrect behavior), feature (new capability), docs, question (usage/support), or maintenance (refactor/build/CI/dependencies). Priority is impact/urgency, never review finding severity: P0 evidenced active critical outage or exploitation; P1 substantial broken core behavior; P2 normal actionable work; P3 low-impact cosmetic or minor housekeeping. With limited evidence use P2 provisionally and disclose uncertainty in coverage; do not infer urgency from draft state, missing CI permissions or lack of source inspection. Always provide category, priority and labels (empty is valid). At most 3 concise suggested labels; prefer provided repository label names and avoid duplicates, priority/type aliases or invented project taxonomy. These are local suggestions, not instructions to publish labels.';
