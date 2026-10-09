import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-workspace';
import type {SessionId} from '@deepseek-ai/dsh-session';
import {kindNames,type Job,type Repo} from '../core/types.ts';
import {lightweight} from '../core/artifacts.ts';
import {DatabaseSync} from 'node:sqlite';
import {basename,dirname,join} from 'node:path';
import {existsSync} from 'node:fs';

export function taskWorkspaceTitle(repo:Pick<Repo,'fullName'|'githubName'>,job:Job):string {
 const issue=job.issueSnapshot;
 return `${repo.githubName ?? repo.fullName} · ${issue.origin==='repository' ? issue.title : `${issue.type==='pr' ? 'PR' : 'Issue'} #${issue.number}`} · ${kindNames[job.kind]}${job.attempt>1 ? ` · ${job.attempt}` : ''}`.slice(0,160);
}
/** Only remove registration, never directories/session logs; verify ownership against durable jobs. */
export async function organizeTaskWorkspaces(ctx:Context,jobs:Job[],repos:Repo[]):Promise<void> {
 for(const workspace of ctx.workspaceRegistry.list()) {
  let job=jobs.find(j=>j.worktree===workspace.path || j.analysisPath===workspace.path);
  if(!job && ['analysis','worktrees'].includes(basename(dirname(workspace.path)))) {
   const dbPath=join(dirname(dirname(workspace.path)),'workbench.sqlite');
   if(existsSync(dbPath)) {
    let db:DatabaseSync|undefined;
    try {db=new DatabaseSync(dbPath,{readOnly:true});const row=db.prepare("SELECT data FROM jobs WHERE id=?").get(basename(workspace.path));
     const candidate=row ? JSON.parse(String(row.data)) as Job : undefined;
     if(candidate && (candidate.analysisPath===workspace.path || candidate.worktree===workspace.path)) job=candidate;
    } catch { /* A foreign/older database is not evidence of ownership. */ } finally {db?.close();}
   }
  }
  if(!job) continue;
  if(lightweight(job.kind)) {
   if(['queued','running'].includes(job.status) || workspace.sessionIds.some(id=>!String(id).startsWith('maintainer-'))) continue;
   for(const id of workspace.sessionIds) await ctx.workspaceRegistry.archiveSession(id as SessionId);
   await ctx.workspaceRegistry.delete(workspace.id);
  } else {
   const repo=repos.find(r=>r.id===job!.repoId) ?? {fullName:job.repoId};
   await workspace.setTitle(taskWorkspaceTitle(repo,job));
  }
 }
}
