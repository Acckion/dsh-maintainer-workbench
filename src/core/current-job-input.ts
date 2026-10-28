import {classificationRevision} from './classification.ts';
import {revision} from './revision.ts';
import type {Issue,Job,Repo} from './types.ts';

/** Explain only an exact, receipted own-comment update; other remote changes invalidate. */
export function currentJobRevision(job:Job,issue:Issue,repo:Repo,jobs:Job[]):string {
 const current=revision(issue,repo,job.kind);
 if(current===job.revision)return current;
 const original=job.issueSnapshot;
 if(classificationRevision({...issue,comments:original.comments})!==classificationRevision(original)||issue.state!==original.state)return current;
 const receipts=[];const seen=new Set<string>();let source:Job|undefined=job;
 while(source&&!seen.has(source.id)&&seen.size<30){
  if(source.repoId!==job.repoId||source.issueId!==job.issueId||source.caseId!==job.caseId)break;
  seen.add(source.id);const receipt=source.publications?.comment;
  if(receipt?.status==='published'&&receipt.remoteUpdatedAt&&Date.parse(receipt.remoteUpdatedAt)>Date.parse(original.updatedAt)&&receipt.urls.length===1&&/#issuecomment-\d+$/.test(receipt.urls[0]))receipts.push(receipt);
  source=jobs.find(candidate=>candidate.id===source!.sourceJobId);
 }
 if(!receipts.some(r=>r.remoteUpdatedAt===issue.updatedAt)||issue.comments!==original.comments+new Set(receipts.flatMap(r=>r.urls)).size)return current;
 return revision({...issue,updatedAt:original.updatedAt},repo,job.kind);
}
