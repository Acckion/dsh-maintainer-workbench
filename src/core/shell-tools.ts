/** Host shell tools: `dsh-tool-bash` registers `bash`; Windows hosts load `dsh-tool-pwsh` (`pwsh`). */
export const shellToolCandidates = ['bash', 'pwsh'] as const;

export function isShellToolName(name: string): boolean {
  return (shellToolCandidates as readonly string[]).includes(name);
}

/** The shell tool name this platform's host registers. */
export function platformShellTool(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'pwsh' : 'bash';
}

/**
 * Resolve the global shell tool from the names visible to the agent scope before restrict().
 * `tools.restrict()` rejects unknown global names, so a hardcoded `bash` fails agent setup on
 * Windows hosts where the global shell tool is `pwsh`. Returns undefined when no known shell
 * tool is visible, so stage restrictions degrade instead of throwing during setup.
 */
export function resolveShellTool(visibleNames: readonly string[], platform: NodeJS.Platform = process.platform): string | undefined {
  const visible = new Set(visibleNames);
  const preferred = platform === 'win32' ? ['pwsh', 'bash'] : ['bash', 'pwsh'];
  return preferred.find(name => visible.has(name));
}
