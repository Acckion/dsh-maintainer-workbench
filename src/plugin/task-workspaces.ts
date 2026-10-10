import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-workspace';
import type {SessionId} from '@deepseek-ai/dsh-session';
import {type Job,type Repo} from '../core/types.ts';
import {conversationCategories,repositoryConversationTitle,taskConversationCategory} from '../core/conversations.ts';
import {DatabaseSync} from 'node:sqlite';
import {basename,dirname,join} from 'node:path';
import {statSync} from 'node:fs';

/** Optional historical metadata must not hydrate cloud placeholders on the host thread. */
export function taskDatabaseAvailable(path:string):boolean {
 try {
  const file=statSync(path);if(!file.isFile() || file.size===0 || file.blocks===0)return false;
  for(const suffix of ['-wal','-shm']) {
   try {const companion=statSync(path+suffix);if(!companion.isFile() || companion.size>0 && companion.blocks===0)return false;}
   catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')return false;}
  }
  return true;
 } catch {return false;}
}

export function taskWorkspaceTitle(repo:Pick<Repo,'fullName'|'githubName'>,job:Job):string {
 return `${repositoryConversationTitle(repo)} · ${conversationCategories[taskConversationCategory(job)]}`.slice(0,160);
}
/** Only remove registration, never directories/session logs; verify ownership against durable jobs. */
export async function organizeTaskWorkspaces(ctx:Context,jobs:Job[],repos:Repo[]):Promise<void> {
 for(const workspace of ctx.workspaceRegistry.list()) {
  let job=jobs.find(j=>j.worktree===workspace.path || j.analysisPath===workspace.path);
  if(!job && ['analysis','worktrees'].includes(basename(dirname(workspace.path)))) {
   const dbPath=join(dirname(dirname(workspace.path)),'workbench.sqlite');
   if(taskDatabaseAvailable(dbPath)) {
    let db:DatabaseSync|undefined;
    try {db=new DatabaseSync(dbPath,{readOnly:true});const row=db.prepare("SELECT data FROM jobs WHERE id=?").get(basename(workspace.path));
     const candidate=row ? JSON.parse(String(row.data)) as Job : undefined;
     if(candidate && (candidate.analysisPath===workspace.path || candidate.worktree===workspace.path)) job=candidate;
    } catch { /* A foreign/older database is not evidence of ownership. */ } finally {db?.close();}
   }
  }
  if(!job) continue;
  if(['queued','running'].includes(job.status)) continue;
  // A prefix alone is not ownership: shared human/category sessions must remain visible.
  const owned = workspace.sessionIds.filter(id=>jobs.some(j=>id===(j.sessionId ?? `maintainer-${j.id}`)) || id===(job!.sessionId ?? `maintainer-${job!.id}`));
  for(const id of owned) await ctx.workspaceRegistry.archiveSession(id as SessionId);
  const managed = ['analysis','worktrees'].includes(basename(dirname(workspace.path))) && basename(workspace.path)===job.id;
  if(managed && owned.length===workspace.sessionIds.length) await ctx.workspaceRegistry.delete(workspace.id);
 }
}
