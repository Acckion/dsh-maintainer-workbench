import type {Job} from '../core/types.ts';
import {kindNames} from '../core/types.ts';
import {taskStatus} from './review-evidence.ts';
import type {DetailTab} from './ReviewSummary.tsx';

/** Saved delivery and explicit follow-up lineage, including running and failed work. */
export function deliveryHistory(selected:Job,jobs:Job[]) {
  const candidates=jobs.filter(j=>j.issueId===selected.issueId&&j.repoId===selected.repoId&&(selected.caseId?j.caseId===selected.caseId:!j.caseId));
  const ids=new Set([selected.id]);
  // Include the source chain when a newer repair/validation is selected.
  let cursor:Job|undefined=selected;
  while(cursor?.sourceJobId&&!ids.has(cursor.sourceJobId)) {const source=candidates.find(j=>j.id===cursor!.sourceJobId);if(!source)break;ids.add(source.id);cursor=source;}
  let changed=true;
  while(changed){changed=false;for(const job of candidates)if(job.sourceJobId&&ids.has(job.sourceJobId)&&!ids.has(job.id)){ids.add(job.id);changed=true;}}
  const rows:{id:string;at:string;title:string;job:Job;url?:string;error?:string}[]=[];
  for(const job of candidates.filter(j=>ids.has(j.id))){
    if(job.finishedAt)rows.push({id:job.id+':result',at:job.finishedAt,title:`${kindNames[job.kind]} · ${job.status==='approved'?'报告已保存':taskStatus(job).label}`,job,error:job.error});
    if(job.startedAt || !job.finishedAt) rows.push({id:job.id+':start',at:job.startedAt??job.createdAt,title:`${kindNames[job.kind]} · ${job.finishedAt?'开始执行':taskStatus(job).label}`,job});
    for(const [kind,receipt] of Object.entries(job.publications??{})){
      const name=({comment:'PR 评论',review:'GitHub 审查',labels:'标签',pr:'PR',update_pr:'PR 更新'} as Record<string,string>)[kind]??kind;
      rows.push({id:job.id+':'+kind,at:receipt.at,title:`${name} · ${{published:'已发布',publishing:'发布中',failed:'发布失败'}[receipt.status]}`,job,url:receipt.urls[0],error:receipt.error});
    }
  }
  return rows.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
}
export function DeliveryTimeline({job,jobs,open}:{job:Job;jobs:Job[];open:(id:string,tab:DetailTab)=>void}){
 const rows=deliveryHistory(job,jobs);
 return <section className="mw-delivery-history" aria-label="交付与后续处理时间线"><h4>交付与后续处理</h4><ol>{rows.map(row=><li key={row.id}><time dateTime={row.at}>{new Date(row.at).toLocaleString('zh-CN',{hour12:false})}</time><strong>{row.title}</strong>{row.error&&<p role="status">{row.error}</p>}<div>{row.url&&<a href={row.url} target="_blank" rel="noreferrer">查看交付结果</a>}<button className="mw-text-button" onClick={()=>open(row.job.id,'overview')}>查看{kindNames[row.job.kind]}记录</button></div></li>)}</ol></section>;
}
