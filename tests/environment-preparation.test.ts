import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { git, collectPatch } from '../src/core/git.ts';
import { prepareValidationEnvironment, environmentPolicyKey } from '../src/execution/environment-preparation.ts';
import { environmentPolicySchema, type EnvironmentPreparation } from '../src/domain/environment.ts';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { artifactSchemas, asAnalysis } from '../src/core/artifacts.ts';
import { seedFixture } from './support/fixtures.ts';
import type { Repo, Job } from '../src/core/types.ts';
import { runtimeBashTool, runtimeShellTool } from '../src/plugin/environment-runtime.ts';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { execFileSync } from 'node:child_process';

const empty=createHash('sha256').update('').digest('hex');
async function fixture(t:TestContext,script=''){
 const dataDir=await mkdtemp(join(tmpdir(),'mw-environment-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const cwd=join(dataDir,'worktrees','current'),bin=join(dataDir,'bin'),count=join(dataDir,'installs.log');
 await mkdir(cwd,{recursive:true});await mkdir(bin);await symlink(process.execPath,join(bin,'node'));
 const packageText=JSON.stringify({name:'fixture-package',packageManager:'pnpm@12.5.1',engines:{node:'>=24'},dependencies:{'test-dep':'1.0.0'}});
 await writeFile(join(cwd,'package.json'),packageText);await writeFile(join(cwd,'pnpm-lock.yaml'),'lockfileVersion: 9\n');await writeFile(join(cwd,'.gitignore'),'node_modules\n');
 await git(cwd,['init','-b','main']);await git(cwd,['add','.']);await git(cwd,['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','fixture']);
 await git(cwd,['remote','add','origin','https://github.com/fixture/queue.git']);
 const baseSha=await git(cwd,['rev-parse','HEAD']);
 const tool=`#!/bin/sh\nif [ "$1" = "--version" ]; then echo 12.5.1; exit 0; fi\n[ -z "$GITHUB_TOKEN" ] || exit 23\nprintf '%s\\n' "$*" >> '${count}'\n${script}\nmkdir -p node_modules/test-dep\nprintf '{}' > node_modules/test-dep/package.json\n`;
 await writeFile(join(bin,'pnpm'),tool,{mode:0o755});
 const repo={id:'fixture/repo',policy:{environment:environmentPolicySchema.parse({mode:'automatic',binDirectory:bin})}} as unknown as Repo;
 const job={id:'current',kind:'validate',caseId:'case',revision:'revision',repoId:repo.id,baseSha,patchSha256:empty,worktree:cwd,issueSnapshot:{}} as Job;
 const states:EnvironmentPreparation[]=[];
 const run=(overrides:Partial<Parameters<typeof prepareValidationEnvironment>[0]>={})=>prepareValidationEnvironment({repo,job,dataDir,signal:new AbortController().signal,observe:s=>states.push(s),env:{...process.env,GITHUB_TOKEN:'not-for-installer'},...overrides});
 return {dataDir,cwd,bin,count,repo,job,states,run};
}

test('frozen preparation is automatic, private, repeatable, and invalidated by dependency or lock changes',async t=>{
 const f=await fixture(t);await Promise.all([f.run(),f.run()]);assert.equal(f.states.at(-1)?.status,'ready');
 const args=await readFile(f.count,'utf8');for(const flag of ['--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile','--offline','--filter fixture-package'])assert.ok(args.includes(flag),flag);
 assert.equal(await collectPatch(f.cwd,f.job.baseSha),'');await f.run();assert.equal(await readFile(f.count,'utf8'),args);
 await rm(join(f.cwd,'node_modules/test-dep'),{recursive:true});await f.run();assert.equal((await readFile(f.count,'utf8')).trim().split('\n').length,2);
 await writeFile(join(f.cwd,'pnpm-lock.yaml'),'lockfileVersion: 9\n# changed\n');
 f.job.patchSha256=createHash('sha256').update(await collectPatch(f.cwd,f.job.baseSha)).digest('hex');await f.run();
 assert.equal((await readFile(f.count,'utf8')).trim().split('\n').length,3);
});

test('network and lifecycle permissions are separate, and a changed policy invalidates preparation',async t=>{
 const f=await fixture(t);await f.run();
 f.repo.policy!.environment!.allowScripts=true;await assert.rejects(f.run(),/离线自动准备仅支持禁用安装脚本/);
 f.repo.policy!.environment!.allowNetwork=true;await f.run();
 const args=(await readFile(f.count,'utf8')).trim().split('\n').at(-1)!;
 assert.ok(!args.includes('--ignore-scripts'));assert.ok(!args.includes('--offline'));assert.ok(args.includes('--frozen-lockfile'));
});

test('npm uses a frozen ci recipe rather than pnpm or a global install',async t=>{
 const f=await fixture(t);const pkg=JSON.parse(await readFile(join(f.cwd,'package.json'),'utf8'));pkg.packageManager='npm@10.1.0';
 await writeFile(join(f.cwd,'package.json'),JSON.stringify(pkg));await rm(join(f.cwd,'pnpm-lock.yaml'));await writeFile(join(f.cwd,'package-lock.json'),'{}\n');
 await writeFile(join(f.bin,'npm'),(await readFile(join(f.bin,'pnpm'),'utf8')).replace('12.5.1','10.1.0'),{mode:0o755});
 f.job.patchSha256=createHash('sha256').update(await collectPatch(f.cwd,f.job.baseSha)).digest('hex');
 await f.run();assert.match(await readFile(f.count,'utf8'),/^ci .*--ignore-scripts.*--offline/);
 assert.equal(f.states.at(-1)?.packageManager,'npm@10.1.0');
});

test('a cancelled queued preparation does not wait for another workspace or start a second install',async t=>{
 const a=await fixture(t,'sleep 0.3'),b=await fixture(t),controller=new AbortController();
 const first=a.run(),queued=b.run({signal:controller.signal});const start=Date.now();controller.abort(new Error('queued cancellation'));
 await assert.rejects(queued,/queued cancellation/);assert.ok(Date.now()-start<250);await first;
 await assert.rejects(readFile(b.count,'utf8'),/ENOENT/);
});

test('the scoped bash adapter uses the prepared runtime without changing model arguments or host checks',async t=>{
 const f=await fixture(t);
 // Use an independent executable directory rather than altering the symlinked Node binary.
 const bin=join(f.dataDir,"runtime 'with spaces");await mkdir(bin);await writeFile(join(bin,'node'),'#!/bin/sh\necho prepared-node\n',{mode:0o755});
 const args=Object.freeze({command:'node --version',workdir:f.cwd,sandbox_permissions:'host-owned'});let forwarded:unknown;
 const original={name:'bash',execute:async(input:unknown)=>{forwarded=input;return execFileSync('/bin/bash',['-c',(input as typeof args).command],{encoding:'utf8'});}} as unknown as ToolDefinition;
 const wrapped=runtimeBashTool(original,bin,'/usr/bin:/bin');
 assert.equal(await wrapped.execute(args,{} as never),'prepared-node\n');assert.equal(args.command,'node --version');assert.equal((forwarded as typeof args).sandbox_permissions,'host-owned');
});

test('manual policy and explicit task restrictions need distinct current-version authorization',async t=>{
 const f=await fixture(t);f.repo.policy!.environment!.mode='manual';
 await assert.rejects(f.run(),/尚未启用自动环境准备/);assert.equal(f.states.at(-1)?.status,'blocked');
 f.repo.policy!.environment!.mode='automatic';f.job.instructions='本事项不安装依赖';
 await assert.rejects(f.run(),/明确禁止安装/);
 f.job.environmentAuthorization={caseId:'old',revision:f.job.revision,policyKey:environmentPolicyKey(f.repo),baseSha:f.job.baseSha,patchHash:f.job.patchSha256!};
 await assert.rejects(f.run(),/明确禁止安装/);
 f.job.environmentAuthorization={caseId:f.job.caseId!,revision:f.job.revision,policyKey:environmentPolicyKey(f.repo),baseSha:f.job.baseSha,patchHash:f.job.patchSha256!};
 await f.run();assert.equal(f.states.at(-1)?.status,'ready');
});

test('runtime, package manager, lockfiles, and physical workspace boundaries are checked before installation',async t=>{
 const f=await fixture(t);const path=join(f.cwd,'package.json'),original=await readFile(path,'utf8'),pkg=JSON.parse(original);
 await writeFile(path,JSON.stringify({...pkg,engines:{node:'>=999'}}));await assert.rejects(f.run(),/不满足仓库要求/);
 await writeFile(path,JSON.stringify({...pkg,packageManager:'pnpm@99.0.0'}));await assert.rejects(f.run(),/包管理器需要/);
 await writeFile(path,JSON.stringify({...pkg,packageManager:'yarn@4.0.0'}));await assert.rejects(f.run(),/暂不支持/);
 await writeFile(path,original);await rm(join(f.cwd,'pnpm-lock.yaml'));await assert.rejects(f.run(),/缺少对应锁文件/);
 const outside=join(f.dataDir,'outside');await mkdir(outside);await assert.rejects(f.run({job:{...f.job,worktree:outside}}),/受管理的独立工作区/);
 await writeFile(join(f.cwd,'pnpm-lock.yaml'),'lockfileVersion: 9\n');await symlink(outside,join(f.cwd,'node_modules'));await assert.rejects(f.run(),/工作区外/);
});

test('installation failure and code changes are retained as environment failures, never ready',async t=>{
 const f=await fixture(t,'echo build-failed; exit 7');await assert.rejects(f.run(),/环境命令失败/);assert.equal(f.states.at(-1)?.status,'failed');assert.match(await readFile(f.states.at(-1)!.logPath!,'utf8'),/build-failed/);
 const g=await fixture(t,'echo changed >> package.json');await assert.rejects(g.run(),/代码、锁文件或配置发生变化/);assert.notEqual(await collectPatch(g.cwd,g.job.baseSha),'');
});

test('cancelled partial installation does not produce a reusable ready receipt',async t=>{
 const f=await fixture(t,'mkdir -p node_modules/test-dep; echo "{}" > node_modules/test-dep/package.json; echo started; sleep 30');
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const start=Date.now();await assert.rejects(f.run({signal:controller.signal,observe:s=>{f.states.push(s);if(s.status==='preparing')timer=setTimeout(()=>controller.abort(new Error('test cancellation')),120);}}),/test cancellation/);
 if(timer)clearTimeout(timer);assert.ok(Date.now()-start<4000);assert.notEqual(f.states.at(-1)?.status,'ready');
 f.repo.policy!.environment!.mode='manual';await assert.rejects(f.run(),/尚未启用自动环境准备/);
});

test('active cancellation waits for child shutdown and saved logs before releasing its caller',async t=>{
 const f=await fixture(t,"trap 'sleep 0.2; echo child-finished; exit 0' TERM\necho child-started\nsleep 30"),controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>|undefined;
 await assert.rejects(f.run({signal:controller.signal,observe:s=>{f.states.push(s);if(s.status==='preparing')timer=setTimeout(()=>controller.abort(new Error('active cancellation')),150);}}),/active cancellation/);
 if(timer)clearTimeout(timer);
 assert.match(await readFile(f.states.at(-1)!.logPath!,'utf8'),/child-finished/);
 assert.equal(f.states.at(-1)?.status,'failed');
});

test('native workflow stops before model on missing dependencies, then authorized preparation continues validation',async t=>{
 const f=await fixture(t);const source=f.cwd;
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0];
 store.put('repos',{...repo,headSha:f.job.baseSha,localPath:source,policy:{...store.settings(),environment:environmentPolicySchema.parse({mode:'manual',binDirectory:f.bin})}});
 let calls=0;
 const wb=new Workbench(store,f.dataDir,async({job,progress,recordExecution})=>{
  calls++;assert.equal(job.environmentPreparation?.status,'ready');await readFile(join(job.worktree!,'node_modules/test-dep/package.json'),'utf8');
  progress('scope-test','s');recordExecution?.({id:'s:1',sessionId:'s',callId:'test',tool:'bash',command:'scope-test',cwd:job.worktree!,checkoutSha:job.baseSha,patchHash:empty,exitCode:0,isError:false,output:'PASS',recordedAt:'now',truncated:false},'PASS');
  const artifact=artifactSchemas.validate.parse({schemaVersion:1,stage:'validate',summary:'passed',coverage:'scope',environment:'prepared',tests:[{command:'scope-test',status:'passed',output:'PASS',executionId:'s:1'}],blockers:[],evidence:[],nextSteps:[],responseDraft:''});return {artifact,result:asAnalysis(artifact),engine:'fixture'};
 },new GitHub('',async()=>Response.json([])),false);t.after(()=>wb.close());
 wb.enqueue([store.issues()[0].id],'validate',{instructions:'本事项不安装依赖'});wb.pump();await wb.drain();
 const waiting=store.jobs().at(-1)!;assert.equal(waiting.status,'waiting_environment',waiting.error);assert.equal(calls,0);assert.equal(waiting.patchSha256,empty);
 const version=store.issues()[0].processing!.version;assert.throws(()=>wb.prepareEnvironment(waiting.id,version-1),/状态已变化/);
 wb.prepareEnvironment(waiting.id,version);wb.pump();await wb.drain();
 const checked=store.jobs().at(-1)!;assert.equal(checked.status,'completed',checked.error);assert.equal(checked.worktree,waiting.worktree);assert.equal(calls,1);assert.equal(checked.environmentPreparation?.status,'ready');
 const inherited=wb.enqueue([checked.issueId],'validate',{sourceJobId:checked.id,forceNew:true});
 assert.deepEqual(store.get<Job>('jobs',inherited.created[0])?.environmentAuthorization,checked.environmentAuthorization);
 store.put('jobs',{...store.get<Job>('jobs',inherited.created[0])!,status:'cancelled'});
 store.put('jobs',{...checked,environmentAuthorization:{...checked.environmentAuthorization!,patchHash:'different'}});
 const changed=wb.enqueue([checked.issueId],'validate',{sourceJobId:checked.id,forceNew:true});
 assert.equal(store.get<Job>('jobs',changed.created[0])?.environmentAuthorization,undefined,'changed patch cannot inherit installation authorization');
});


test('prepared runtime respects the resolved pwsh tool and preserves host arguments',async()=>{
 const args=Object.freeze({command:'node --version',workdir:'fixture',permission:'host-owned'});let forwarded:any;
 const shell={name:'pwsh',execute:async(input:unknown)=>{forwarded=input;return 'ok';}} as unknown as ToolDefinition;
 assert.equal(await runtimeShellTool(shell,"C:/tools'quoted",'existing-path').execute(args,{} as never),'ok');
 assert.ok(forwarded.command.startsWith("$env:PATH = 'C:/tools''quoted"));
 assert.ok(forwarded.command.endsWith('\nnode --version'));
 assert.equal(forwarded.permission,'host-owned');assert.equal(args.command,'node --version');
});
