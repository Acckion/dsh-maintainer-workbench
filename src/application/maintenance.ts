import { readdir, lstat, readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { ServiceBase, type ServiceDependencies, type Enqueue } from './service.ts';
import { organizeActions } from '../core/organize.ts';
import type { Issue } from '../core/types.ts';
import { git } from '../core/git.ts';
import { assetFor, digest, fingerprint, scopeFingerprint } from '../core/maintenance.ts';
import { safeRepoPath, type MaintenanceInventory } from '../domain/maintenance.ts';
const skipped=new Set(['.git','node_modules','.data','.deepseek-harness-verify','.harness','.harness-local','.env','.aws','.codex','.agents','dist','build','vendor','.venv']);
export class MaintenanceService extends ServiceBase {
  constructor(deps:ServiceDependencies,private enqueue:Enqueue){super(deps);}
  async audit(repoId:string,scope:string[],instructions='',force=false) {
    if(!this.nativeRunner)throw Error('仓库检查需要 Harness 原生执行器');
    const inventory=await this.inventory(repoId);
    if(scope.some(p=>!safeRepoPath(p) || !Object.keys(inventory.files).some(f=>f===p || f.startsWith(p+'/'))))throw Error('检查范围不存在，请刷新文件清单');
    scope=[...new Set(scope)].sort();
    const fp=scopeFingerprint(inventory,scope);
    const scans=this.store.maintenance.snapshot(repoId).scans;
    if(!force)for(const scan of scans) {
      const saved=this.store.maintenance.scanByJob(scan.jobId)!;
      const job=this.store.get<import('../core/types.ts').Job>('jobs',scan.jobId);
      if(scan.fingerprint===fp && JSON.stringify(scan.scope)===JSON.stringify(scope) && job?.instructions?.endsWith('Maintainer scope: '+instructions) && ['completed','pending'].includes(scan.state) && (!saved.dependencies?.length || fingerprint(inventory.files,saved.dependencies)===fingerprint(saved.inventoryFiles,saved.dependencies)))return {created:[],reused:[scan.jobId]};
    }
    const repo=this.repo(repoId),key=digest([scope,fp,instructions]),id=`${repoId}:maintenance:audit:${key}`;
    if(!this.store.get<Issue>('issues',id))this.store.put('issues',{id,repoId,origin:'repository',organizeMode:'audit',type:'issue',number:0,title:'仓库检查'+(scope.length?' · '+scope.join('、'):''),body:'Read-only repository audit. Scope: '+JSON.stringify(scope),author:'维护者',labels:[],state:'open',comments:0,updatedAt:new Date().toISOString(),url:''});
    const prompt=organizeActions.audit.instructions+`
Return a maintenance object in the investigation JSON: {complete:boolean,checkedPaths:string[],findings:[{key:string (stable machine key for the same problem),domain:docs|agents|ci,kind:contradiction|missing|suggestion|uncertain,title:string,paths:string[],dependencies:string[],impact:string,evidence:[{source:string,detail:string}],recommendation:string}]}. Findings require exact repository-relative paths and concrete evidence. dependencies MUST include every source/config file used to establish a claim. List actually inspected paths in checkedPaths. complete=false when requested coverage is incomplete or blocked. An empty findings array is valid. Never classify optional missing AGENTS.md or long documents as defects without demonstrated impact. Scope: ${JSON.stringify(scope.length?scope:['entire repository'])}. Do not inspect unrelated folders. No script execution needed for inventory.
Maintainer scope: `+instructions;
    return this.store.transaction(()=>{const result=this.enqueue([id],'investigate',{instructions:prompt,forceNew:force});const jobId=result.created[0]??result.reused[0];if(result.created.length)this.store.maintenance.saveScan({id:jobId,repoId,jobId,revision:inventory.revision,scope,fingerprint:fp,inventoryFiles:inventory.files,createdAt:new Date().toISOString(),state:'pending',checkedPaths:[],complete:false});return result;});
  }

  private inventories=new Map<string,Promise<MaintenanceInventory>>();
  inventory(repoId:string) {
    const active=this.inventories.get(repoId);if(active)return active;
    const task=this.readInventory(repoId).finally(()=>this.inventories.delete(repoId));this.inventories.set(repoId,task);return task;
  }
  private async readInventory(repoId:string):Promise<MaintenanceInventory> {
    const repo=this.repo(repoId);let revision=repo.headSha,source:MaintenanceInventory['source']='remote',dirty=false,complete=true;
    const files:Record<string,string>={};const warnings:string[]=[];
    if(repo.localPath && repo.localKind!=='folder') {
      source='commit';
      if(repo.mode==='local')revision=await git(repo.localPath,['rev-parse','HEAD']);
      if(!revision)throw Error('仓库尚无可读取的提交');
      const tree=await git(repo.localPath,['ls-tree','-rz',revision]);
      for(const entry of tree.split('\0')) {const match=/^100(?:644|755) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);if(match && safeRepoPath(match[2]))files[match[2]]=match[1];}
      dirty=!!(await git(repo.localPath,['status','--porcelain','--untracked-files=no']));
      if(dirty)warnings.push('清单及后续修改基于已提交版本，未提交文件保留，不会混入执行。');
    } else if(repo.localPath) {
      source='folder';complete=false;revision='';warnings.push('普通文件夹：仅识别文件清单；修改执行需要至少一个 Git 提交。');
      let visited=0;const root=await realpath(repo.localPath);
      const walk=async(dir:string,depth:number):Promise<void>=>{if(depth>8 || visited>20000){return;}
        for(const entry of await readdir(dir,{withFileTypes:true})){if(skipped.has(entry.name)||entry.name.startsWith('.env'))continue;visited++;
          const path=join(dir,entry.name),rel=relative(root,path).split('\\').join('/');
          if(entry.isSymbolicLink()||!safeRepoPath(rel))continue;
          if(entry.isDirectory())await walk(path,depth+1);
          else if(entry.isFile()){const stat=await lstat(path);files[rel]=`${stat.size}:${stat.mtimeMs}`;}
          if(visited>20000)break;
        }};
      await walk(root,0);warnings.push('文件夹识别最多 8 层、20,000 项；不读取凭据目录或跟随符号链接。');
    } else {
      if(!revision)throw Error('请先同步仓库，读取当前版本');
      const tree=z.object({truncated:z.boolean().optional(),tree:z.array(z.object({path:z.string(),type:z.string(),mode:z.string().optional(),sha:z.string()}))}).parse(await this.github.request(`/repos/${repo.githubName??repo.fullName}/git/trees/${revision}?recursive=1`,{signal:AbortSignal.timeout(30000)}));
      complete=!tree.truncated;
      for(const entry of tree.tree)if(entry.type==='blob' && entry.mode!=='120000' && safeRepoPath(entry.path))files[entry.path]=entry.sha;
      if(!complete)warnings.push('GitHub 返回的文件树不完整，未覆盖部分不能视为已检查。');
    }
    const assets=Object.entries(files).map(([p,oid])=>assetFor(p,oid)).filter((a):a is NonNullable<typeof a>=>!!a).sort((a,b)=>a.path.localeCompare(b.path));
    const inventory:MaintenanceInventory={repoId,revision,fingerprint:fingerprint(files),files,assets,source,dirty,complete,warnings,scannedAt:new Date().toISOString()};
    const current=this.repo(repoId);
    if(current.localPath!==repo.localPath || current.headSha!==repo.headSha)throw Error('仓库来源已变化，请重新读取');
    if(repo.mode==='local' && revision!==repo.headSha)this.store.put('repos',{...current,headSha:revision,dirty});
    this.store.maintenance.saveInventory(inventory);return inventory;
  }
  async asset(repoId:string,path:string) {
    if(!safeRepoPath(path))throw Error('无效仓库路径');
    const inv=this.store.maintenance.inventory(repoId);if(!inv?.assets.some(a=>a.path===path))throw Error('文件不在已识别清单中，请刷新清单');
    const repo=this.repo(repoId);let content:string;
    if(inv.source==='folder') {
      // Folder inventory remains metadata-only; avoid races and accidental credential reads.
      return {path,revision:'',content:'普通文件夹目前仅显示清单；创建 Git 提交后可以预览固定版本内容。',truncated:false};
    }
    if(repo.localPath) {const oid=inv.files[path];if(!/^[0-9a-f]{40,64}$/.test(oid))throw Error('无效文件版本');const size=Number(await git(repo.localPath,['cat-file','-s',oid]));if(size>128000)return {path,revision:inv.revision,content:'文件超过 128 KB，未自动读取；可缩小检查范围。',truncated:true};content=await git(repo.localPath,['cat-file','blob',oid],false,undefined,30000,true);}
    else {const blob=z.object({encoding:z.literal('base64'),content:z.string(),size:z.number().optional()}).parse(await this.github.request(`/repos/${repo.githubName??repo.fullName}/git/blobs/${inv.files[path]}`,{signal:AbortSignal.timeout(30000)}));content=Buffer.from(blob.content,'base64').toString('utf8');}
    return {path,revision:inv.revision,content:content.slice(0,128000),truncated:content.length>128000};
  }
}
