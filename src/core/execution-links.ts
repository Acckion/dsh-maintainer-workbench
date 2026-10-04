import type { ExecutionRecord, Job } from './types.ts';
import type { Artifact } from './artifacts.ts';
export function linkedExecution(job: Job, test: { command: string; executionId?: string }): ExecutionRecord | undefined {
  const matches = (job.executionRecords ?? []).filter(record => record.command?.trim() === test.command.trim() && record.checkoutSha === job.baseSha && (!record.patchHash || record.patchHash === job.patchSha256) && (!test.executionId || record.id === test.executionId));
  return matches.length === 1 ? matches[0] : undefined;
}
export function reconcileTestExecutions(artifact: Artifact, job: Job): Artifact {
  if (!('tests' in artifact)) return artifact;
  return { ...artifact, tests: artifact.tests.map(test => {
    if (test.status === 'not_run') return test;
    const record = linkedExecution(job, test); if (!record) return test;
    const contradicted = test.status === 'passed' && (record.isError || record.exitCode !== null && record.exitCode !== 0);
    return { ...test, executionId: record.id, status: contradicted ? 'failed' as const : test.status, output: contradicted ? `${test.output}\n宿主工具记录显示执行失败（退出码 ${record.exitCode ?? '未知'}），不能接受报告中的 passed。` : test.output };
  }) };
}
