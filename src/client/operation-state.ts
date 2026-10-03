export type OperationError = { id: string; error: string };
export type OperationRecord = { ids: string[]; reused: string[]; errors: OperationError[]; at: string };
export type DispatchResponse = Partial<Pick<OperationRecord, 'ids' | 'reused' | 'errors'>> & { created?: string[] };
export type InboxReturnContext = { repoId: string; scrollTop: number; focused?: string };

export function pageSearchKey(repoId: string, page: string) { return `${repoId}:${page}`; }
export function operationRecordFromResponse(response: DispatchResponse, at = new Date().toISOString()): OperationRecord {
  return { ids: response.created ?? response.ids ?? [], reused: response.reused ?? [], errors: response.errors ?? [], at };
}
/** A transport error is deliberately not treated as proof that no job was created. */
export function operationFailureRecord(ids: string[], error: unknown, at = new Date().toISOString()): OperationRecord {
  const detail = error instanceof Error ? error.message : '请求未确认';
  return { ids: [], reused: [], errors: ids.map(id => ({ id, error: `请求未完成或被拒绝：${detail}；未确认是否已创建任务，请刷新后核对。` })), at };
}
export function restoreInboxContext(context: InboxReturnContext | undefined, repoId: string) { return context?.repoId === repoId ? context : undefined; }
/** Changing the selected task must not retain a review note for the previous task. */
export function reviewNoteForTask(currentTaskId: string | undefined, nextTaskId: string, note: string) { return currentTaskId === nextTaskId ? note : ''; }
