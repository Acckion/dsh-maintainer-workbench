import type {Job} from './types.ts';
/** Reply belongs to the current accepted artifact, not an earlier review of the item. */
export function reportReply(job:Job):string {
 if(job.result?.responseDraft?.trim())return job.result.responseDraft;
 const summary=job.artifact?.summary??job.result?.summary;
 if(!summary?.trim())return '';
 const coverage=job.artifact?.coverage;
 return [summary,coverage?`${['fix','docs'].includes(job.kind)?'修复':'审查'}范围与限制：${coverage}`:'','以上为 AI 辅助分析，经维护者本地确认。'].filter(Boolean).join('\n\n');
}
