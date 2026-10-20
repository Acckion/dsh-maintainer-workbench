import type {Job} from '../core/types.ts';
import {reportNeedsRecovery} from '../core/report-state.ts';
import {RepositoryMarkdown} from './RepositoryDetail.tsx';
import {Tag} from './Primitives.tsx';
import {taskStatus} from './review-evidence.ts';
export function RepositoryJobResult({job,open,command,disabled,recheck}:{job:Job;open:(id:string)=>void;command:(path:string,id:string)=>void;disabled:boolean;recheck?:()=>void}) {
 const report=job.artifact??job.result;
 const download=()=>{const url=URL.createObjectURL(new Blob([job.patch??''],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`maintenance-${job.id}.patch`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 return <article className="mw-repository-section"><div className="mw-repository-section-heading"><strong>{job.issueSnapshot.title}</strong><Tag tone={taskStatus(job).tone}>{taskStatus(job).label}</Tag></div><small>{new Date(job.createdAt).toLocaleString('zh-CN')} · {job.kind} · {job.baseSha?.slice(0,10)}</small>
  {job.budgetStopped&&<p role="status">执行已停止，部分证据已保存；任务尚未完成。</p>}
  {job.toolDiagnostics?.toolBudget&&<p>工具预算 {job.toolDiagnostics.toolBudget.used}/{job.toolDiagnostics.toolBudget.limit} · 搜索 {job.toolDiagnostics.toolBudget.searches} 次 · 报告收尾 {job.toolDiagnostics.toolBudget.reportRequests}/2</p>}
  {job.error&&<p role="alert" className="mw-repository-error">{job.error}</p>}
  {report&&<RepositoryMarkdown text={report.summary}/>}
  {job.issueSnapshot.maintenancePlanId&&<p>本任务属于已确认的仓库维护计划，最终交付与检查问题复查分别记录。</p>}
  {report&&<details><summary>检查依据与执行结果</summary>{report.evidence.map((e,i)=><p key={i}><code>{e.source}</code> · {e.detail}</p>)}{'tests' in report&&report.tests.map((t,i)=><div className="mw-repository-evidence" key={i}><code>{t.command}</code><Tag>{t.status}</Tag><pre>{t.output}</pre></div>)}{'blockers' in report&&report.blockers.map((b,i)=><p key={i}>{b}</p>)}</details>}
  {job.patch&&<details><summary>文件差异与补丁</summary><pre className="mw-maintenance-source">{job.patch}</pre><button className="mw-button" onClick={download}>导出补丁</button></details>}
  <div className="mw-repository-actions"><button className="mw-button" onClick={()=>open(job.id)}>查看执行与审阅</button>{['queued','running'].includes(job.status)&&<button className="mw-button" disabled={disabled} onClick={()=>command('/cancel',job.id)}>取消任务</button>}{recheck?<button className="mw-button" disabled={disabled} onClick={recheck}>按当前范围重新检查</button>:job.status==='failed'&&!job.workflowRunId&&<button className="mw-button" disabled={disabled} onClick={()=>command(reportNeedsRecovery(job)?'/retry':'/rerun',job.id)}>重试</button>}</div>
 </article>;
}
