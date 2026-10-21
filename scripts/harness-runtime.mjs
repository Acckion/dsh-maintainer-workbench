import { readFile, access } from 'node:fs/promises';
import { resolve, isAbsolute, delimiter } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Explicit local configuration survives npm/shell restarts without global installs. */
export async function harnessRuntime(data, inherited = process.env, executable = process.execPath) {
  const filename = resolve(data, 'runtime/config.json');
  let config;
  try { config = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { executable, env: { ...inherited } }; throw error; }
  if (!config || typeof config.binDirectory !== 'string' || !isAbsolute(config.binDirectory) ||
    config.nodeOptions !== undefined && (!Array.isArray(config.nodeOptions) || config.nodeOptions.some(option => typeof option !== 'string' || !/^--max-old-space-size=\d+$/.test(option))))
    throw new Error(`Invalid Harness runtime configuration: ${filename}`);
  const node = resolve(config.binDirectory, 'node');
  const pnpm = resolve(config.binDirectory, 'pnpm');
  await Promise.all([access(node), access(pnpm)]);
  const env = { ...inherited, PATH: [config.binDirectory, inherited.PATH].filter(Boolean).join(delimiter),
    NODE_OPTIONS: [inherited.NODE_OPTIONS, ...(config.nodeOptions ?? [])].filter(Boolean).join(' ') };
  // Fail closed when a configured runtime is unavailable, never silently use an old Node.
  await promisify(execFile)(node, ['--version'], { env, timeout: 5000 });
  await promisify(execFile)(pnpm, ['--version'], { env, timeout: 5000 });
  return { executable: node, env };
}
