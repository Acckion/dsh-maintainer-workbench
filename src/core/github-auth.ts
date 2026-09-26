import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export type GitHubAuth = { token: string; source: 'token' | 'gh' | 'anonymous' };
export async function resolveGitHubAuth(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  cli: () => Promise<string> = async () => (await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 5000, maxBuffer: 16384 })).stdout,
): Promise<GitHubAuth> {
  // An explicitly supplied credential never falls back to another identity.
  const token = explicit ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (token !== undefined) return { token: token.trim(), source: token.trim() ? 'token' : 'anonymous' };
  try { const value = (await cli()).trim(); return { token: value, source: value ? 'gh' : 'anonymous' }; }
  catch { return { token: '', source: 'anonymous' }; }
}
