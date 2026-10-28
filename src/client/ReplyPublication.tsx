import {useEffect,useRef,useState} from 'react';
import type {Job} from '../core/types.ts';
import {request} from './api.ts';
import {flushItemDraft,saveItemDraft,useItemDraft} from './item-draft.ts';
import {Modal} from './Primitives.tsx';
import {publicationPreviewCurrent,type PublicationPreview} from './PublicationConfirm.tsx';

/** Seed editable prose from the accepted report, without inferring tests or a merge decision. */
export function replyFromReport(job:Job):string{
 if(job.result?.responseDraft?.trim())return job.result.responseDraft;
 const summary=job.artifact?.summary??job.result?.summary;if(!summary?.trim())return '';
 const coverage=job.artifact?.coverage;
 return [summary,coverage?`审查范围与限制：${coverage}`:'','以上为 AI 辅助分析，经维护者本地确认。'].filter(Boolean).join('\n\n');
}
export function publicationError(error:unknown):string{
 const message=error instanceof Error?error.message:'发布未完成，请重试';
 if(/\b403\b|Resource not accessible|权限不足/i.test(message))return `${message}\n请在 GitHub 连接设置中核对当前账号与评论权限；公开仓库可读取不代表当前凭据可发布评论。`;
 if(/\b401\b|Bad credentials/i.test(message))return `${message}\n请在 GitHub 连接设置中更新登录后重试发布。`;
 return message;
}
/** One explicit publish action. Freshness and duplicate checks run internally, never as extra confirmations. */
export function ReplyPublication({job,repository,close,published,direct=true}:{job:Job;repository:string;direct?:boolean;close:()=>void;published:(urls:string[])=>Promise<void>}){
 const {draft,ready,error:draftError}=useItemDraft(job.issueId);
 const initialized=useRef(false),inFlight=useRef(false);
 const [body,setBody]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [urls,setUrls]=useState<string[]>([]),[sent,setSent]=useState(false);
 useEffect(()=>{
  if(ready&&!initialized.current){initialized.current=true;const initial=typeof draft.reply==='string'?draft.reply:replyFromReport(job);setBody(initial);if(direct&&initial.trim())void send(initial);}
 },[ready,draft.reply,job,direct]);
 async function send(text:string){
  if(inFlight.current||!text.trim()||sent)return;
  inFlight.current=true;setBusy(true);setError('');
  try{
   await saveItemDraft(job.issueId,{reply:text});await flushItemDraft(job.issueId);
   const checked:PublicationPreview=await request('/publish/preview',{id:job.id,action:'comment'});
   if(!publicationPreviewCurrent(checked,job))throw Error('报告版本或审批已变化，请回到处理流程核对后再发布。');
   const result=await request('/publish',{id:job.id,action:'comment',previewStamp:checked.stamp});
   setUrls(result.urls??[]);setSent(true);await published(result.urls??[]);
  }catch(e){setError(publicationError(e));}finally{inFlight.current=false;setBusy(false);}
 }
 return <Modal title="发布评论到 GitHub" busy={busy} close={close}><div className="mw-modal">
  <button className="mw-modal-close" aria-label="关闭回复发布窗口" disabled={busy} onClick={close}>×</button><h2>发布评论到 GitHub</h2>
  <p>发布目标：{repository} · #{job.issueSnapshot.number}</p>
  {busy?<p role="status">正在发布评论…</p>:sent?<section role="status"><h3>回复已发布</h3>{urls.map(url=><p key={url}><a href={url} target="_blank" rel="noreferrer">在 GitHub 查看已发布的回复</a></p>)}<button className="mw-button" onClick={close}>关闭</button></section>:<>
   <label className="mw-field">回复内容<textarea aria-label="回复内容" rows={9} disabled={!ready} value={body} onChange={e=>{setBody(e.target.value);setError('');}} placeholder="填写准备发布给贡献者的回复…"/></label>
   {!!draftError&&<p role="alert" className="mw-callout amber">{draftError}</p>}
   {!!error&&<p role="alert" className="mw-callout amber" style={{whiteSpace:'pre-wrap'}}>{error}</p>}
   {!body.trim()&&ready&&<p role="status">尚未填写回复。可以手动输入，或引用已确认的审查结论。</p>}
   <div className="mw-actions"><button className="mw-button" disabled={!ready} onClick={()=>{setBody(replyFromReport(job));setError('');}}>引用审查结论</button><button className="mw-button primary" disabled={!ready||!body.trim()} onClick={()=>void send(body)}>{error?'重试发布':'发布评论'}</button></div>
  </>}
 </div></Modal>;
}
