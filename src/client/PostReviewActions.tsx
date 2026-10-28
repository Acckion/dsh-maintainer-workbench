import {useState} from 'react';
import type {Issue,Job} from '../core/types.ts';
import {useItemDraft} from './item-draft.ts';

type Act=(label:string,path:string,data:unknown,message?:string)=>Promise<unknown>;
/** Explicit follow-ups after a published review. No edits or model work on render/sync. */
export function PostReviewActions({job,issue,jobs,native,busy,action}:{job:Job;issue?:Issue;jobs:Job[];native:boolean;busy:boolean;action:Act}){
 const {draft,ready,error,update}=useItemDraft(job.issueId);
 const [fix,setFix]=useState(false),[selected,setSelected]=useState<string[]>([]);
 if(!issue||job.artifact?.stage!=='review'||issue.type!=='pr')return null;
 const findings=job.artifact.findings,waiting=draft.reviewFollowupId===job.id;
 const changed=!!job.prContext&&!!issue.headSha&&(issue.headSha!==job.prContext.headSha||!!issue.prBaseSha&&issue.prBaseSha!==job.prContext.baseSha);
 const active=jobs.some(j=>j.issueId===issue.id&&['queued','running'].includes(j.status));
 const disabled=busy||active||issue.state!=='open';
 const fixBlocked=disabled||job.status!=='approved'||job.evidenceGate?.allowed===false;
 const outdated=changed||issue.title!==job.issueSnapshot.title||issue.body!==job.issueSnapshot.body;
 return <section className="mw-post-review" aria-label="发布后的下一步">
  <h4>结论已发布，接下来怎么处理？</h4>
  <div className="mw-post-review-options">
   {!!findings.length&&<button className="mw-button" disabled={fixBlocked||!native||outdated} onClick={()=>setFix(!fix)}>由插件修复 Bug…</button>}
   {!waiting&&<button className="mw-button" disabled={disabled||!ready} onClick={()=>update({reviewFollowupId:job.id})}>等待作者更新后复审</button>}
  </div>
  {!!findings.length&&!native&&<p>修复任务需要在 Harness 中执行。</p>}
  {outdated&&<p>PR 内容已更新，请先审查新版本，再决定修复范围。</p>}
  {fix&&<section className="mw-fix-scope" aria-label="确认修复范围"><h4>选择本次要修复的问题</h4>
   {findings.map(f=><label key={f.id}><input type="checkbox" checked={selected.includes(f.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,f.id]:ids.filter(id=>id!==f.id))}/>{f.title} · {f.path}</label>)}
   <p>会创建独立修复任务并运行必要验证。补丁完成后由你审核，再选择交付；Fork PR 无推送权限时可下载补丁交给作者。</p>
   <button className="mw-button primary" disabled={fixBlocked||outdated||!native||!selected.length} onClick={async()=>{const result=await action('fix','/jobs',{issueIds:[issue.id],kind:'fix',sourceJobId:job.id,expectedVersion:issue.processing?.version,instructions:'仅修复以下已确认的审查问题，补充针对性回归测试并执行必要验证；不要发布或合并 PR：\n'+findings.filter(f=>selected.includes(f.id)).map(f=>`${f.id}: ${f.title} (${f.path})\n${f.trigger}\n${f.recommendation}`).join('\n')},'已启动修复任务；请在当前事项的修复阶段查看进度');if(result)setFix(false);}}>确认范围并开始修复</button>
  </section>}
  {waiting&&<section aria-label="等待作者更新"><p>{issue.state!=='open'?'PR 已关闭，不再启动复审。':changed?'已检测到 PR 新版本，可以复审。':'正在等待作者更新。同步会检查新提交；不会因等待或同步自动调用模型。'}</p>
   <button className="mw-button" disabled={busy||active} onClick={()=>void action('sync-review','/remote/sync',{issueId:issue.id},'已同步 PR 状态；有新提交时可开始复审')}>同步 PR 状态</button>
   <button className="mw-button primary" disabled={disabled||!changed} onClick={()=>void action('review-update','/jobs',{issueIds:[issue.id],kind:'review',sourceJobId:job.id,expectedVersion:issue.processing?.version,instructions:'复审 PR 的最新提交，逐项核对上一轮审查问题是否已修复，并审查新增变更；引用当前版本证据，不自动发布或合并。'},'已启动新版本复审，上一轮结论保留')}>审查更新后的 PR</button>
   <button className="mw-text-button" disabled={busy} onClick={()=>update({reviewFollowupId:''})}>取消等待</button>
  </section>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
