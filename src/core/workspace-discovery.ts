import {realpath,stat} from 'node:fs/promises';
import {resolve,relative,basename,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {git} from './git.ts';
import type {Repo} from './types.ts';
export function githubRemote(value:string):string|undefined {
 const match=value.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)\/?$/i);
 return match?.[1].replace(/\.git$/i,'');
}
export async function discoverWorkspace(path:string, dataDir:string):Promise<Partial<Repo> & Pick<Repo,'id'|'fullName'|'localPath'|'headSha'|'mode'>|undefined> {
 const canonical=await realpath(path);const rel=relative(await realpath(dataDir).catch(()=>resolve(dataDir)),canonical);
 if(rel==='' || (!rel.startsWith('..') && !rel.startsWith('/')))return;
 // Exclude task directories owned by another profile or an earlier local host.
 let ancestor=canonical;
 while(dirname(ancestor)!==ancestor){
  if(['analysis','worktrees'].includes(basename(ancestor)) && await stat(join(dirname(ancestor),'workbench.sqlite')).then(s=>s.isFile()).catch(()=>false))return;
  ancestor=dirname(ancestor);
 }
 let root=canonical,head='',branch='',dirty=false,isGit=false;
 try {root=await realpath(await git(canonical,['rev-parse','--show-toplevel']));isGit=true;head=await git(root,['rev-parse','HEAD']).catch(()=> '');branch=await git(root,['symbolic-ref','--short','HEAD']).catch(()=> 'HEAD');dirty=!!await git(root,['status','--porcelain']);}catch{}
 const remotes:string[]=[];
 if(isGit)for(const name of (await git(root,['remote'])).split('\n').filter(Boolean)){const value=githubRemote(await git(root,['remote','get-url',name]));if(value && !remotes.includes(value))remotes.push(value);}
 const identity=createHash('sha256').update(root).digest('hex').slice(0,20);
 return {id:`local:${identity}`,fullName:remotes.length===1?remotes[0]:basename(root),localPath:root,headSha:head,mode:'local',discovered:true,localKind:isGit?'git':'folder',workspacePaths:[canonical],githubName:remotes.length===1?remotes[0]:undefined,remoteCandidates:remotes,defaultBranch:branch,dirty};
}
