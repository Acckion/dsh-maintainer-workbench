import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {git} from '../src/core/git.ts';
import {Store} from '../src/core/store.ts';
import {Workbench} from '../src/core/workbench.ts';
import {seedFixture} from './support/fixtures.ts';
import {recoverSavedReviewArtifact} from '../src/core/saved-review-recovery.ts';
import {reviewEvidenceGate} from '../src/core/review-evidence.ts';
import {executionReference} from '../src/core/execution-reference.ts';
import {parseReport} from '../src/core/report-finalizer.ts';
import {reportRecoveryPrompt} from '../src/core/report-finalizer.ts';
import type {Job,ExecutionRecord} from '../src/core/types.ts';
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'saved-review-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await git(root,['init']);await git(root,['config','user.email','test@example.invalid']);await git(root,['config','user.name','Test']);
 await writeFile(join(root,'code.ts'),'export const stock = 6;\n');await git(root,['add','.']);await git(root,['commit','-m','baseline']);
 const base=await git(root,['rev-parse','HEAD']);const patch=createHash('sha256').update('').digest('hex');
 const context={sessionId:'session',baseSha:base,patchSha256:patch,worktree:root};
 const records:ExecutionRecord[]=[{id:'session:27',callId:'read-call',tool:'read',sourcePath:join(root,'code.ts'),cwd:root,sessionId:'session',checkoutSha:base,patchHash:patch,exitCode:null,isError:false,recordedAt:'2026-10-28T00:00:00Z',output:'1: export const stock = 6;',truncated:false},{id:'session:50',callId:'bash-call',tool:'bash',cwd:root,sessionId:'session',checkoutSha:base,patchHash:patch,exitCode:0,isError:false,recordedAt:'2026-10-28T00:00:01Z',command:"node -e 'console.log(6)'",output:'6\n',truncated:false}];
 const source={executionId:'27',path:'code.ts',line:99,quote:'export const stock = 6;'};
 const raw={reportFormat:'compact-v1',summary:'重复扣库存',coverage:'code',inspectedSources:[source],findings:[{id:'F1',title:'重复处理',severity:'P1',path:'code.ts',line:99,trigger:'重复通知',evidence:'6',recommendation:'幂等',sourceEvidence:source,reproduction:{input:'replay',expected:'8',actual:'6',basis:'executed',executionId:'50',command:"node -e '...'",outputQuote:'6'}}],verdict:'changes_requested',blockers:[]};
 const job={...context,kind:'review',status:'awaiting_review',rawOutput:JSON.stringify(raw),executionRecords:records,reviewRequiredSources:['code.ts'],toolDiagnostics:{sessionId:'session',mountedTools:['read','bash'],requests:[{tools:['read','bash']}],calls:2,results:2,canonicalResults:2,finished:true}} as unknown as Job;
 return {root,job,raw,records};
}
test('saved review repairs exact sequence IDs, uniquely evidenced line numbers and abbreviated command without execution',async t=>{
 const {job}=await fixture(t);const before=JSON.stringify(job);const artifact=recoverSavedReviewArtifact(job);
 assert.equal(artifact.stage,'review');if(artifact.stage!=='review')return;
 assert.equal(artifact.inspectedSources?.[0].executionId,'session:27');assert.equal(artifact.inspectedSources?.[0].line,1);
 assert.equal(artifact.findings[0].line,1);assert.equal(artifact.findings[0].reproduction?.command,"node -e 'console.log(6)'");
 assert.equal(artifact.findings[0].evidence,'6');assert.equal(JSON.stringify(job),before);
 assert.deepEqual(await reviewEvidenceGate(job,artifact),{allowed:true,reasons:[]});
});
test('recovery rejects foreign sessions, checkout/patch changes, ambiguous sources, conflicting commands and fake output',async t=>{
 const {job,raw,records,root}=await fixture(t);
 for(const change of [{sessionId:'foreign'},{checkoutSha:'other'},{patchHash:'other'},{cwd:join(root,'missing')},{isError:true}])assert.throws(()=>recoverSavedReviewArtifact({...job,executionRecords:[{...records[0],...change},records[1]]}));
 assert.throws(()=>recoverSavedReviewArtifact({...job,executionRecords:[{...records[0],output:'1: export const stock = 6;\n2: export const stock = 6;'},records[1]]}),/唯一定位/);
 for(const reproduction of [{...raw.findings[0].reproduction,command:'echo wrong'},{...raw.findings[0].reproduction,outputQuote:'invented'}])assert.throws(()=>recoverSavedReviewArtifact({...job,rawOutput:JSON.stringify({...raw,findings:[{...raw.findings[0],reproduction}]})}));
 assert.equal(executionReference([...records,records[0]],'27','session'),undefined);
 assert.equal(executionReference(records,'read-core','session'),undefined);
 assert.equal(executionReference(records,'27','other'),undefined);
});
test('compact submissions canonicalize real sequence IDs and reject shortened process commands',async t=>{
 const {job,raw}=await fixture(t);const source={...raw.inspectedSources[0],line:1};
 const good={...raw,inspectedSources:[source],findings:[{...raw.findings[0],line:1,sourceEvidence:source,reproduction:{...raw.findings[0].reproduction,command:"node -e 'console.log(6)'"}}]};
 const artifact=parseReport('review',JSON.stringify(good),()=>{},job);
 assert.equal(artifact.stage==='review'&&artifact.findings[0].sourceEvidence?.executionId,'session:27');
 assert.throws(()=>parseReport('review',JSON.stringify({...good,findings:[{...good.findings[0],reproduction:raw.findings[0].reproduction}]}),()=>{},job),/复现命令/);
 const prompt=reportRecoveryPrompt('review',job.rawOutput!,'schema',undefined,job);assert.match(prompt,/session:50/);assert.ok(prompt.includes("node -e 'console.log(6)'"));
});
test('workbench recovery creates a new unapproved attempt and preserves original report, with zero runner calls',async t=>{
 const {job:bound,root}=await fixture(t);const store=new Store(':memory:');seedFixture(store);let calls=0;
 const wb=new Workbench(store,root,async()=>{calls++;throw Error('must never run')},undefined,false);t.after(()=>wb.close());
 const issue=store.issues()[0];store.put('issues',{...issue,type:'pr'});
 const id=wb.enqueue([issue.id],'review').created[0];const original={...store.get<Job>('jobs',id)!,...bound,id,caseId:store.get<any>('issues',issue.id).processing.id,evidenceGate:{allowed:false,reasons:['引用失败']}} as Job;
 store.put('jobs',original);const snapshot=JSON.stringify(store.get<Job>('jobs',id));
 const result=await wb.recoverReport(id);const restored=store.get<Job>('jobs',result.created[0])!;
 assert.equal(restored.status,'awaiting_review');assert.equal(restored.formatSourceJobId,id);assert.equal(restored.evidenceGate?.allowed,true);assert.equal(restored.sessionId,original.sessionId);assert.deepEqual(restored.executionRecords,original.executionRecords);assert.equal(restored.publications,undefined);
 assert.equal(JSON.stringify(store.get<Job>('jobs',id)),snapshot);assert.equal(calls,0);
 assert.deepEqual(await wb.recoverReport(id),{created:[],reused:[restored.id]});
 await writeFile(join(root,'code.ts'),'changed\n');await assert.rejects(wb.recoverReport(restored.id));assert.equal(calls,0);
});
