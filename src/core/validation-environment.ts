import type { Job } from './types.ts';
import type { Artifact } from './artifacts.ts';

/** Only a current checkout's actual missing-dependency error can override model classification. */
export function validationEnvironment(artifact: Artifact | undefined, job: Job): Artifact | undefined {
  if (artifact?.stage !== 'validate' || !job.worktree || !job.sessionId || !job.baseSha || !job.patchSha256) return artifact;
  if (artifact.gaps?.some(g => g.kind === 'environment' && g.status !== 'resolved' && g.blocks.includes('validate'))) return artifact;
  const records = (job.executionRecords ?? []).filter(r =>
    r.sessionId === job.sessionId && r.cwd === job.worktree &&
    r.checkoutSha === job.baseSha && r.patchHash === job.patchSha256 &&
    artifact.tests.some(t => t.status === 'not_run' && (t.executionId === r.id || (t.command.length > 0 && r.command?.startsWith(t.command)))) &&
    r.output.includes(`Repository dependencies are missing from ${job.worktree}/node_modules.`));
  if (!records.length) return artifact;
  let id = 'env-missing-dependencies';
  while (artifact.gaps?.some(g => g.id === id)) id += '-x';
  return { ...artifact, gaps: [...(artifact.gaps ?? []), {
    id, kind: 'environment', status: 'failed', blocks: ['validate'],
    summary: '实际验证命令未能启动：当前验证工作区缺少仓库依赖。',
    resolution: '按目标仓库声明的 Node 和包管理器版本准备此验证工作区的依赖，再重新执行未运行的检查；现有输出不代表验证通过。',
    sources: records.map(r => r.id),
  }] };
}
