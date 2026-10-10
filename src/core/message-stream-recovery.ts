import type { StreamChunk } from '@deepseek-ai/dsh-llm';

const preStartMessage = 'DeepSeek Messages stream: event precedes message_start';
function preStartFailure(error: unknown): error is {code:string;message:string} {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'MALFORMED_RESPONSE' && 'message' in error && error.message === preStartMessage;
}

/** Route a provider throw through the host recovery waterfall only before any chunks. */
export async function* recoverableMessageStream(next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  let emitted = false;
  try {
    for await (const chunk of next()) { emitted = true; yield chunk; }
  } catch (error) {
    if (emitted || !preStartFailure(error)) throw error;
    yield { type: 'finish', reason: { kind: 'error', failure: { code: error.code, message: error.message } } };
  }
}

/** Retry only a Messages stream that failed before its required start event. */
export function messageStreamRecovery() {
  const steps = new Map<string, number>();
  let attempts = 0;
  return {
    get attempts() { return attempts; },
    next(failure: {code?:string;message:string}, turn:number, step:number): 'retry' | 'exhausted' | undefined {
      if (!preStartFailure(failure)) return;
      const key = `${turn}:${step}`, count = steps.get(key) ?? 0;
      if (count >= 2 || attempts >= 4) return 'exhausted';
      steps.set(key, count + 1); attempts++;
      return 'retry';
    },
  };
}
