export const documentValidationScope = '仅验证当前文档补丁，不修改文件。实际执行 git diff --check；从实际 diff 找出新增相对链接，核对目标文件存在及锚点对应标题，记录真实命令、退出码和本 Session executionId。核对新增说明是否重复已有内容。未做安装、启动或整仓库测试，不声明运行成功。缺少检查证据则报告 not_run 和阻塞，不提交或发布。';
export function validationInstructions(instructions: string | undefined, sourceKind?: string): string | undefined {
  return instructions?.trim() ? instructions : sourceKind === 'docs' ? documentValidationScope : instructions;
}
