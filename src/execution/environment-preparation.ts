import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile, stat } from 'node:fs/promises';
import { resolve, join, isAbsolute, delimiter, relative, basename } from 'node:path';
import semver from 'semver';
import { environmentPolicySchema, type EnvironmentPreparation } from '../domain/environment.ts';
import type { Job, Repo } from '../core/types.ts';
import { collectPatch, git } from '../core/git.ts';
import { EnvironmentUnavailable } from './environment-error.ts';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const environmentPolicyKey=(repo:Repo)=>digest(JSON.stringify(environmentPolicySchema.parse(repo.policy?.environment??{})));
const exists=async(path:string)=>access(path).then(()=>true,()=>false);
const redact=(text:string)=>text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@').replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,'[redacted]').replace(/((?:_authToken|password|token)\s*[=:]\s*)\S+/gi,'$1[redacted]');
const installationForbidden=(job:Job)=>/(?:禁止|不|不得|未获授权)[^。；\n]{0,16}安装(?:依赖|工具)|do not install|no dependency install/i.test([job.instructions,job.issueSnapshot.plan?.scope,...(job.issueSnapshot.plan?.acceptanceCriteria??[])].join('\n'));

/** Bounded child process with group cancellation, no shell or model commands. */
export function environmentProcess(file:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal,timeout:number,onOutput?:(chunk:string)=>void):Promise<string>{
  signal.throwIfAborted();
  return new Promise((accept,reject)=>{
    const child=spawn(file,args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let output='',stopped:Error|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
    const kill=(sig:NodeJS.Signals)=>{if(!child.pid)return;try{process.platform==='win32'?child.kill(sig):process.kill(-child.pid,sig);}catch{}};
    const stop=(reason:Error)=>{if(stopped)return;stopped=reason;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1500);};
    const abort=()=>stop(signal.reason instanceof Error?signal.reason:new Error('环境准备已取消'));
    const timer=setTimeout(()=>stop(new Error('环境准备超时，请检查日志后明确重试')),timeout);
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const chunk=(data:Buffer)=>{const text=redact(data.toString());output=(output+text).slice(-16000);onOutput?.(text);};
    child.stdout.on('data',chunk);child.stderr.on('data',chunk);
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    child.on('error',error=>{cleanup();if(killTimer)clearTimeout(killTimer);reject(error);});
    child.on('close',(code,sig)=>{cleanup();if(killTimer)clearTimeout(killTimer);if(stopped)reject(stopped);else if(code!==0||sig)reject(new Error(`环境命令失败（${sig??code}）：${output.slice(-3000)}`));else accept(output.trim());});
  });
}

// Different workspaces keep their dependency trees; only downloads are shared.
const preparations=new Map<string,Promise<unknown>>();
export async function prepareValidationEnvironment(options:{repo:Repo;job:Job;dataDir:string;signal:AbortSignal;observe:(state:EnvironmentPreparation)=>void;env?:NodeJS.ProcessEnv}):Promise<void>{
  options.signal.throwIfAborted();let started=false;
  const previous=preparations.get(options.repo.id)??Promise.resolve();
  const task=previous.catch(()=>{}).then(()=>{started=true;options.signal.throwIfAborted();return prepare(options);});
  preparations.set(options.repo.id,task);
  void task.finally(()=>{if(preparations.get(options.repo.id)===task)preparations.delete(options.repo.id);}).catch(()=>{});
  // A queued cancellation can return immediately. Once the installer starts,
  // its child group and log writes must settle before the workspace is released.
  await new Promise<void>((accept,reject)=>{
    const abort=()=>{if(!started)reject(options.signal.reason);};
    options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();
    void task.then(accept,reject).finally(()=>options.signal.removeEventListener('abort',abort));
  });
}

async function prepare({repo,job,dataDir,signal,observe,env:inherited=process.env}:Parameters<typeof prepareValidationEnvironment>[0]):Promise<void>{
  let state:EnvironmentPreparation={status:'checking',reason:'检查当前工作区运行时、锁文件及依赖',updatedAt:new Date().toISOString()};
  const update=(value:Partial<EnvironmentPreparation>)=>{state={...state,...value,updatedAt:new Date().toISOString()};observe(state);};
  update({});
  try{
    signal.throwIfAborted();
    if(!job.worktree||!/^[a-zA-Z0-9_-]{1,200}$/.test(job.id))throw new Error('环境准备缺少有效验证工作区标识');
    const cwd=await realpath(job.worktree),root=await realpath(join(dataDir,'worktrees'));
    if(relative(root,cwd).startsWith('..')||relative(root,cwd)===''||isAbsolute(relative(root,cwd))||cwd!==join(root,basename(job.worktree)))throw new Error('环境准备仅允许在受管理的独立工作区执行');
    const manifestPath=join(cwd,'package.json');
    if(!await exists(manifestPath)){update({status:'ready',reason:'该工作区无 Node 清单，不执行依赖安装；继续指定验证'});return;}
    if(!(await realpath(manifestPath)).startsWith(cwd+'/'))throw new Error('package.json 指向工作区外部');
    const policy=environmentPolicySchema.parse(repo.policy?.environment??{});
    if(policy.binDirectory&&!isAbsolute(policy.binDirectory))throw new Error('运行时工具目录必须是绝对路径');
    const env:NodeJS.ProcessEnv={};
    for(const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','NODE_OPTIONS','NODE_EXTRA_CA_CERTS'])if(inherited[key]!==undefined)env[key]=inherited[key];
    if(policy.binDirectory)env.PATH=[policy.binDirectory,env.PATH].filter(Boolean).join(delimiter);
    env.CI='true';env.npm_config_engine_strict='true';env.GIT_TERMINAL_PROMPT='0';
    // Version probes must not bootstrap a different package manager behind the policy.
    env.COREPACK_ENABLE_NETWORK='0';env.COREPACK_ENABLE_PROJECT_SPEC='0';
    env.npm_config_manage_package_manager_versions='false';
    if(!policy.allowNetwork)env.npm_config_offline='true';
    const run=(file:string,args:string[],timeout=10000,log?:(s:string)=>void)=>environmentProcess(file,args,cwd,env,signal,timeout,log);
    const manifestText=await readFile(manifestPath,'utf8'),pkg=JSON.parse(manifestText);
    const nodeVersion=await run('node',['--version']);update({nodeVersion});
    if(pkg.engines?.node&&(!semver.validRange(pkg.engines.node)||!semver.satisfies(nodeVersion,pkg.engines.node)))throw new Error(`Node ${nodeVersion} 不满足仓库要求 ${pkg.engines.node}；请配置兼容的工具目录，不会全局安装或切换`);
    const declaration=pkg.packageManager as string|undefined;
    if(declaration!==undefined&&typeof declaration!=='string')throw new Error('packageManager 必须声明支持的包管理器及版本');
    const declared=declaration?.match(/^(pnpm|npm)@(\d+\.\d+\.\d+)(?:\+[^\s]+)?$/);
    if(declaration&&!declared)throw new Error(`暂不支持自动准备 ${declaration}；请手动准备原工作区`);
    const pnpmLock=await exists(join(cwd,'pnpm-lock.yaml')),npmLock=await exists(join(cwd,'package-lock.json'));
    if(!declaration&&pnpmLock&&npmLock)throw new Error('存在多个锁文件且未声明包管理器，需要明确选择工具');
    const manager=declared?.[1]??(pnpmLock?'pnpm':npmLock?'npm':undefined);
    if(!manager)throw new Error('缺少支持的锁文件，不能进行冻结依赖安装');
    const lockPath=join(cwd,manager==='pnpm'?'pnpm-lock.yaml':'package-lock.json');
    if(!await exists(lockPath))throw new Error(`声明的 ${manager} 缺少对应锁文件`);
    for(const path of [lockPath,join(cwd,'pnpm-workspace.yaml'),join(cwd,'.npmrc')])if(await exists(path)&&!(await realpath(path)).startsWith(cwd+'/'))throw new Error('锁文件或安装配置指向工作区外部');
    const version=await run(manager,['--version']);update({packageManager:`${manager}@${version}`});
    if(declared&&version!==declared[2])throw new Error(`包管理器需要 ${manager}@${declared[2]}，当前为 ${version}；请配置兼容工具目录`);
    const checkpoint=async()=>JSON.stringify({head:await git(cwd,['rev-parse','HEAD']),patch:digest(await collectPatch(cwd,job.baseSha)),manifest:await readFile(manifestPath,'utf8'),lock:await readFile(lockPath,'utf8'),workspace:await readFile(join(cwd,'pnpm-workspace.yaml'),'utf8').catch(()=>''),config:await readFile(join(cwd,'.npmrc'),'utf8').catch(()=>'')});
    const before=await checkpoint();const original=JSON.parse(before);
    if(original.head!==job.baseSha||original.patch!==job.patchSha256)throw new Error('环境准备前代码版本或补丁已变化，请重新验证');
    const key=digest(before+JSON.stringify(policy)+nodeVersion+manager+version);update({key});
    const dependencies=Object.keys({...pkg.dependencies,...pkg.devDependencies});
    const ready=async()=>{
      if(!dependencies.length)return true;
      const modules=join(cwd,'node_modules');if(!await exists(modules))return false;
      if(!(await stat(modules)).isDirectory())throw new Error('node_modules 不是依赖目录');
      if(!((await realpath(modules)).startsWith(cwd+'/')))throw new Error('不允许复用工作区外的共享 node_modules');
      for(const name of dependencies){if(!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name))throw new Error('依赖名称无效');const path=join(modules,name);if(!await exists(join(path,'package.json')))return false;if(!(await realpath(path)).startsWith(cwd+'/'))throw new Error(`依赖 ${name} 指向工作区外部，不能作为独立环境`);}
      return true;
    };
    const receiptPath=join(dataDir,'environments','receipts',digest(cwd)+'.json');
    const receipt=await readFile(receiptPath,'utf8').then(text=>{try{return JSON.parse(text);}catch{return {status:'invalid'};}}).catch(()=>null);
    const observedReady=await ready();
    const authorized=job.environmentAuthorization?.caseId===job.caseId&&job.environmentAuthorization?.revision===job.revision&&job.environmentAuthorization?.policyKey===environmentPolicyKey(repo)&&job.environmentAuthorization.baseSha===job.baseSha&&job.environmentAuthorization.patchHash===job.patchSha256;
    if(!(observedReady&&(!receipt&&policy.scope==='root'||receipt?.status==='ready'&&receipt.key===key))){
      if(installationForbidden(job)&&!authorized)throw new Error('本事项明确禁止安装依赖；需由维护者授权本次环境准备，代码修改范围保持不变');
      if(policy.mode!=='automatic'&&!authorized)throw new Error('该工作区需要准备依赖；仓库尚未启用自动环境准备，可在仓库设置开启或授权本次准备');
      if(policy.allowScripts&&!policy.allowNetwork)throw new Error('离线自动准备仅支持禁用安装脚本；脚本可能自行联网，需明确开启联网权限或手动准备');
      if(manager==='pnpm'&&policy.scope==='root'&&(typeof pkg.name!=='string'||!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(pkg.name)))throw new Error('根项目没有有效 name，无法选择根项目依赖范围，请明确使用整个工作区');
      const cache=join(dataDir,'runtime',manager==='pnpm'?'pnpm-store':'npm-cache');await mkdir(cache,{recursive:true});
      const args=manager==='pnpm'
        ? [...(policy.scope==='root'?['--filter',pkg.name]:[]),'install','--frozen-lockfile','--ignore-pnpmfile','--store-dir',cache,'--child-concurrency=1','--network-concurrency=4',...(policy.allowScripts?[]:['--ignore-scripts']),...(policy.allowNetwork?[]:['--offline'])]
        : ['ci','--cache',cache,'--no-audit','--no-fund',...(policy.scope==='root'?['--workspaces=false']:[]),...(policy.allowScripts?[]:['--ignore-scripts']),...(policy.allowNetwork?[]:['--offline'])];
      const logPath=join(dataDir,'environments','logs',job.id+'.log');await mkdir(resolve(logPath,'..'),{recursive:true});
      update({status:'preparing',reason:'正在按锁文件准备本工作区依赖，成功后自动继续验证',command:[manager,...args].join(' '),logPath});
      await mkdir(resolve(receiptPath,'..'),{recursive:true});await writeFile(receiptPath,JSON.stringify({status:'preparing',key,worktree:cwd}),{mode:0o600});
      let log='';
      try{await run(manager,args,policy.timeoutMs,text=>{if(log.length<128000)log+=text.slice(0,128000-log.length);});}
      finally{await writeFile(logPath,log,{mode:0o600});if(await checkpoint()!==before)throw new Error('环境准备期间代码、锁文件或配置发生变化；工作区已保留，不能继续验证');}
      if(!await ready())throw new Error('安装结束但根项目依赖仍不完整，请查看准备日志；不会自动循环安装');
    }
    signal.throwIfAborted();if(await checkpoint()!==before)throw new Error('环境检查期间版本发生变化');
    await mkdir(resolve(receiptPath,'..'),{recursive:true});await writeFile(receiptPath,JSON.stringify({status:'ready',key,worktree:cwd,head:job.baseSha,patch:job.patchSha256,policyKey:environmentPolicyKey(repo),nodeVersion,packageManager:state.packageManager,scope:policy.scope,updatedAt:new Date().toISOString()}),{mode:0o600});
    update({status:'ready',reason:'本工作区环境已检查就绪；继续执行本次验证，准备记录不代表测试通过'});
  }catch(error){
    if(signal.aborted){update({status:'failed',reason:'环境准备已中断；保留日志和工作区'});throw signal.reason;}
    const reason=redact(error instanceof Error?error.message:String(error));update({status:state.status==='preparing'?'failed':'blocked',reason});throw new EnvironmentUnavailable(new Error(reason));
  }
}
