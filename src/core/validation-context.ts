import type { Job } from './types.ts';
import { historicalText } from './review-context.ts';

/** Only the supplied patch's producer provides hints; old review verdicts are not validation inputs. */
export function validationPromptHandoff(job: Pick<Job, 'sourceJobId' | 'handoff'>) {
  return job.handoff?.filter(item => item.id === job.sourceJobId).map(item => {
    const artifact = item.artifact;
    return { sourceJobId: item.id, kind: item.kind, revision: item.revision, evidenceStatus: 'historical_unverified',
      summary: historicalText(artifact?.summary),
      changes: artifact && 'changes' in artifact ? artifact.changes.map(historicalText) : [],
      acceptanceCriteria: artifact && 'acceptanceCriteria' in artifact ? artifact.acceptanceCriteria.map(historicalText) : [],
      suggestedCommands: artifact && 'tests' in artifact ? artifact.tests.map(test => historicalText(test.command)) : [],
    };
  });
}

export function nativeValidationGuidance(sessionId: string, permission?: string): string {
  return `CURRENT VALIDATION CONTRACT: Session ${sessionId} uses host permission preset ${permission ?? 'inherited'} and validates the supplied patch already applied to this worktree, not the original remote PR diff. Read current source and tests in bounded segments (read limit at most 20 lines, offset for subsequent segments); locate relevant headings with targeted grep rather than reading full documents; current source takes precedence over historical PR descriptions. Actually execute relevant checks with native tools before reporting. Use the available native shell (bash or pwsh) for checks; missing edit/write tools is intentional validation scope, not evidence that tests are forbidden. Do not claim a permission failure unless a real tool result rejects the command. Historical commands are suggestions to rerun, never successful execution evidence. Do not copy old findings, blockers, coverage or IDs, and do not produce a review verdict. Only current-session, current-version process records prove test execution. Honor the requested validation scope. If required checks within that scope are unavailable, explicitly include them as not_run with blockers. Unrequested whole-repository tests are a coverage limitation, not an automatic blocker. A smaller probe does not replace a required Vitest file. Do not edit source, install or link shared dependencies, escalate permissions, delegate, commit or publish. On a genuine environment or permission blocker, preserve it and report incomplete validation honestly.`;
}

/** Validation uses local inspection/checks; installing tools is outside this stage. */
export const validationTools = ['read', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill'];
export function validationCommandBlocker(name: string, args: unknown): string | undefined {
  if (!['bash', 'pwsh'].includes(name) || !args || typeof args !== 'object' || !('command' in args) || typeof args.command !== 'string') return;
  const command = args.command;
  if (/(?:^|[\s;&|])(?:\S*\/)?(?:brew\s+(?:install|upgrade|reinstall|uninstall)|(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|update|upgrade|remove|uninstall|dlx)|(?:pip|pip3)\s+install|(?:apt|apt-get)\s+install)(?:\s|$)/.test(command)
    || /(?:^|[\s;&|])npx(?:\s|$)/.test(command) && !command.includes('--no-install')) return '验证阶段禁止安装或变更工具/依赖。请使用现有本地检查，缺失工具应记录为 not_run；不得升级权限。';
}

export { validationInstructions } from './validation-scope.ts';
