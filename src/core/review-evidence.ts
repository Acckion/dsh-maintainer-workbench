import { reviewRequiredSources } from './review-context.ts';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Artifact } from './artifacts.ts';
import type { Job, ExecutionRecord, ToolDiagnostics } from './types.ts';
import { collectPatch, git } from './git.ts';

export function toolDiagnosticReasons(d?: ToolDiagnostics): string[] {
  if (!d) return ['未采集工具诊断，请重新派发审查'];
  if (!d.mountedTools.length) return ['工具未挂载'];
  const requests = d.requests.filter(r => !r.purpose);
  if (!requests.length) return ['未观察到该 Session 的模型请求'];
  if (!requests.some(r => r.tools.length)) return ['模型请求未携带工具'];
  if (!d.calls && !d.canonicalResults && !d.results) return ['模型请求携带工具，但未观察到调用'];
  if ((d.calls || d.canonicalResults) && !d.results) return ['观察到工具调用，但未收到 Session 结果记录'];
  if (d.results && !d.canonicalResults) return ['收到 Session 结果，但未观察到宿主执行结果；需核对采集链路'];
  return [];
}

const nativeReview = (job: Job) => job.kind === 'review' && !!job.worktree && !!(job.sessionId || job.toolDiagnostics);
function matchingRecord(job: Job, id: string, processResult = false): ExecutionRecord | undefined {
  const matches = (job.executionRecords ?? []).filter(r => r.id === id || r.callId === id);
  if (matches.length !== 1) return undefined;
  const r = matches[0];
  return r.sessionId === job.sessionId && r.checkoutSha === job.baseSha && r.patchHash === job.patchSha256
    && r.cwd === job.worktree && (processResult ? r.exitCode !== null && !r.signal : !r.isError && (r.exitCode === null || r.exitCode === 0)) ? r : undefined;
}

/** Verify source citations against the current pinned checkout, never execute repository code. */
export async function reviewEvidenceGate(job: Job, artifact: Artifact | undefined = job.artifact): Promise<{ allowed: boolean; reasons: string[] }> {
  if (!nativeReview(job)) return { allowed: true, reasons: [] };
  const reasons = toolDiagnosticReasons(job.toolDiagnostics);
  if (job.toolDiagnostics && (job.toolDiagnostics.sessionId !== job.sessionId || !job.toolDiagnostics.finished)) reasons.push('工具诊断 Session 不匹配或尚未结束');
  if (artifact?.stage !== 'review') return { allowed: false, reasons: [...reasons, '缺少审查产物'] };
  if (artifact.verdict === 'incomplete' || artifact.blockers.length) reasons.push('审查报告仍有未完成项或阻塞');
  try {
    if (await git(job.worktree!, ['rev-parse', 'HEAD']) !== job.baseSha
      || createHash('sha256').update(await collectPatch(job.worktree!, job.baseSha)).digest('hex') !== job.patchSha256) reasons.push('审查工作区版本或补丁已变化');
  } catch { reasons.push('无法核验审查工作区版本'); }
  const root = await realpath(job.worktree!).catch(() => '');
  const sourceLocation = (path: string) => path.startsWith(root + '/') ? resolve(path) : resolve(root, relative(job.worktree!, resolve(job.worktree!, path)));
  const verifySource = async (ref: { executionId: string; path: string; line: number; quote: string }, label: string) => {
    const record = matchingRecord(job, ref.executionId);
    if (!record) { reasons.push(`${label}：未关联同 Session、同版本的成功工具记录`); return; }
    if (!root || ref.path.split(/[\\/]/).includes('..')) { reasons.push(`${label}：源码路径无效`); return; }
    try {
      const candidate = sourceLocation(ref.path);
      const path = await realpath(candidate);
      const rel = relative(root, path);
      if (rel.startsWith('..') || isAbsolute(rel) || path !== candidate || (await stat(path)).size > 2_000_000) throw new Error('unsafe path');
      const line = (await readFile(path, 'utf8')).split('\n')[ref.line - 1]?.trim();
      const quote = ref.quote.trim();
      if (!quote || line !== quote) { reasons.push(`${label}：源码行号或原文不匹配`); return; }
      // Bind the output to a file read, rather than accepting an unrelated test or an echo.
      const readPath = record.sourcePath && sourceLocation(record.sourcePath) === path && /read|file|open/i.test(record.tool);
      const readCommand = record.command && /\b(cat|nl|sed|rg|head|tail|awk)\b/.test(record.command) && record.command.includes(ref.path);
      if ((!readPath && !readCommand) || !record.output.includes(quote)) reasons.push(`${label}：工具记录没有该文件的源码原文；截断日志需重新读取目标行`);
    } catch { reasons.push(`${label}：无法安全读取引用的源码`); }
  };
  if (!artifact.inspectedSources?.length) reasons.push('未提供已读取源码的工具引用');
  for (const ref of artifact.inspectedSources ?? []) await verifySource(ref, '覆盖范围');
  try {
    const required = await reviewRequiredSources(job);
    for (const path of required) if (!artifact.inspectedSources?.some(ref => sourceLocation(ref.path) === sourceLocation(path))) reasons.push(`缺少必读文件的源码引用：${path}`);
  } catch { reasons.push('无法核验必读源码和相关测试范围'); }
  for (const finding of artifact.findings) {
    if (!finding.sourceEvidence) reasons.push(`${finding.id}：缺少源码工具引用`);
    else {
      if (sourceLocation(finding.path) !== sourceLocation(finding.sourceEvidence.path) || finding.line !== finding.sourceEvidence.line) reasons.push(`${finding.id}：发现位置与引用不一致`);
      await verifySource(finding.sourceEvidence, finding.id);
    }
    const repro = finding.reproduction;
    if (!repro) reasons.push(`${finding.id}：缺少具体输入、预期和实际行为`);
    else if (repro.basis === 'executed') {
      const record = repro.executionId ? matchingRecord(job, repro.executionId, true) : undefined;
      if (!record?.command || record.exitCode === null || !repro.command || repro.command.trim() !== record.command.trim() || !repro.outputQuote?.trim() || !record.output.includes(repro.outputQuote.trim())) reasons.push(`${finding.id}：执行复现缺少可核验的进程记录`);
    }
  }
  return { allowed: !reasons.length, reasons: [...new Set(reasons)] };
}

export async function assertReviewEvidence(job: Job): Promise<void> {
  const gate = await reviewEvidenceGate(job);
  if (!gate.allowed) throw new Error(`审查证据未达验收门槛：${gate.reasons.join('；')}`);
}

/** Report only machine-verified source coverage; preserve model prose in rawOutput. */
export function verifiedReviewCoverage(job: Job, artifact: Artifact, allowed: boolean): Artifact {
  if (!nativeReview(job) || artifact.stage !== 'review') return artifact;
  const paths = [...new Set((artifact.inspectedSources ?? []).map(ref => relative(job.worktree!, resolve(job.worktree!, ref.path))))];
  return { ...artifact, coverage: allowed ? `已核验源码读取：${paths.join('、')}。复现方式：${artifact.findings.some(f => f.reproduction?.basis === 'executed') ? '包含关联执行记录' : '静态推演；未记录执行复现'}。` : '源码覆盖范围尚未通过证据验收，见阻塞项。' };
}
