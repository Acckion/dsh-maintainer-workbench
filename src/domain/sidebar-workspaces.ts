import {kindNames,type Job,type JobStatus,type Repo} from '../core/types.ts';

export interface SidebarRun {
  id:string; issueId:string; repoId:string; kind:Job['kind']; status:JobStatus;
  createdAt:string; sessionId?:string; path?:string; group:string; title:string;
}
/** Small read-only projection; no messages, patches, credentials or directory writes. */
export function sidebarRuns(jobs:Job[],repos:Repo[]):SidebarRun[] {
  return jobs.map(job=>{
    const repo=repos.find(r=>r.id===job.repoId),issue=job.issueSnapshot;
    const ref=issue.origin==='repository' ? issue.title : `${issue.type==='pr' ? 'PR' : 'Issue'} #${issue.number}`;
    return {id:job.id,issueId:job.issueId,repoId:job.repoId,kind:job.kind,status:job.status,createdAt:job.createdAt,sessionId:job.sessionId,path:job.worktree ?? job.analysisPath,
      group:JSON.stringify([job.repoId,job.issueId,job.kind]),title:`${ref} · ${kindNames[job.kind]} · ${repo?.githubName ?? repo?.fullName ?? job.repoId}`};
  });
}
