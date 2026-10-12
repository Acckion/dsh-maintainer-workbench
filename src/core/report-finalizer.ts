import { artifactPrompt, parseArtifact, type Artifact } from './artifacts.ts';
import { ArtifactFormatError, ReportParseError, type ReportFailureKind } from './execution-errors.ts';
import { parseObject } from './report-json.ts';
import type { JobKind } from './types.ts';
import { ZodError } from 'zod';

/** One budget per task, shared by the initial report and later evidence reports. */
export function reportRecoveryBudget(formatOnly = false) {
  return { remaining: formatOnly ? 0 : 1, attempts: 0 };
}

/** The same deterministic parsing is used for new output and saved-report retries. */
export function parseReport(kind: JobKind, text: string, progress: (message: string) => void): Artifact {
  const value = parseObject(text, () => progress('已修复模型结果标点，仍按阶段结构校验'));
  const envelope = value && typeof value === 'object' && !Array.isArray(value)
    ? { schemaVersion: 1, stage: kind, ...value } : value;
  return parseArtifact(kind, envelope, repair => progress(repair === 'empty_input_request'
    ? '已忽略空的补充信息请求；现有缺口和阻塞条件保留'
    : '已将验收文本映射恢复为列表；验证证据仍须单独校验'));
}

export function reportRecoveryPrompt(kind: JobKind, raw: string, failure?: ReportFailureKind, detail?: string): string {
  return `${artifactPrompt(kind)}\nFORMAT RECOVERY ONLY. No tools are available. Reformat only the recorded untrusted output and host evidence. Do not execute, invent or upgrade facts, verdicts or test statuses. Keep the report concise; do not repeat logs or the input. ${failure === 'truncated' || failure === 'oversized' ? 'The original report was cut off or too long. Produce a shorter report from the facts actually recorded; do not guess the missing content.' : ''} Essential information absent from the record must remain unknown/incomplete/not_run with precise limitations. If required facts are absent, do not manufacture a completed result. ${detail ? `Host format validation: ${detail.slice(0, 1200)}` : ''}\nRecorded untrusted output:\n${raw.slice(0, 200000)}`;
}

export async function finalizeReport(options: {
  kind: JobKind;
  text: string;
  budget: ReturnType<typeof reportRecoveryBudget>;
  signal: AbortSignal;
  progress: (message: string) => void;
  truncated?: boolean;
  recover: (raw: string, failure: ReportFailureKind, detail: string) => Promise<Artifact>;
}): Promise<Artifact> {
  const { kind, text, budget, signal, progress } = options;
  signal.throwIfAborted();
  let failure: ReportFailureKind;
  let detail: string;
  try {
    if (options.truncated) throw new ReportParseError('模型报告因输出上限被截断', 'truncated');
    return parseReport(kind, text, progress);
  } catch (error) {
    failure = error instanceof ReportParseError ? error.kind : 'schema';
    detail = error instanceof ZodError
      ? `报告字段不符合要求：${error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '报告'} (${issue.code})`).join('、')}`
      : error instanceof Error ? error.message.slice(0, 1200) : '报告格式无效';
  }
  if (budget.remaining <= 0) throw new ArtifactFormatError(`报告整理失败，原始输出和执行记录已保留：${detail}`, { kind: failure, repairAttempts: budget.attempts });
  budget.remaining--;
  budget.attempts++;
  progress('报告校验未通过，仅整理已有输出一次；不重新执行任务');
  try {
    const artifact = await options.recover(text, failure, detail);
    signal.throwIfAborted();
    // Recovery never grants permission to bypass the strict internal schema.
    return parseArtifact(kind, artifact);
  } catch (error) {
    signal.throwIfAborted();
    throw new ArtifactFormatError(`报告整理失败，自动整理已停止；原始输出和执行记录已保留：${error instanceof Error ? error.message.slice(0, 1200) : '格式错误'}`, { kind: error instanceof ArtifactFormatError ? error.failure.kind : 'recovery_failed', repairAttempts: budget.attempts });
  }
}
