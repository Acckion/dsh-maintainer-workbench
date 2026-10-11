import { readFileSync, existsSync } from 'node:fs';
import type { JobKind } from './types.ts';
const root = [new URL('./skills/', import.meta.url), new URL('../skills/', import.meta.url), new URL('../../skills/', import.meta.url)].find(url => existsSync(url));
if (!root) throw new Error('Missing packaged maintainer workflows');
const cache = new Map<JobKind, string>();
export const independentStageGuidance = 'INDEPENDENT STAGE: execute only the requested node. Previous stages are optional context and may not have run. Use the supplied maintainer instructions for the missing goal, scope and background; never invent prior results or require a prior stage solely to begin this one. If the information is still insufficient, request concrete missing input. Without a source patch, validation or review targets the recorded checkout and the explicitly supplied scope; do not claim to have validated an absent patch. Accepted scope, host permissions and current execution-evidence requirements still apply. Do not automatically start another stage.';
export function taskPrompt(kind: JobKind, checkout: boolean): string {
  let text = cache.get(kind);
  if (!text) { text = readFileSync(new URL(`maintainer-${kind}/SKILL.md`, root), 'utf8').replace(/^---[\s\S]*?---\s*/, ''); cache.set(kind, text); }
  return `${text}\nEXECUTION SCOPE: ${checkout ? 'Dedicated repository worktree at the recorded base commit. Host permissions apply.' : 'Metadata-only workspace: there is NO repository checkout here. Analyze only the provided remote metadata. Do not inspect unrelated local directories or claim local source/test verification. If the stage includes test records, unexecuted tests must be not_run. Put scope limits in coverage once, not in the external reply. Recommend an executable next stage when metadata alone is insufficient.'}`;
}
