import type { Job } from './types.ts';
import { git } from './git.ts';
import { dirname, extname, join, basename } from 'node:path';

/** Discover existing changed code and adjacent conventional tests at the pinned checkout. */
export async function reviewRequiredSources(job: Job): Promise<string[]> {
  if (!job.worktree) return [];
  // A supplied fix can restore the PR base exactly; inspect the fix relative to its own checkout.
  const suppliedChange = job.sourceJobId ? await git(job.worktree, ['diff', '--name-only', '-z', job.baseSha], false, undefined, 30000, true) : '';
  const base = suppliedChange ? job.baseSha : job.prContext?.baseSha ?? job.baseSha;
  const changed = (await git(job.worktree, ['diff', '--name-only', '-z', '--diff-filter=ACMR', base], false, undefined, 30000, true)).split('\0').filter(Boolean);
  const tracked = new Set((await git(job.worktree, ['ls-files', '-z'], false, undefined, 30000, true)).split('\0').filter(Boolean));
  const sources = changed.filter(path => /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb)$/.test(path) && tracked.has(path));
  const paths = new Set(sources);
  for (const path of sources) {
    const ext = extname(path), stem = basename(path, ext), dir = dirname(path);
    for (const name of [`${stem}.test${ext}`, `${stem}.spec${ext}`, `test_${stem}${ext}`, `${stem}_test${ext}`]) {
      const candidate = join(dir, name);
      if (tracked.has(candidate)) paths.add(candidate);
    }
  }
  return [...paths];
}

export const historicalText = (value: string | undefined) => value?.replace(/\bcall_[A-Za-z0-9_-]+\b|\bmaintainer-[A-Za-z0-9-]+:\d+\b/g, '[historical tool reference omitted]');

/** Retain findings for followup, but never offer a historical execution ID as current evidence. */
export function reviewPromptHandoff(handoff: Job['handoff']) {
  return handoff?.map(item => ({
    sourceJobId: item.id, kind: item.kind, revision: item.revision, stale: item.stale,
    evidenceStatus: 'historical_unverified' as const,
    summary: historicalText(item.artifact?.summary ?? item.result?.summary),
    feedback: historicalText(item.feedback),
    findings: item.artifact?.stage === 'review' ? item.artifact.findings.map(f => ({
      id: f.id, title: historicalText(f.title), severity: f.severity, path: f.path, line: f.line,
      trigger: historicalText(f.trigger), recommendation: historicalText(f.recommendation), decision: item.findings?.[f.id],
    })) : [],
  }));
}

export function nativeReviewGuidance(sessionId: string): string {
  return `CURRENT REVIEW EVIDENCE CONTRACT: this is a new independent review in Session ${sessionId}. Before producing findings or no_findings, use this Session's native read/bash tools to read the applicable AGENTS.md instructions, the changed source, and relevant existing tests. Use actual filesystem paths, without an @ prefix. Loading a skill, reading a prior report, or obtaining another reviewer's output does not establish source inspection. Read source directly in this Session even when a review skill is available; do not delegate this evidence collection. Every path in reviewRequiredSources is mandatory: read each file in full (in bounded segments if needed) and include at least one exact line citation per file in inspectedSources before returning a completed verdict. Only cite tool call IDs returned by your own current-session tool calls. Handoff entries are historical hints marked historical_unverified: their sourceJobId and finding IDs identify followups, never execution evidence. Recheck their claims from current source; do not copy their coverage or findings as verified. Each inspectedSources entry must reference a successful current source read. If you cannot collect evidence, return incomplete with blockers, not an invented or historical tool ID.`;
}
