import { createHash } from 'node:crypto';

function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(stable));
  if (value && typeof value === 'object') return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return JSON.stringify(value) ?? '';
}
function fingerprint(name: string, argumentsValue: unknown): string {
  let args = argumentsValue;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* Preserve opaque arguments. */ } }
  const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  // Presentation labels and timeouts do not change the shell command being run.
  const effective = name === 'bash' ? { command: input.command ?? input.cmd ?? args, cwd: input.cwd ?? input.workdir } : args;
  return createHash('sha256').update(name + ':' + stable(effective)).digest('hex');
}

/** Session-local guard. Never caches a tool result or treats a warning as evidence. */
export function toolLoopPolicy(documentTask = false) {
  const seen = new Map<string, number>();
  let inspections = 0;
  let reason: string | undefined;
  return {
    get reason() { return reason; },
    guard(name: string, args: unknown): string | undefined {
      if (reason) return reason;
      if (!['read', 'grep', 'glob', 'bash', 'job_output', 'job_list'].includes(name)) return;
      const key = fingerprint(name, args);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      inspections++;
      if (count >= 4) {
        reason = '重复工具调用阻塞：同一调用已请求4次，且期间没有成功的文件编辑。已停止继续请求模型；请检查已有证据和工作区后重试，原始记录保留。';
        return reason;
      }
      if (documentTask && inspections > 60) {
        reason = '文档调查预算阻塞：已请求60次查阅或命令，期间没有成功的文件编辑。请缩小调查范围或核对已有结果后重试；不沿用未完成验证。';
        return reason;
      }
      if (count === 3) return '重复调用提醒：相同参数已请求两次，本次不再执行。请使用已有结果推进当前任务；需要重查时明确改变范围或先完成修改。继续重复将停止任务。';
    },
    edited(name: string, failed: boolean) {
      // Only successful native edits establish a new inspection generation.
      // A shell command can be opaque; never assume it changed files.
      if (!failed && ['edit', 'write'].includes(name)) { seen.clear(); inspections = 0; }
    },
  };
}
