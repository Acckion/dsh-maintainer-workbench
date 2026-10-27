import { z } from 'zod';
import { resolve } from 'node:path';
import { artifactSchemas, findingSchema, parseArtifact, emptyInputRequest, type Artifact } from './artifacts.ts';
import { ReportParseError } from './execution-errors.ts';
import type { ExecutionRecord, Job, JobKind } from './types.ts';
import { executionOutcome } from './execution-outcome.ts';
import { executionWithinWorktree } from './execution-cwd-native.ts';

export type ReportContext = Pick<Job, 'sessionId' | 'baseSha' | 'worktree' | 'patchSha256' | 'executionRecords'>;
const sourceRef = z.object({ executionId: z.string().min(1).max(200), path: z.string().min(1).max(6000), line: z.number().int().positive(), quote: z.string().min(1).max(6000).optional() });
const testRef = z.object({ executionId: z.string().min(1).max(200).optional(), command: z.string().max(6000).optional(), status: z.enum(['passed', 'failed', 'not_run']).optional(), output: z.string().max(6000).optional() });
const compactFinding = findingSchema.extend({ sourceEvidence: sourceRef.optional() });

export function compactReportSchema(kind: JobKind) {
  const { schemaVersion, stage, evidence, nextSteps, responseDraft, ...shape } = artifactSchemas[kind].shape;
  const fields: z.ZodRawShape = { ...shape, reportFormat: z.literal('compact-v1'),
    inputRequest: artifactSchemas[kind].shape.inputRequest.nullable(),
    evidenceRefs: z.array(z.string().min(1).max(200)).max(30).optional(),
    nextSteps: nextSteps.optional(), responseDraft: responseDraft.optional() };
  if (['triage', 'preflight'].includes(kind)) fields.evidence = z.array(z.object({ source: z.string().min(1).max(400), detail: z.string().min(1).max(2000) })).max(20).optional();
  if (['fix', 'docs', 'validate'].includes(kind)) fields.tests = z.array(testRef).max(20);
  if (kind === 'review') {
    fields.inspectedSources = z.array(sourceRef).max(80).optional();
    fields.findings = z.array(compactFinding).max(40);
  }
  return z.object(fields).strict();
}

/** Select only host records from the same session, checkout and (for read-only stages) patch. */
function optionalRecordFor(kind: JobKind, id: string, context?: ReportContext, implementationCheck = false): ExecutionRecord | undefined {
  const matches = context?.executionRecords?.filter(record => record.id === id || record.callId === id) ?? [];
  const record = matches[0];
  if (matches.length !== 1 || !context?.sessionId || !record || record.sessionId !== context.sessionId ||
    record.checkoutSha !== context.baseSha || (context.worktree && !executionWithinWorktree(context.worktree, record.cwd)) ||
    ((['validate', 'review', 'ci'].includes(kind) || implementationCheck) && context.worktree && (!context.patchSha256 || record.patchHash !== context.patchSha256)))
    return undefined;
  return record;
}

export function assembleReport(kind: JobKind, value: unknown, context?: ReportContext): Artifact {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'reportFormat'))
    return parseArtifact(kind, value);
  const candidate = value as Record<string, unknown>;
  const report = compactReportSchema(kind).parse(emptyInputRequest(candidate.inputRequest) ? { ...candidate, inputRequest: undefined } : candidate);
  const droppedRefs: string[] = [];
  const evidence = [...(report.evidence as { source: string; detail: string }[] | undefined ?? []), ...(report.evidenceRefs as string[] | undefined ?? []).map(id => {
    const record = optionalRecordFor(kind, id, context);
    if (!record) { droppedRefs.push(id); return undefined; }
    return { source: `Harness execution ${record.id}`, detail: `${record.command ?? record.sourcePath ?? record.tool}\n${record.output.slice(-1200)}` };
  }).filter((entry): entry is { source: string; detail: string } => entry !== undefined)];
  if (droppedRefs.length) evidence.push({ source: 'Host report validation warning', detail: `已剔除无法匹配本会话工具记录的证据引用：${droppedRefs.join('、')}。这些引用的事实未被宿主证实。` });
  const body: Record<string, unknown> = { ...report, schemaVersion: 1, stage: kind, evidence, nextSteps: report.nextSteps ?? [], responseDraft: report.responseDraft ?? '' };
  delete body.reportFormat; delete body.evidenceRefs;
  if (['fix', 'docs', 'validate'].includes(kind)) body.tests = (report.tests as z.infer<typeof testRef>[]).map(test => {
    if (!test.executionId) {
      if (!test.command?.trim() || test.status !== 'not_run') throw new ReportParseError('没有执行引用的检查必须提供命令并标记 not_run', 'schema');
      return { command: test.command, status: 'not_run', output: test.output ?? '' };
    }
    const record = optionalRecordFor(kind, test.executionId, context, ['fix', 'docs'].includes(kind));
    if (!record) return {
      command: test.command?.trim() || `未能匹配执行记录的检查 ${test.executionId}`,
      status: 'not_run' as const,
      output: `${test.output ?? ''}\n宿主无法为引用 ${test.executionId} 找到同会话、同版本的工具记录，已降级为 not_run。`,
    };
    if (!record.command || test.command !== undefined && test.command.trim() !== record.command.trim()) throw new ReportParseError('检查引用与实际执行命令不符', 'schema');
    const outcome = executionOutcome(record);
    const status = test.status === 'not_run' || outcome === 'not_run'
      ? 'not_run' : test.status === 'failed' || outcome === 'failed' ? 'failed' : 'passed';
    return { command: record.command, status, output: record.output, executionId: record.id };
  });
  if (kind === 'review') {
    const source = (ref: z.infer<typeof sourceRef>) => {
      const record = optionalRecordFor(kind, ref.executionId, context);
      if (!record) return undefined; // Keep unverified references out of the evidence gate.
      const readPath = record.sourcePath && context?.worktree && resolve(context.worktree, record.sourcePath) === resolve(context.worktree, ref.path) && /read|file|open/i.test(record.tool);
      const readCommand = record.command && /\b(cat|nl|sed|rg|head|tail|awk)\b/.test(record.command) && record.command.includes(ref.path);
      const line = record.output.split('\n').map(text => text.match(/^\s*(\d+)(?:\s*[|:] ?|[ \t]+)(.*)$/)).find(match => match && Number(match[1]) === ref.line);
      if ((readPath || readCommand) && line?.[2].trim()) {
        if (ref.quote !== undefined && (!ref.quote.trim() || !line[2].trim().includes(ref.quote.trim())))
          throw new ReportParseError(`源码引用与工具记录 ${record.id} 的 ${ref.path}:${ref.line} 不匹配；请使用完整原文或省略 quote 由主机提取：${line[2].trim()}`, 'schema');
        // The host supplies the full numbered line, including Markdown/list punctuation.
        // Legacy quote fragments must match it; unrelated text is never rewritten into evidence.
        return { ...ref, quote: line[2] };
      }
      if (ref.quote !== undefined) return ref; // The final evidence gate verifies unnumbered reads against disk.
      throw new ReportParseError('工具输出没有可提取的编号源码行，请提供简短原文引用', 'schema');
    };
    body.inspectedSources = (report.inspectedSources as z.infer<typeof sourceRef>[] | undefined)
      ?.map(source).filter((ref): ref is z.infer<typeof sourceRef> => ref !== undefined);
    body.findings = (report.findings as z.infer<typeof compactFinding>[]).map(finding => ({ ...finding, sourceEvidence: finding.sourceEvidence && source(finding.sourceEvidence) }));
  }
  return parseArtifact(kind, body);
}
