/** Pure path matching, also used when displaying execution evidence in the client. */
export function executionWithinWorktree(worktree: string, cwd: string | undefined): boolean {
  if (!cwd) return false;
  const normalize = (path: string) => {
    const parts: string[] = [];
    for (const part of path.replaceAll('\\', '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop(); else parts.push(part);
    }
    return '/' + parts.join('/');
  };
  const alias = (path: string) => normalize(path).replace(/^\/private\/var(?=\/|$)/, '/var');
  const root = alias(worktree);
  const path = alias(/^(?:[A-Za-z]:[\\/]|[\\/])/.test(cwd) ? cwd : `${worktree}/${cwd}`);
  return path === root || path.startsWith(root === '/' ? '/' : root + '/');
}
