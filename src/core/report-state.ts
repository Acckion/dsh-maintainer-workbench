import type { Job } from "./types.ts";

/** A failed report is recoverable only after the host verified execution integrity. */
export function reportNeedsRecovery(job: Job): boolean {
  return job.status === "failed" && !!job.formatRecovery && !!job.rawOutput && !job.result;
}

/** Existing jobs may contain a legacy Zod dump; retain it in storage, shorten only display. */
export function reportFailureMessage(job: Job): string | undefined {
  if (!reportNeedsRecovery(job) || !job.error) return job.error;
  const start = job.error.indexOf('[');
  if (start < 0 || job.error.length > 200000) return job.error;
  try {
    const issues: unknown = JSON.parse(job.error.slice(start));
    if (!Array.isArray(issues) || !issues.length || !issues.every(issue => issue && typeof issue === 'object' &&
      Array.isArray(issue.path) && issue.path.every((part: unknown) => typeof part === 'string' || typeof part === 'number'))) return job.error;
    if (issues.some(issue => issue.code === 'too_small' && issue.path.join('.') === 'inputRequest.fields'))
      return '报告包含空的补充信息请求，请重新整理报告。';
    return `报告字段不符合要求：${issues.slice(0, 5).map(issue => issue.path.join('.') || '报告').join('、')}`;
  } catch { return job.error; }
}
