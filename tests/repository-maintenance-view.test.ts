import test from 'node:test';
import assert from 'node:assert/strict';
import type {Job} from '../src/core/types.ts';
import type {MaintenanceScan,MaintenanceSnapshot} from '../src/domain/maintenance.ts';
import {scanMatchesView,scopedScans,checkStatus,maintenanceJobMatches,documentRole,inventoryIsOutdated,inventoryReadMessage} from '../src/client/repository-maintenance-view.ts';
const scan=(id:string,scope:string[],extra:Partial<MaintenanceScan>={}):MaintenanceScan=>({id,jobId:id,repoId:'r',revision:'head',scope,fingerprint:'',inventoryFiles:{},createdAt:'2026-10-20T01:00:00Z',state:'completed',complete:true,checkedPaths:scope,...extra});
const data:MaintenanceSnapshot={findings:[],scans:[],inventory:{repoId:'r',revision:'head',fingerprint:'',files:{'README.md':'a','docs/guide.md':'b','AGENTS.md':'c'},assets:[{path:'README.md',domain:'docs',oid:'a',role:'README'},{path:'docs/guide.md',domain:'docs',oid:'b',role:'Guide'},{path:'AGENTS.md',domain:'agents',oid:'c',role:'Agent'}],complete:true,dirty:false,source:'commit',warnings:[],scannedAt:''}};
const view={domain:'docs',selection:'README.md',prId:''};
test('only requested scopes belong to a file: dependency reads and similarly prefixed directories do not',()=>{
 assert.equal(scanMatchesView(scan('other',['docs'],{checkedPaths:['README.md']}),data,view),false);
 assert.equal(scanMatchesView(scan('all',[]),data,view),true);
 assert.equal(scanMatchesView(scan('parent',['docs']),data,{...view,selection:'docs/guide.md'}),true);
 assert.equal(scanMatchesView(scan('prefix',['doc']),data,{...view,selection:'docs/guide.md'}),false);
 assert.equal(scanMatchesView(scan('pr',['README.md'],{pr:{issueId:'p',headSha:'h',baseSha:'b',number:1}}),data,view),false);
});
test('a later failed check takes precedence over an earlier pass for the same file',()=>{
 const failed=scan('failed',['README.md'],{createdAt:'2026-10-20T02:00:00Z',state:'failed',complete:false,checkedPaths:[],summary:'版本变化'});
 const latest=scopedScans({...data,scans:[scan('pass',['README.md']),failed,scan('other',['docs'])]},view)[0];
 assert.equal(latest.id,'failed');assert.equal(checkStatus(latest,undefined,true,['README.md']).label,'检查失败');
});
test('no findings does not imply checked, complete, or current',()=>{
 assert.equal(checkStatus(undefined,undefined,false,['README.md']).label,'尚未检查');
 assert.equal(checkStatus(scan('partial',['README.md'],{state:'partial'}),undefined,true,['README.md']).label,'检查未完成');
 assert.equal(checkStatus(scan('one',['README.md']),undefined,true,['README.md','docs/guide.md']).label,'检查未完成');
 assert.equal(checkStatus(scan('old',['README.md']),undefined,false,['README.md']).label,'当前版本尚未检查');
 assert.equal(checkStatus(scan('good',['README.md']),undefined,true,['README.md']).label,'检查已完成');
});
test('pending checks show actionable waiting states',()=>{
 const pending=scan('queued',['README.md'],{state:'pending',complete:false,checkedPaths:[]});
 assert.equal(checkStatus(pending,{status:'queued'} as Job,true,['README.md']).label,'等待检查');
 assert.equal(checkStatus(pending,{status:'waiting_input',waitingReason:'需要范围'} as Job,true,['README.md']).detail,'需要范围');
});
test('file history excludes unrelated repository and PR tasks, but includes confirmed changes within parent paths',()=>{
 const job={id:'audit',issueId:'i',issueSnapshot:{origin:'repository',organizeMode:'audit'}} as Job;
 assert.equal(maintenanceJobMatches(job,{...data,scans:[scan('audit',['docs'])]},view),false);
 const change={id:'change',issueId:'i',issueSnapshot:{origin:'repository',organizeMode:'docs',orchestration:{run:{plan:{scope:'仅修改：docs'}}}}} as Job;
 assert.equal(maintenanceJobMatches(change,data,view),false);
 assert.equal(maintenanceJobMatches(change,data,{...view,selection:'docs/guide.md'}),true);
 assert.equal(maintenanceJobMatches({...job,issueId:'pr'},data,{...view,prId:'another'}),false);
});
test('only current, complete repository checks can provide a verified document role',()=>{
 const doc={path:'README.md',oid:'a',role:'真实职责',audience:'读者',authority:'current' as const,relatedPaths:[],current:true};
 assert.equal(documentRole({...data,scans:[scan('partial',['README.md'],{state:'partial',documents:[doc]})]},'README.md'),undefined);
 assert.equal(documentRole({...data,scans:[scan('old',['README.md'],{documents:[{...doc,current:false}]})]},'README.md'),undefined);
 assert.equal(documentRole({...data,scans:[scan('good',['README.md'],{documents:[doc]})]},'README.md')?.role,'真实职责');
});

test('outdated failures and partial reports are historical context, never current failures',()=>{
 for(const state of ['failed','partial','cancelled','completed'] as const){
  const status=checkStatus(scan('old',[],{revision:'old',state,complete:false,summary:'排队期间输入版本已变化，请重新派发'}),undefined,false,['.github/workflows/ci.yml']);
  assert.equal(status.label,'当前版本尚未检查');assert.equal(status.tone,'neutral');
 }
 assert.equal(checkStatus(scan('old-pending',[],{state:'pending'}),{status:'running'} as Job,false,[]).label,'正在检查旧版本');
});
test('a version-invalidated queued attempt is distinguished from an executed failure',()=>{
 const value=checkStatus(scan('expired',[],{state:'failed',summary:'排队期间输入版本已变化，请重新派发'}),undefined,true,[]);
 assert.equal(value.label,'检查未开始');assert.equal(value.tone,'neutral');
 assert.equal(checkStatus(scan('real-error',[],{state:'failed',summary:'读取命令执行失败'}),undefined,true,[]).label,'检查失败');
});
test('a complete inventory is still an old snapshot when the synchronized head advances',()=>{
 assert.equal(inventoryIsOutdated(data.inventory,'new-head'),true);
 assert.equal(inventoryIsOutdated(data.inventory,'head'),false);
 assert.equal(inventoryIsOutdated(undefined,'head'),false);
 assert.equal(inventoryIsOutdated({...data.inventory!,source:'folder'},'head'),false);
 assert.match(inventoryReadMessage('本地无法读取目标提交，GitHub 同版本文件清单也未读取成功：无法连接 GitHub：连接中断'),/网络与代理/);
 assert.doesNotMatch(inventoryReadMessage('fetch failed'),/令牌|权限/);
 assert.match(inventoryReadMessage('HTTP 403 权限不足'),/读取权限/);
});
