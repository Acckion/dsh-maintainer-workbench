import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactSchemas } from '../src/core/artifacts.ts';
import { documentAcceptance,documentCheckCommand,needsDocumentCheckExecution } from '../src/core/document-acceptance.ts';
import type { Job,ExecutionRecord } from '../src/core/types.ts';
const artifact=()=>artifactSchemas.validate.parse({schemaVersion:1,stage:'validate',summary:'all passed',coverage:'all links valid',evidence:[],nextSteps:[],responseDraft:'all passed',environment:'native',tests:[],blockers:[]});
const job={kind:'validate',sourceJobId:'docs',handoff:[{id:'docs',kind:'docs'}],worktree:'/tmp/doc-worktree',sessionId:'session',baseSha:'a'.repeat(40),patchSha256:'patch',executionRecords:[]} as unknown as Job;
test('document completeness blocks diff-only reports and mismatched sessions',()=>{
 const output=documentAcceptance(artifact(),job);assert.equal(output.stage,'validate');if(output.stage!=='validate')return;assert.equal(output.tests[0].status,'not_run');assert.equal(output.blockers.length,4);assert.doesNotMatch(output.responseDraft,/all passed/);
 const record={id:'session:1',sessionId:'other',cwd:job.worktree,checkoutSha:job.baseSha,patchHash:'patch',command:documentCheckCommand(job),exitCode:0,isError:false,output:'DOCUMENT_CHECKS_JSON={"checks":{"whitespace":true,"link_files":true,"link_anchors":true,"exact_repetition":true}}'} as ExecutionRecord;
 const wrong=documentAcceptance(artifact(),{...job,executionRecords:[record]});if(wrong.stage==='validate')assert.equal(wrong.tests[0].status,'not_run');
 const passed=documentAcceptance(artifact(),{...job,executionRecords:[{...record,sessionId:'session'}]});if(passed.stage==='validate'){assert.equal(passed.tests[0].status,'passed');assert.equal(passed.blockers.length,0);assert.match(passed.coverage,/语义重复需人工/);}
});

test('diff success cannot suppress mandatory checker repair; failed checker is not repeated',()=>{
 const diff={command:'git diff --check',exitCode:0,isError:false} as ExecutionRecord;
 assert.equal(needsDocumentCheckExecution(job,[diff]),true);
 assert.equal(needsDocumentCheckExecution(job,[diff,{...diff,command:documentCheckCommand(job),exitCode:1,isError:true}]),false);
});
