/** Recovery uses host-owned durable history replacement, never edits request messages. */
export async function recoverContextBudget(failure: string, attempts: number, operations: {
  prune: () => number;
  compact: () => Promise<boolean>;
}): Promise<'pruned' | 'compacted' | undefined> {
  if (!failure.includes('上下文预算阻塞') || attempts >= 3) return;
  if (operations.prune() > 0) return 'pruned';
  return await operations.compact() ? 'compacted' : undefined;
}
