import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionRecord, Job } from './types.ts';

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
export function executionRecord(job: Job, sessionId: string, seq: number, call: { name: string; arguments: string } | undefined, data: unknown, patchHash?: string): ExecutionRecord {
  const event = object(data), message = object(event.message), meta = object(event.meta);
  let args: Record<string, unknown> = {};
  try { args = object(JSON.parse(call?.arguments ?? '{}')); } catch { /* Keep an unlinked event rather than inventing arguments. */ }
  const stdout = object(meta.stdout), stderr = object(meta.stderr);
  const content = Array.isArray(message.content) ? message.content.map(block => object(block).text).filter(v => typeof v === 'string').join('\n') : '';
  const output = typeof meta.output === 'string' ? meta.output : typeof stdout.text === 'string' ? `${stdout.text}${typeof stderr.text === 'string' ? '\n' + stderr.text : ''}` : content;
  // Only structured host metadata supplies an exit code. Text in stdout may be repository-controlled.
  const exitCode = Number.isInteger(meta.exitCode) ? meta.exitCode as number : null;
  const sourcePath = args.file_path ?? args.path ?? args.filePath;
  return { id: `${sessionId}:${seq}`, sessionId, callId: String(message.toolCallId ?? ''), tool: call?.name ?? 'unknown', sourcePath: typeof sourcePath === 'string' ? sourcePath : undefined, command: typeof args.command === 'string' ? args.command : undefined,
    cwd: typeof args.workdir === 'string' ? args.workdir : job.worktree, checkoutSha: job.baseSha, patchHash,
    exitCode, signal: typeof meta.signal === 'string' ? meta.signal : undefined, isError: message.isError === true,
    recordedAt: new Date().toISOString(), output: output.slice(0, 6000), truncated: output.length > 6000 || stdout.truncated === true || stderr.truncated === true };
}
function logPath(dataDir: string, jobId: string, recordId: string): string {
  return join(dataDir, 'execution-evidence', createHash('sha256').update(jobId).digest('hex'), `${createHash('sha256').update(recordId).digest('hex')}.json`);
}
export function saveExecutionLog(dataDir: string, jobId: string, recordId: string, raw: string): void {
  const path = logPath(dataDir, jobId, recordId); mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ raw: raw.slice(0, 1_000_000), truncated: raw.length > 1_000_000 }), { mode: 0o600 });
}
export function readExecutionLog(dataDir: string, job: Job, recordId: string): { raw: string; truncated: boolean } {
  if (!job.executionRecords?.some(record => record.id === recordId)) throw new Error('该任务没有此工具记录');
  return JSON.parse(readFileSync(logPath(dataDir, job.id, recordId), 'utf8'));
}
