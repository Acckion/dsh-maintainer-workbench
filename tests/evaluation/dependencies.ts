import { createHash } from 'node:crypto';
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
/** Root package metadata is not an installed dependency; all resolved entries remain compared. */
export function dependencyFingerprints(text: string): { lockSha256: string; graphSha256: string } {
  const lock = JSON.parse(text) as { packages?: Record<string, unknown> };
  if (!lock.packages || !lock.packages['']) throw new Error('Expected a package lock with project and resolved dependency entries');
  const graph = Object.fromEntries(Object.entries(lock.packages).filter(([path]) => path !== ''));
  return { lockSha256: createHash('sha256').update(text).digest('hex'), graphSha256: createHash('sha256').update(JSON.stringify(stable(graph))).digest('hex') };
}
