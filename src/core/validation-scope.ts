import type { Gap } from '../domain/gaps.ts';
import type { Job } from './types.ts';
import type { Artifact } from './artifacts.ts';

/** Legacy prose may name a concrete command, but generic build/type labels are not commands. */
export function validationChecks(gap: Gap): string[] | undefined {
  const candidates = gap.checks?.length ? gap.checks : [...gap.resolution.matchAll(/`([^`\n]+)`/g)].map(m=>m[1].trim())
    .filter(command=>/^(?:pnpm|npm|yarn|bun|node|python3?|git)\s/.test(command));
  // Legacy environment reports sometimes put installation into checks. That
  // belongs to the backend preparation step, never a validation Agent command.
  const commands=gap.kind==='environment'?candidates.filter(command=>! /^(?:pnpm|npm|yarn|bun)\s+(?:install|ci|i|add)\b/.test(command)):candidates;
  return commands.length ? [...new Set(commands)] : undefined;
}

export function requiredValidationCommands(job: Pick<Job,'sourceJobId'|'handoff'>): string[] {
  return [...new Set(job.handoff?.filter(h=>h.id===job.sourceJobId).flatMap(h=>h.artifact?.gaps?.filter(g=>g.status!=='resolved'&&g.blocks.includes('validate')).flatMap(g=>validationChecks(g)??[])??[])??[])];
}

/** Keep the named project entry point intact; do not silently widen to other scripts. */
export function validationScopeBlocker(command: string, job: Pick<Job,'sourceJobId'|'handoff'|'instructions'>): string | undefined {
  const required=requiredValidationCommands(job);
  if (!required.length) return;
  const calls=command.matchAll(/(?:^|[;&|\n])\s*((?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|tsgo(?::[\w-]+)?)\b[^;&|\n]*|node\s+(?:--import\s+\S+\s+)?scripts\/[\w/.-]+\.(?:mjs|mts|js|ts)\b[^;&|\n]*)/g);
  for(const call of calls){
    const actual=call[1].replace(/\s+\d?>.*$/,'').trim();
    if(!required.includes(actual)&&!job.instructions?.includes(actual))
      return `当前验证已指定命令，请保持参数与入口不变，不扩大为整仓构建或替代脚本：${required.join('；')}。额外覆盖需求应说明来源，不能据此擅自新增验收门槛。`;
  }
}

/** A rejected, unexecuted expansion is a coverage limitation, not a required check. */
export function scopedValidationReport(artifact: Artifact, job: Pick<Job,'sourceJobId'|'handoff'|'instructions'>): Artifact {
  if(artifact.stage!=='validate') return artifact;
  const extra=artifact.tests.filter(t=>t.status==='not_run'&&!t.executionId&&validationScopeBlocker(t.command,job));
  if(!extra.length)return artifact;
  return {...artifact,tests:artifact.tests.filter(t=>!extra.includes(t)),
    coverage:artifact.coverage+'；未执行的范围外检查单独列为覆盖限制。',
    evidence:[...artifact.evidence,...extra.map(t=>({source:`范围外检查（不计入本次验收）：${t.command}`,detail:`not_run：${t.output}`}))].slice(0,30)};
}

export const documentValidationScope = '仅验证当前文档补丁，不修改文件。实际执行 git diff --check；从实际 diff 找出新增相对链接，核对目标文件存在及锚点对应标题，记录真实命令、退出码和本 Session executionId。核对新增说明是否重复已有内容。未做安装、启动或整仓库测试，不声明运行成功。缺少检查证据则报告 not_run 和阻塞，不提交或发布。';
export function validationInstructions(instructions: string | undefined, sourceKind?: string): string | undefined {
  return instructions?.trim() ? instructions : sourceKind === 'docs' ? documentValidationScope : instructions;
}
