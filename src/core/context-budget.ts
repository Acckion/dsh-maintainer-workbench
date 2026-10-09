import type { StreamChunk } from '@deepseek-ai/dsh-llm';
/** Approximation only: provider tokenization can differ. Never logs message text. */
export function requestBudget(messages: readonly { role: string; content?: unknown; toolCallId?: unknown; isError?: boolean }[], tools: readonly unknown[], system?: string) {
  const size = (value: unknown) => JSON.stringify(value)?.length ?? 0;
  // Source attribution, event IDs and cached replay bookkeeping are not prompt text.
  // Keep model-visible content/tool pairing fields; do not mutate messages.
  const wireSize = (message: typeof messages[number]) => size({ role: message.role, content: message.content, toolCallId: message.toolCallId, isError: message.isError });
  const messageChars = messages.reduce((sum, message) => sum + wireSize(message), 0);
  const toolChars = size(tools), systemChars = system?.length ?? 0;
  // Deliberately conservative for mixed Chinese, code, JSON and ordinary prose.
  const estimatedInputTokens = Math.ceil((messageChars + toolChars + systemChars) / 2);
  return { messageChars, toolChars, systemChars, estimatedInputTokens,
    roles: messages.map(message => ({ role: message.role, chars: wireSize(message) })) };
}
export const documentTools = ['read', 'glob', 'grep', 'edit', 'write', 'bash', 'job_output', 'job_list', 'job_kill'];

/** Reject unbounded document reads before execution; do not truncate host results. */
export function documentReadBlocker(name: string, args: unknown): string | undefined {
  if (name !== 'read') return;
  const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const limit = input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20)
    return '文档上下文限制：read 必须提供 1–20 行的 limit，使用 offset 分段读取。先定位相关章节，避免同时读取多个完整文件；完整适用规则仍须遵守，不得声称已读未读部分。';
}

/** A normal stream failure reaches the host request-error recovery waterfall. */
export async function* budgetBlockedStream(message: string, code = 'WORKBENCH_CONTEXT_BUDGET'): AsyncIterable<StreamChunk> {
  yield { type: 'finish', reason: { kind: 'error', failure: { code, message } } };
}
