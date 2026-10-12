import test from 'node:test';
import assert from 'node:assert/strict';
import {gapSchema,planGaps,blockingGaps} from '../src/domain/gaps.ts';
import {planningInputRequest,planInputKey,draftFromJob} from '../src/core/change-plan.ts';
import {planBlocker,issuePromptContext} from '../src/core/issue-flow.ts';
import {meaningfulAnswer,unansweredInputRequest,inputRequestSchema,type InputRequest} from '../src/domain/input.ts';
import {Store} from '../src/core/store.ts';
import {ProcessingService} from '../src/application/processing.ts';
import {seedFixture,fixtureAnalysis} from './support/fixtures.ts';
import {Workbench} from '../src/core/workbench.ts';
import {artifactSchemas,asAnalysis,parseArtifact} from '../src/core/artifacts.ts';
import type {IssuePlan,Job} from '../src/core/types.ts';
const gap={id:'file_check',kind:'system_check' as const,summary:'读取指定文件',status:'not_checked' as const,blocks:['investigate' as const],resolution:'系统读取指定范围',sources:[]};
const common={schemaVersion:1 as const,summary:'已整理已有资料',coverage:'只读检查',evidence:[],nextSteps:[],responseDraft:'请提供失败日志'};
const plan:IssuePlan={category:'bug',goal:'生成追问草稿',scope:'只读查阅，不修改文件、不实施修复',acceptanceCriteria:['区分事实和缺失资料'],reproduction:'尚未提供，无法复现',expected:'正常启动',actual:'偶尔失败',decision:'accepted'};
test('legacy gaps never imply human responsibility; phase gates distinguish future requirements',()=>{
 assert.equal(planGaps({missingInfo:['锚点未检查']})[0].kind,'unclassified');
 assert.equal(blockingGaps([gap],'fix').length,0);assert.equal(blockingGaps([gap],'investigate').length,1);
 assert.equal(gapSchema.safeParse({...gap,status:'resolved'}).success,false);
 assert.equal(gapSchema.safeParse({...gap,status:'resolved',sources:['session:42']}).success,true);
});
test('read-only/unknown reproduction cannot authorize fixes; all-stage confirmation and system inputs are removed',()=>{
 const s=new Store(':memory:');seedFixture(s);const i=s.issues()[0];
 assert.match(planBlocker({...i,plan},'fix')!,/只读/);
 assert.equal(planBlocker({...i,plan},'investigate'),undefined);
 assert.match(planBlocker({...i,plan:{...plan,scope:'只修改启动模块'}},'fix')!,/不能复现/);
 const a=artifactSchemas.fix.parse({...common,stage:'fix',gaps:[gap],changes:[],acceptanceCriteria:[],limitations:[],tests:[]});
 const req:InputRequest={reason:'问题',fields:[{id:'confirm',question:'确认实施？',purpose:'plan_confirmation'},{id:'check',gapId:gap.id,question:'文件是什么？',purpose:'information'},{id:'log',question:'失败日志？',purpose:'information',actor:'reporter'}]};
 assert.deepEqual(planningInputRequest(a,req)?.fields.map(f=>f.id),['log']);s.close();
});
test('partial answers and unknowns persist without releasing wait or changing accepted scope; optional answers do not block',()=>{
 const s=new Store(':memory:');seedFixture(s);const i=s.issues()[0];s.put('issues',{...i,plan});const p=new ProcessingService(s);
 const wait=p.requestInput(i.id,{reason:'等待报告者',fields:[{id:'version',question:'版本？',actor:'reporter',purpose:'information'},{id:'log',question:'日志？',actor:'reporter',purpose:'information'},{id:'extra',question:'附加资料？',actor:'reporter',required:false}]});
 let state=s.processing.current(i.id)!;p.submitInput(i.id,wait.id,{version:'v1'},state.version);
 state=s.processing.current(i.id)!;assert.equal(state.waits.at(-1)?.state,'open');assert.equal(state.waits.at(-1)?.answers?.version.value,'v1');
 p.submitInput(i.id,wait.id,{log:'未知'},state.version,{log:'unknown'});
 state=s.processing.current(i.id)!;assert.equal(state.waits.at(-1)?.state,'open');
 const context=issuePromptContext(s.issues()[0]) as {providedInputs:{answers:Record<string,{state:string}>}[]};assert.equal(context.providedInputs.at(-1)?.answers.log.state,'unknown');
 assert.throws(()=>p.submitInput(i.id,wait.id,{log:'error code 1'},state.version-1),/状态已变化/);
 p.submitInput(i.id,wait.id,{log:'error code 1'},state.version);
 state=s.processing.current(i.id)!;assert.equal(state.waits.at(-1)?.state,'satisfied');assert.deepEqual(s.issues()[0].plan,plan);assert.equal(s.jobs().length,0);
 assert.equal(meaningfulAnswer({value:'unknown',state:'provided'}),false);
 const request:InputRequest={reason:'重新提问',fields:[{id:'version',question:'版本？',actor:'reporter',purpose:'information'}]};
 assert.equal(unansweredInputRequest(request,state.waits),undefined);
 assert.equal(unansweredInputRequest({...request,fields:[{...request.fields[0],question:'新版本？'}]},state.waits)?.fields.length,1);
 s.close();
});
test('workflow confirmation routes read-only bug plans to investigation, never fix or dependency installation',async()=>{
 const s=new Store(':memory:');seedFixture(s);const w=new Workbench(s,'/tmp/mw-gaps-tests',async({issue,job})=>({result:fixtureAnalysis(issue,job.kind),engine:'fixture'}),undefined,false);
 const i=s.issues()[0],r=s.repos()[0];const draft={...plan,route:'fix' as const,sources:[],missingInfo:[],gaps:[],inputKey:planInputKey(i,r),generatedAt:''};s.put('issues',{...i,orchestration:{draft}});
 const created=w.orchestration.start(i.id,draft.inputKey,plan).created;
 assert.equal(s.get<Job>('jobs',created[0])?.kind,'investigate');assert.equal(s.issues()[0].plan?.scope,plan.scope);await w.close();
});
test('worker keeps unfinished system checks out of human forms and retains the report',async()=>{
 const s=new Store(':memory:');seedFixture(s);
 const a=artifactSchemas.triage.parse({...common,stage:'triage',gaps:[{...gap,blocks:['triage']}],category:'bug',priority:'P2',labels:[],module:'startup',impact:'unknown',missingInfo:[],duplicateOf:null,duplicateReason:'',route:'investigate',routeReason:'检查文件',inputRequest:{reason:'未读取',fields:[{id:'file',gapId:gap.id,question:'请读取文件',purpose:'information'}]}});
 const w=new Workbench(s,'/tmp/mw-gaps-worker-tests',async()=>({artifact:a,result:asAnalysis(a),engine:'fixture'}),undefined,true);
 w.enqueue([s.issues()[0].id],'triage');await w.drain();assert.equal(s.jobs()[0].status,'failed');assert.match(s.jobs()[0].error!,/系统检查/);assert.equal(s.jobs()[0].artifact?.gaps?.length,1);assert.equal(s.processing.current(s.issues()[0].id)?.waits.some(w=>w.type==='user_input'),false);await w.close();
});
for(const kind of ['environment','external_wait'] as const) test(`${kind} uses existing waits, never a human questionnaire or a successful implementation`,async()=>{
 const s=new Store(':memory:');seedFixture(s);
 const a=artifactSchemas.triage.parse({...common,stage:'triage',gaps:[{...gap,kind,status:'pending',blocks:['triage'],...(kind==='external_wait'?{waitFor:'ci_completion'}:{})}],category:'bug',priority:'P2',labels:[],module:'startup',impact:'unknown',missingInfo:[],duplicateOf:null,duplicateReason:'',route:'investigate',routeReason:'等待条件'});
 const w=new Workbench(s,'/tmp/mw-gaps-worker-tests',async()=>({artifact:a,result:asAnalysis(a),engine:'fixture'}),undefined,true);
 w.enqueue([s.issues()[0].id],'triage');await w.drain();
 const state=s.processing.current(s.issues()[0].id)!;
 assert.equal(state.waits.some(w=>w.type==='user_input'),false);
 assert.equal(state.waits.some(w=>w.type===(kind==='environment'?'environment_ready':'ci_completion') && w.state==='open'),true);
 if(kind==='external_wait')assert.ok(state.waits.find(w=>w.type==='ci_completion')?.targetHeadSha);
 assert.equal(s.jobs()[0].artifact?.gaps?.[0].kind,kind);await w.close();
});
test('Issue 1 response with empty unresolved criteria and hyphenated field IDs parses and retains typed draft blockers',()=>{
 const s=new Store(':memory:');seedFixture(s);const i=s.issues()[0],repo=s.repos()[0];
 const gaps=[{...gap,id:'g1',kind:'reporter_information' as const,status:'pending' as const,resolution:'',blocks:['investigate' as const]}, {...gap,id:'g2',kind:'reporter_information' as const,status:'pending' as const,resolution:''}, {...gap,id:'g3',resolution:''}];
 const raw={...common,stage:'triage',category:'bug',priority:'P2',labels:[],module:'startup',impact:'未知',missingInfo:[],duplicateOf:null,duplicateReason:'',route:'needs_info',routeReason:'等待报告者资料',gaps,
  inputRequest:{reason:'等待资料',fields:[{id:'env-and-command',gapId:'g1',question:'版本与命令？',actor:'reporter',purpose:'information'},{id:'error-and-repro',gapId:'g2',question:'日志与步骤？',actor:'reporter',purpose:'information'}]},
  planDraft:{...plan,route:'investigate',sources:[],missingInfo:['资料未提供']}};
 const a=parseArtifact('triage',raw);assert.deepEqual(a.gaps,gaps);assert.equal(a.inputRequest?.fields[0].id,'env-and-command');
 const draft=draftFromJob(i,repo,{id:'replay',kind:'triage',artifact:a} as Job);assert.deepEqual(draft.gaps,gaps);assert.equal(blockingGaps(draft.gaps!,'investigate').length,3);
 assert.equal(gapSchema.safeParse({...gaps[0],status:'resolved',sources:['source']}).success,false);
 assert.equal(gapSchema.safeParse({...gaps[0],resolution:undefined}).success,false);
 s.close();
});
test('hyphenated input IDs survive partial persistence; duplicate and unsafe IDs remain rejected',()=>{
 const request={reason:'补充资料',fields:[{id:'env-and-command',question:'版本？',actor:'reporter' as const},{id:'error-and-repro',question:'日志？',actor:'reporter' as const}]};
 assert.equal(inputRequestSchema.safeParse(request).success,true);
 for(const id of ['constructor','__proto__','bad field','bad/id'])assert.equal(inputRequestSchema.safeParse({...request,fields:[{id,question:'资料？'}]}).success,false);
 assert.equal(inputRequestSchema.safeParse({...request,fields:[request.fields[0],request.fields[0]]}).success,false);
 const s=new Store(':memory:');seedFixture(s);const i=s.issues()[0],p=new ProcessingService(s);const wait=p.requestInput(i.id,request);
 p.submitInput(i.id,wait.id,{'env-and-command':'v1'},s.processing.current(i.id)!.version);
 let state=s.processing.current(i.id)!;assert.equal(state.waits.at(-1)?.answers?.['env-and-command'].value,'v1');assert.equal(state.waits.at(-1)?.state,'open');
 p.submitInput(i.id,wait.id,{},state.version,{'error-and-repro':'unknown'});
 state=s.processing.current(i.id)!;assert.equal(state.waits.at(-1)?.answers?.['error-and-repro'].state,'unknown');assert.equal(state.waits.at(-1)?.state,'open');s.close();
});
test('waiting triage publishes its saved plan draft without satisfying human waits or authorizing execution',async()=>{
 const s=new Store(':memory:');seedFixture(s);const i=s.issues()[0];
 const artifact=artifactSchemas.triage.parse({...common,stage:'triage',category:'bug',priority:'P2',labels:[],module:'startup',impact:'未知',missingInfo:['缺少日志'],duplicateOf:null,duplicateReason:'',route:'needs_info',routeReason:'等待日志',
  gaps:[{...gap,kind:'reporter_information',status:'pending',resolution:'',blocks:['investigate']}],
  planDraft:{...plan,route:'investigate',sources:[],missingInfo:['日志未知']},
  inputRequest:{reason:'报告者资料未知',fields:[{id:'error-and-repro',gapId:gap.id,question:'日志与步骤？',actor:'reporter',purpose:'information'}]}});
 const wb=new Workbench(s,'/tmp/mw-gap-triage-tests',async()=>({artifact,result:asAnalysis(artifact),engine:'fixture'}),undefined,false);
 const id=wb.enqueue([i.id],'triage').created[0];wb.pump();await wb.drain();
 const current=s.issues()[0];assert.equal(s.get<Job>('jobs',id)?.status,'waiting_input');assert.equal(current.orchestration?.draft?.sourceJobId,id);
 assert.equal(current.orchestration?.draft?.gaps?.[0].kind,'reporter_information');assert.equal(current.processing?.waits.find(w=>w.requestedByRunId===id)?.state,'open');
 assert.equal(current.plan,undefined);assert.equal(current.orchestration?.run,undefined);assert.equal(s.jobs().length,1);await wb.close();
});
