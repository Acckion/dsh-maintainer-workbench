import type { Job, Issue } from '../core/types.ts';
import { inScope, type MaintenanceInventory, type MaintenanceScan, type MaintenanceSnapshot } from '../domain/maintenance.ts';
export type MaintenanceViewScope={domain:string;selection:string;prId:string};
export function scanMatchesView(scan:MaintenanceScan,data:MaintenanceSnapshot,view:MaintenanceViewScope):boolean {
  if(scan.pr?.issueId!==(view.prId||undefined))return false;
  if(view.selection)return inScope(view.selection,scan.scope);
  if(view.domain==='overview'||!scan.scope.length)return true;
  return !!data.inventory?.assets.some(a=>a.domain===view.domain&&inScope(a.path,scan.scope));
}
export function scopedScans(data:MaintenanceSnapshot,view:MaintenanceViewScope):MaintenanceScan[] {
  return data.scans.filter(s=>scanMatchesView(s,data,view)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export function scanIsCurrent(scan:MaintenanceScan,data:MaintenanceSnapshot,pr?:Issue):boolean {
  return scan.pr?!!pr&&pr.headSha===scan.pr.headSha&&pr.prBaseSha===scan.pr.baseSha:scan.current??(!!data.inventory&&scan.revision===data.inventory.revision);
}
export function checkStatus(scan:MaintenanceScan|undefined,job:Job|undefined,current:boolean,paths:string[]) {
  if(!scan)return {label:'尚未检查',detail:'文件清单和正文预览不会自动执行检查。',tone:'neutral' as const};
  if(!current)return {label:scan.state==='pending'&&job?.status==='running'?'正在检查旧版本':scan.state==='pending'&&job?.status==='queued'?'旧版本任务排队中':'当前版本尚未检查',detail:'上次相关记录对应的版本或检查依据已变化。历史记录仍可查看，不能作为当前范围的检查结论。',tone:'neutral' as const};
  if(scan.state==='pending')return {label:job?.status==='running'?'正在检查':job?.status==='queued'?'等待检查':job?.status==='waiting_input'?'等待补充信息':job?.status==='waiting_environment'?'等待执行环境':'等待检查结果',detail:job?.waitingReason||'检查完成后，结果会自动保存。',tone:'neutral' as const};
  if(scan.state==='failed'&&/排队期间输入版本已变化|处理周期已变化/.test(scan.summary??job?.error??''))return {label:'检查未开始',detail:'排队期间输入已更新，旧任务已停止，尚未产生检查结论。重新检查会使用当前版本。',tone:'neutral' as const};
  if(scan.state==='failed'||scan.state==='cancelled')return {label:scan.state==='failed'?'检查失败':'检查已取消',detail:scan.summary||'本次没有完整检查结果，可重新检查。',tone:'warn' as const};
  if(scan.state==='partial'&&job?.status==='cancelled')return {label:'检查已取消',detail:'已有证据已保留，检查尚未完成。',tone:'warn' as const};
  if(scan.state==='partial'||!scan.complete||paths.some(p=>!scan.checkedPaths.includes(p)))return {label:'检查未完成',detail:'本次未完整覆盖所选文件，已有报告可在执行记录中查看。',tone:'warn' as const};
  return {label:'检查已完成',detail:'已覆盖所选文件；检查发现与处理决定保存在问题页。',tone:'good' as const};
}
export function maintenanceJobMatches(job:Job,data:MaintenanceSnapshot,view:MaintenanceViewScope):boolean {
  const scan=data.scans.find(s=>s.jobId===job.id);
  if(scan)return scanMatchesView(scan,data,view);
  if(view.prId?job.issueId!==view.prId:job.issueSnapshot.origin!=='repository')return false;
  if(view.domain!=='overview'&&job.issueSnapshot.organizeMode!==view.domain)return false;
  if(!view.selection)return true;
  const scope=job.issueSnapshot.orchestration?.run?.plan.scope;
  return !!scope?.startsWith('仅修改：')&&inScope(view.selection,scope.slice(4).split('、'));
}
export function documentRole(data:MaintenanceSnapshot,path:string) {
  const oid=data.inventory?.files[path];
  return data.scans.filter(s=>!s.pr&&s.state==='completed').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).flatMap(s=>s.documents??[]).find(d=>d.current!==false&&d.path===path&&d.oid===oid);
}

/** A complete saved tree describes that snapshot, not a later synchronized repository revision. */
export function inventoryIsOutdated(inventory:MaintenanceInventory|undefined,targetRevision:string|undefined):boolean {
  return !!inventory&&inventory.source!=='folder'&&!!targetRevision&&inventory.revision!==targetRevision;
}
export function inventoryReadMessage(error:string):string {
  if(/网络|连接|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout|timed out|超时/i.test(error))return '读取时连接中断或超时，请稍后重试，或检查网络与代理。';
  if(/\b40[13]\b|无权|权限|授权|登录|凭据/i.test(error))return '当前 GitHub 登录无法读取仓库，请检查账号是否具有读取权限。';
  return '暂时无法读取目标版本，请重新读取清单；具体原因可在技术详情中查看。';
}

export function isInventoryReadFailure(error:string):boolean {
  return /文件清单也未读取成功|本地无法读取提交|仓库来源已变化|本地仓库尚无可读取的提交|仓库版本尚未读取/.test(error);
}
