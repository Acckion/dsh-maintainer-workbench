import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../../src/core/store.ts';
import type { Analysis, Issue, JobKind, Runner } from '../../src/core/types.ts';
/** Unit-test inputs only. Never imported by application code or shipped in the plugin. */
export function seedFixture(store: Store): void {
  const repoId = 'fixture/queue';
  store.put('repos', { id: repoId, fullName: repoId, description: 'Queue test fixture', defaultBranch: 'main', headSha: 'a'.repeat(40), localPath: '', mode: 'github', syncedAt: null, syncWarning: null, profile: { revision: 'a'.repeat(40), scannedAt: '2026-09-25', languages: [], roots: [], testPaths: [], workflows: [], manifests: [], commands: [], sources: [{ path: 'README.md', content: 'Test-only input' }], warnings: [] } });
  for (const number of [128, 131, 132, 135]) store.put('issues', { id: `${repoId}#${number}`, repoId, number, type: 'issue', title: `Test issue ${number}`, body: number === 131 ? 'Concurrent refresh token failure' : 'Test task input', author: 'fixture', labels: [], state: 'open', comments: 0, updatedAt: '2026-09-25T00:00:00Z', url: '' });
}
export function fixtureAnalysis(issue: Issue, _kind: JobKind): Analysis {
  return { summary: `Test result for ${issue.number}`, category: 'bug', priority: 'P2', confidence: 0, labels: ['bug'], missingInfo: [], duplicateOf: null, duplicateReason: '', evidence: [], nextSteps: [], responseDraft: 'Test-only draft', tests: [{ command: 'test-only', status: 'not_run', output: 'No real model used in this unit test' }] };
}
export const fixtureRunner: Runner = async ({ issue, job, signal }) => {
  await delay(30, undefined, { signal });
  return { result: fixtureAnalysis(issue, job.kind), engine: 'unit-test fixture' };
};
