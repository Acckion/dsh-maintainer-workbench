import type { Artifact } from './artifacts.ts';

/** Report completion and validation success are distinct product states. */
export function validationState(artifact?: Artifact): { state: 'passed' | 'failed' | 'incomplete'; reason: string } | undefined {
  if (artifact?.stage !== 'validate') return;
  const failed = artifact.tests.filter(test => test.status === 'failed').length;
  if (failed) return { state: 'failed', reason: `${failed} 项验证失败，需要修订实施后重新验证` };
  if (artifact.blockers.length) return { state: 'incomplete', reason: `验证有阻塞：${artifact.blockers[0]}` };
  if (!artifact.tests.length || artifact.tests.some(test => test.status === 'not_run')) return { state: 'incomplete', reason: '验证尚未执行完整，请先补齐验证条件' };
  return { state: 'passed', reason: '验证报告通过，可继续独立审查；仍需核对工具证据' };
}
