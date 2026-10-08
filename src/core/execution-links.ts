import type { ExecutionRecord, Job } from './types.ts';
import type { Artifact } from './artifacts.ts';
// Host-owned absolute cwd values; normalize the standard macOS temporary-directory alias.
const canonical = (path: string) => path.replace(/^\/private\/var\//, '/var/').replace(/\/+$/, '');
export function linkedExecution(job: Job, test: { command: string; executionId?: string }): ExecutionRecord | undefined {
  const strict = job.kind === 'validate' && !!job.worktree && !!(job.sessionId || job.toolDiagnostics);
  const sessionId = job.sessionId ?? job.toolDiagnostics?.sessionId;
  const matches = (job.executionRecords ?? []).filter(record => record.command?.trim() === test.command.trim() && record.checkoutSha === job.baseSha && (!record.patchHash || record.patchHash === job.patchSha256) && (!test.executionId || record.id === test.executionId || record.callId === test.executionId)
    && (!strict || record.sessionId === sessionId && !!record.patchHash && record.patchHash === job.patchSha256 && !!record.cwd && canonical(record.cwd) === canonical(job.worktree!)));
  return matches.length === 1 ? matches[0] : undefined;
}
export function reconcileTestExecutions(artifact: Artifact, job: Job): Artifact {
  if (!('tests' in artifact)) return artifact;
  const strict = artifact.stage === 'validate' && !!job.worktree && !!(job.sessionId || job.toolDiagnostics);
  const missing: string[] = [];
  const tests = artifact.tests.map(test => {
    if (test.status === 'not_run') return test;
    const record = linkedExecution(job, test);
    if (strict && (!record || record.exitCode === null && !record.isError)) {
      const reason = `${test.command}：缺少本 Session、同版本及补丁的可判定测试进程记录`;
      missing.push(reason); return { ...test, status: 'not_run' as const, executionId: undefined, output: `${test.output}\n${reason}` };
    }
    if (!record) return test;
    const contradicted = test.status === 'passed' && (record.isError || record.exitCode !== null && record.exitCode !== 0);
    return { ...test, executionId: record.id, status: contradicted ? 'failed' as const : test.status, output: contradicted ? `${test.output}\n宿主工具记录显示执行失败（退出码 ${record.exitCode ?? '未知'}），不能接受报告中的 passed。` : test.output };
  });
  if (strict && artifact.stage === 'validate' && !(job.executionRecords ?? []).some(record => record.command && (record.exitCode !== null || record.isError) && linkedExecution(job, { command: record.command, executionId: record.id }) === record)) {
    const reason = '本次未记录可判定验证进程，模型的环境阻塞判断尚未获工具证实';
    return { ...artifact, summary: '本次验证未执行，无法确认补丁通过或失败。', coverage: reason,
      environment: `宿主权限：${job.toolDiagnostics?.permission ?? '未记录'}；验证环境未由工具检查`,
      evidence: [{ source: 'Harness execution records', detail: reason }],
      responseDraft: '本次没有实际验证进程记录，不能确认修复通过或认定权限故障。需在现有权限下补齐检查。',
      nextSteps: ['补齐当前补丁的实际检查记录，不根据未经证实的权限判断更改权限'],
      tests, blockers: [...new Set([reason, ...artifact.blockers.map(blocker => `模型未证实：${blocker}`), ...missing])].slice(0, 30) };
  }
  return artifact.stage === 'validate' ? { ...artifact, tests, blockers: [...new Set([...artifact.blockers, ...missing])].slice(0, 30) } : { ...artifact, tests };
}
