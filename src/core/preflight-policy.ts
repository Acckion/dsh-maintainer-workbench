import {z} from 'zod';
import type { Job, PRContext } from './types.ts';
import { blockingGaps, type Gap } from '../domain/gaps.ts';

/** CI availability is coverage, never permission to run a local review. */
const ciText = /\bCI\b|check[-_ ]?runs?|commit status|status checks?|持续集成|分支保护/i;
const isCICoverage=(text:string)=>ciText.test(text) && !/node_modules|\bpnpm\b|\bnpm\b|\bnode(?:\.js)?\b|依赖安装|运行环境|运行时/i.test(text);
function requirements(pr: PRContext): {context:string;appId?:number|null}[] {
  const parsed=z.object({required_status_checks:z.object({contexts:z.array(z.string().min(1)).optional(),checks:z.array(z.object({context:z.string().min(1),app_id:z.number().nullable().optional()})).optional()}).nullable().optional()}).safeParse(pr.branchProtection);
  const protection=parsed.success ? parsed.data : undefined;
  const checks=protection?.required_status_checks?.checks ?? [];
  const parsedRules=z.array(z.object({type:z.string(),parameters:z.unknown().optional()})).safeParse(pr.branchRules);
  const rules=parsedRules.success ? parsedRules.data : [];
  return [
    ...(protection?.required_status_checks?.contexts ?? []).filter(context=>!checks.some(c=>c.context===context)).map(context=>({context})),
    ...checks.map(c=>({context:c.context,appId:c.app_id})),
    ...rules.filter(r=>r.type==='required_status_checks').flatMap(r=>{
      const parameters=z.object({required_status_checks:z.array(z.object({context:z.string().min(1),integration_id:z.number().nullable().optional()}))}).safeParse(r.parameters);
      return parameters.success ? parameters.data.required_status_checks.map(c=>({context:c.context,appId:c.integration_id})) : [];
    }),
  ].filter(c=>typeof c.context==='string' && !!c.context);
}
export function requiredCIGates(pr: PRContext): string[] {
  return [...new Set(requirements(pr).map(c=>c.context))];
}
export function unmetRequiredCI(pr: PRContext): string[] {
  const runs=(pr.checks as {check_runs?: {name:string;head_sha?:string;status:string;conclusion:string;app?:{id:number}}[]} | null)?.check_runs ?? [];
  const status=pr.commitStatus as {sha?:string;statuses?:{context:string;state:string}[]} | null;
  return [...new Set(requirements(pr).filter(c=>{
    const run=runs.find(r=>r.name===c.context && r.head_sha===pr.headSha &&
      (c.appId==null || c.appId===-1 || r.app?.id===c.appId));
    if(run)return !(run.status==='completed' && ['success','neutral','skipped'].includes(run.conclusion));
    return !(c.appId==null || c.appId===-1) || status?.sha!==pr.headSha ||
      !status.statuses?.some(s=>s.context===c.context && s.state==='success');
  }).map(c=>c.context))];
}

export function normalizePreflight(artifact: NonNullable<Job['artifact']>, pr?: PRContext): NonNullable<Job['artifact']> {
  if (artifact.stage!=='preflight' || !pr) return artifact;
  const required = requiredCIGates(pr);
  const unmet = unmetRequiredCI(pr);
  // A model's CI gap cannot establish a branch rule. Unknown coverage stays unresolved.
  const normalize = (gaps: Gap[] | undefined) => gaps?.map(g=>
    g.waitFor==='ci_completion' || (['environment','external_wait','unclassified','system_check'].includes(g.kind) && isCICoverage(g.summary))
      ? {...g, kind:'external_wait' as const, waitFor:'ci_completion' as const,
          blocks:[],
          resolution:required.length ? g.resolution : 'CI 与必需门禁覆盖尚未确认；继续本地审查，交付时重新核对实际门禁'}
      : g);
  const gaps=normalize(artifact.gaps);
  const gate: Gap | undefined=required.length ? {id:'host_required_ci',kind:'external_wait',waitFor:'ci_completion',status:'pending',blocks:unmet.length ? ['delivery'] : [],summary:`已确认必需 CI 门禁：${required.join('、')}；${unmet.length ? '尚未满足：'+unmet.join('、') : '当前结果已满足，交付时仍需复核版本'}`,resolution:'依赖 CI 的交付操作前重新读取必需检查及结果；不阻塞本地审查、补丁导出或更新 PR',sources:[`base:${pr.baseRef}`,`head:${pr.headSha}`]} : undefined;
  const withGate=(items:Gap[] | undefined)=>gate ? [...(items ?? []).filter(g=>g.id!==gate.id),gate] : items;
  const planDraft=artifact.planDraft ? {...artifact.planDraft,gaps:withGate(normalize(artifact.planDraft.gaps))} : undefined;
  const blockers=artifact.blockers.filter(b=>!isCICoverage(b));
  const current=blockingGaps([...(gaps ?? []),...(planDraft?.gaps ?? [])],'review').filter(g=>g.kind!=='system_check');
  const readiness=pr.merged ? 'blocked' : pr.draft ? 'draft' :
    blockers.length || current.length ? 'blocked' : 'review';
  return {...artifact,gaps:withGate(gaps),planDraft,blockers,readiness};
}
