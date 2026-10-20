import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Context} from '@deepseek-ai/cordis';
import {GitHub} from '../src/core/github.ts';
import {harnessRunner} from '../src/plugin/native-runner.ts';
import {BudgetStopError} from '../src/core/budget-stop.ts';
import {git} from '../src/core/git.ts';
import {Store} from '../src/core/store.ts';
import {seedFixture} from './support/fixtures.ts';
import type {Job,ToolDiagnostics} from '../src/core/types.ts';
for(const kind of ['investigate','docs','review','fix','validate','ci'] as const)for(const malformed of [false,true])test(`native budget closure is bounded and never accepts success: ${kind}, malformed ${malformed}`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mw-native-budget-'));await git(dir,['init','-b','main']);await writeFile(join(dir,'README.md'),'# Document');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','base']);const sha=await git(dir,['rev-parse','HEAD']);
 const store=new Store(':memory:');seedFixture(store);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const repo=store.repos()[0];repo.profile!.sources=[{path:'unrelated',content:'UNRELATED_PROFILE'.repeat(1000)}];
 const issue={...store.issues()[0],origin:'repository' as const,...(kind==='investigate'?{organizeMode:'audit' as const}:{}),body:'Read-only repository audit. Scope: ["README.md"]'};
 const now=new Date().toISOString();const job={id:'limited',repoId:repo.id,issueId:issue.id,issueSnapshot:issue,kind,status:'running',baseSha:sha,revision:'r',attempt:1,createdAt:now,updatedAt:now,maintenanceScope:kind==='investigate'?['README.md']:undefined,worktree:dir} as Job;
 const listeners=new Map<string,any>(),guards:any[]=[];let reportTool:any,turns=0,seq=0,diagnostics:ToolDiagnostics|undefined;
 const emit=(type:string,data:any)=>listeners.get('session/event')?.({id:'maintainer-limited'},{type,data,seq:++seq});
 const ctx={agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},llm:{listProviders:()=>[{id:'p'}]},agentPresets:{resolve:async()=>({id:'standard'}),mount:async()=>{}},permissionPresets:{resolve:()=>{},set:()=>{}},workspaceRegistry:{create:async()=>({attachSession:async()=>{}})},on:(name:string,fn:any)=>{listeners.set(name,fn);return()=>listeners.delete(name);},agents:{create:async(options:any)=>{
  await options.setup({tools:{register:(tool:any)=>{if(tool.name==='submit_stage_report')reportTool=tool;},guard:(g:any)=>guards.push(g),restrict:()=>{},schemas:()=>[]}});
  return {dispose:async()=>{},agent:{session:{},cancel:()=>{},whenIdle:async()=>{},followup:(message:any)=>queueMicrotask(async()=>{
   try{
    if(++turns===1){
     if(kind==='investigate')assert.ok(!JSON.stringify(message).includes('UNRELATED_PROFILE'),'scoped audit excludes full profile content');
     for(let i=0;i<11;i++){
      const execution={name:'read',arguments:{file_path:'README.md',offset:i*20+1,limit:20}};const blocked=guards.map(g=>g(execution)).find(Boolean);
      const id=`c${i}`;emit('tool/call',{callId:id,name:'read',arguments:JSON.stringify(execution.arguments)});
      emit('tool/result',{message:{toolCallId:id,content:[{type:'text',text:blocked??'# Document'}],isError:!!blocked}});
     }
     emit('turn/end',{reason:{kind:'completed'}});
    }else{
     assert.ok(turns<=2,'only one explicit closing turn');
     assert.ok(guards.some(g=>g({name:'read',arguments:{file_path:'extra'}})),'closing phase prevents further browsing');
     assert.ok(guards.every(g=>!g({name:'submit_stage_report',arguments:{report:{}}})),'report submission remains allowed after budget exhaustion');
     let sent=0;
     const stream=()=>listeners.get('llm/stream')({sessionId:options.sessionId,messages:[],tools:[]},async function*(){sent++;yield {type:'finish',reason:{kind:'completed'}};});
     for(let i=0;i<2;i++)for await(const _ of stream()){}
     const blocked=[];for await(const chunk of stream())blocked.push(chunk);assert.equal(sent,2,'No third closing request reaches the model');assert.equal(blocked[0].reason.failure.code,'WORKBENCH_TOOL_LOOP');
     if(malformed)emit('assistant/message',{message:{content:[{type:'text',text:'not JSON'}]}});
     else await reportTool.execute({report:{reportFormat:'compact-v1',summary:'Partial observations',coverage:'README only',facts:['Read README'],evidence:[],maintenance:{complete:true,checkedPaths:['README.md','invented.md'],findings:[]},verdict:'no_findings'}},{signal:new AbortController().signal,concludeTurn:()=>{}});
     emit('turn/end',{reason:{kind:'completed'}});
    }
   }catch(error){emit('turn/end',{reason:{kind:'error',error:{message:String(error)}}});}
  })}};
 }}} as unknown as Context;
 await assert.rejects(harnessRunner(ctx,new GitHub('',async()=>{throw Error('Unexpected network in budget test');}))({repo,issue,related:[],job,settings:{...store.settings(),toolCallLimit:10},signal:new AbortController().signal,progress:()=>{},recordDiagnostics:d=>{diagnostics=d;}}),error=>{
  assert.ok(error instanceof BudgetStopError,String(error));assert.match(error.artifact.summary,/未完成/);
  if(error.artifact.stage==='investigate'){assert.equal(error.artifact.maintenance?.complete,false);assert.deepEqual(error.artifact.maintenance?.checkedPaths,['README.md']);}
  if(error.artifact.stage==='review')assert.equal(error.artifact.verdict,'incomplete');return true;
 });
 assert.equal(turns,2);assert.equal(diagnostics?.toolBudget?.used,10);assert.equal(diagnostics?.toolBudget?.reportRequests,2);assert.equal(diagnostics?.finished,true);assert.equal(listeners.size,0);
});
