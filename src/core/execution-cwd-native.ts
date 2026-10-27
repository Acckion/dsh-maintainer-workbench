import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { executionWithinWorktree as lexicalMatch } from './execution-cwd.ts';

/** Host-recorded commands may run in a subdirectory of the pinned checkout. */
export function executionWithinWorktree(worktree: string, cwd: string | undefined): boolean {
  if (!cwd) return false;
  const root = resolve(worktree), candidate = resolve(root, cwd);
  const contained = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  try {
    const actualRoot = realpathSync(root);
    try { return contained(actualRoot, realpathSync(candidate)); }
    catch { return false; }
  } catch {
    // Offline/synthetic contexts may have no checkout; identity and version checks still apply.
    return lexicalMatch(root, candidate);
  }
}
