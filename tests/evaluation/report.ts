import { z } from 'zod';
import { corpus, corpusVersion, type CaseId } from './corpus.ts';
const ids = corpus.map(c => c.id) as [CaseId, ...CaseId[]];
const caseSchema = z.object({
  id: z.enum(ids), title: z.string(), category: z.string(), oracle: z.string(),
  expectationSatisfied: z.boolean(), error: z.string().optional(), durationMs: z.number().finite().nonnegative(),
  runnerInvocations: z.number().int().nonnegative(),
  testCommands: z.array(z.object({ command: z.string(), exitCode: z.number().int(), output: z.string(), durationMs: z.number().finite().nonnegative() })),
  observations: z.record(z.unknown()), jobs: z.array(z.unknown()),
});
export const evaluationReportSchema = z.object({
  schemaVersion: z.literal(1), corpusVersion: z.literal(corpusVersion), generatedAt: z.string().datetime(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), mode: z.literal('deterministic-workflow-contracts'), corpusDescription: z.string(),
  metrics: z.object({ cases: z.literal(corpus.length), passed: z.number().int().min(0).max(corpus.length), paidApiRequests: z.literal(0), realModelTokens: z.null(), realApiCostUsd: z.null(), humanAcceptanceRate: z.null(), realModelFalsePositiveRate: z.null() }),
  cases: z.array(caseSchema).length(corpus.length), limitations: z.array(z.string()).min(1),
}).superRefine((report, ctx) => {
  if (new Set(report.cases.map(c => c.id)).size !== corpus.length) ctx.addIssue({ code: 'custom', path: ['cases'], message: 'Every corpus case must appear exactly once' });
  if (report.metrics.passed !== report.cases.filter(c => c.expectationSatisfied).length) ctx.addIssue({ code: 'custom', path: ['metrics', 'passed'], message: 'Summary does not match case outcomes' });
  for (const [i, row] of report.cases.entries()) if (!row.expectationSatisfied && !row.error) ctx.addIssue({ code: 'custom', path: ['cases', i, 'error'], message: 'Failed expectations must retain the observed error' });
});
export function validateReport(value: unknown) { return evaluationReportSchema.parse(value); }
