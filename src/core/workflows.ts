import { readFileSync, existsSync } from 'node:fs';
import type { JobKind } from './types.ts';
const root = [new URL('./skills/', import.meta.url), new URL('../skills/', import.meta.url), new URL('../../skills/', import.meta.url)].find(url => existsSync(url));
if (!root) throw new Error('Missing packaged maintainer workflows');
const cache = new Map<JobKind, string>();
export function taskPrompt(kind: JobKind, checkout: boolean): string {
  let text = cache.get(kind);
  if (!text) { text = readFileSync(new URL(`maintainer-${kind}/SKILL.md`, root), 'utf8').replace(/^---[\s\S]*?---\s*/, ''); cache.set(kind, text); }
  return `${text}\nEXECUTION SCOPE: ${checkout ? 'Dedicated repository worktree at the recorded base commit. Host permissions apply.' : 'Metadata-only workspace: there is NO repository checkout here. Analyze only the provided remote metadata. Do not inspect unrelated local directories or claim local source/test verification. If the stage includes test records, unexecuted tests must be not_run. Put scope limits in coverage once, not in the external reply. Recommend an executable next stage when metadata alone is insufficient.'}`;
}
