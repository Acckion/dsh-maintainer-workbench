import {z} from 'zod';

export const gapKinds=['reporter_information','system_check','environment','external_wait','maintainer_decision','unclassified'] as const;
export const gapStages=['triage','preflight','investigate','fix','docs','validate','review','delivery'] as const;
export const gapSchema=z.object({
 id:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
 kind:z.enum(gapKinds),
 summary:z.string().trim().min(1).max(2000),
 waitFor:z.enum(['ci_completion','author_revision']).optional(),
 status:z.enum(['unknown','not_checked','pending','resolved','failed']),
 blocks:z.array(z.enum(gapStages)).max(8),
 resolution:z.string().trim().max(2000),
 sources:z.array(z.string().min(1).max(1000)).max(20),
}).superRefine((gap,ctx)=>{
 if(gap.kind==='external_wait' && !gap.waitFor) ctx.addIssue({code:'custom',message:'外部等待需明确 CI 或作者修订'});
 if(gap.status==='resolved' && !gap.sources.length) ctx.addIssue({code:'custom',message:'已解决缺口必须有来源'});
 if(gap.status==='resolved' && !gap.resolution) ctx.addIssue({code:'custom',message:'已解决缺口必须有明确解除条件'});
 if(gap.kind==='system_check' && gap.status==='unknown') ctx.addIssue({code:'custom',message:'系统检查需明确为未检查、等待、失败或已解决'});
});
export const gapsSchema=z.array(gapSchema).max(30).superRefine((gaps,ctx)=>{
 if(new Set(gaps.map(g=>g.id)).size!==gaps.length)ctx.addIssue({code:'custom',message:'缺口标识必须唯一'});
});
export type Gap=z.infer<typeof gapSchema>;
export const gapLabels:Record<Gap['kind'],string>={reporter_information:'等待报告者资料',system_check:'系统待检查',environment:'环境准备',external_wait:'等待外部结果',maintainer_decision:'需要维护者决定',unclassified:'待系统归类'};
export const gapStatusLabels:Record<Gap['status'],string>={unknown:'尚未知',not_checked:'尚未检查',pending:'等待中',resolved:'已有来源',failed:'检查失败'};
export const gapStageLabels:Record<typeof gapStages[number],string>={triage:'分诊',preflight:'预检',investigate:'调查',fix:'修复',docs:'文档修改',validate:'验证',review:'审查',delivery:'交付'};
/** Legacy text conveys no reliable responsibility or stage gate. Do not infer authorization from it. */
export function planGaps(plan:{gaps?:Gap[];missingInfo?:string[]}):Gap[]{
 return plan.gaps?.length?plan.gaps:(plan.missingInfo??[]).map((summary,index)=>({id:`legacy_${index}`,kind:'unclassified',summary,status:'unknown',blocks:[],resolution:'由系统核对来源、责任及阻塞阶段',sources:[]}));
}
export function blockingGaps(gaps:Gap[],stage:string){return gaps.filter(g=>g.status!=='resolved' && g.blocks.includes(stage as typeof gapStages[number]));}
export const gapsGuidance=`Also return gaps:[{id,kind:reporter_information|system_check|environment|external_wait|maintainer_decision|unclassified,summary,status:unknown|not_checked|pending|resolved|failed,blocks:[triage|preflight|investigate|fix|docs|validate|review|delivery],resolution,sources:string[],waitFor?:ci_completion|author_revision}]. Only unresolved gaps blocking the CURRENT stage prevent stage completion. Unread files and unexecuted checks are system_check, never human information. Missing failure-machine facts belong to reporter_information, not the maintainer by default. CI or author commits are external_wait. Actual policy choices belong to maintainer_decision; yes/no factual questions are still information. Every gap resolution describes the action or condition needed to resolve it, including pending gaps; if unknown, explicitly say 解除条件尚未明确 and keep it unresolved. Resolved gaps require a nonempty resolution and actual sources; a supplied answer is not automatically verified evidence. Complete the finite task-relevant checks once, then report an actionable conclusion or specific blocker. Further reads must resolve a named gap or conflicting evidence; do not continue browsing after the agreed checks are complete. Never treat missing future-stage reproduction as a failure to complete a read-only investigation. Never expand accepted scope after receiving information.`;
