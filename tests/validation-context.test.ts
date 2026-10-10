import test from 'node:test';
import assert from 'node:assert/strict';
import { validationPromptHandoff, nativeValidationGuidance, validationTools, validationCommandBlocker, validationInstructions } from '../src/core/validation-context.ts';
import { artifactPrompt, artifactSchemas } from '../src/core/artifacts.ts';
import { reconcileTestExecutions } from '../src/core/execution-links.ts';
import type { Job, ExecutionRecord } from '../src/core/types.ts';

test('validation projects only supplied patch hints without historical review evidence or blockers', () => {
 const fix=artifactSchemas.fix.parse({schemaVersion:1,stage:'fix',summary:'fix',coverage:'old proof',evidence:[],nextSteps:[],responseDraft:'committed',changes:['bound'],acceptanceCriteria:['chunks'],limitations:['old blocker'],tests:[{command:'node probe',status:'passed',output:'old output',executionId:'call_old'}]});
 const handoff=[{id:'old-review',kind:'review' as const,revision:'sha',result:{summary:'F1 historical verdict'}},{id:'fix',kind:'fix' as const,revision:'sha',artifact:fix}] as Job['handoff'];
 const text=JSON.stringify(validationPromptHandoff({sourceJobId:'fix',handoff}));
 assert.match(text,/node probe|historical_unverified/);assert.doesNotMatch(text,/call_old|old blocker|F1|old proof|committed|old output|"status"/);
 assert.doesNotMatch(artifactPrompt('validate'),/finding\.sourceEvidence|verdict incomplete|historical review finding/);
 assert.match(nativeValidationGuidance('current'),/patch already applied|Actually execute|not_run/);
});

for(const mismatch of ['none','session','patch','cwd','version','unknownExit','duplicate','error'] as const) test(`native validation claims require current process evidence: ${mismatch}`,()=>{
 const record={id:'current:1',callId:'call_current',sessionId:'current',tool:'bash',command:'node probe',cwd:'/tmp/validation-current',checkoutSha:'sha',patchHash:'patch',exitCode:0,isError:false,output:'PASS',recordedAt:'now',truncated:false} as ExecutionRecord;
 if(mismatch==='session')record.sessionId='old';if(mismatch==='patch')record.patchHash='old';if(mismatch==='cwd')record.cwd='/tmp/other';if(mismatch==='version')record.checkoutSha='old';if(mismatch==='unknownExit')record.exitCode=null;if(mismatch==='error')record.isError=true;
 const job={kind:'validate',sessionId:'current',worktree:'/tmp/validation-current',baseSha:'sha',patchSha256:'patch',executionRecords:[record,...(mismatch==='duplicate'?[{...record,id:'current:2',callId:'second'}]:[])]} as Job;
 const artifact=artifactSchemas.validate.parse({schemaVersion:1,stage:'validate',summary:'checks',coverage:'probe',evidence:[],nextSteps:[],responseDraft:'',environment:'Node',tests:[{command:'node probe',status:'passed',output:'PASS'}],blockers:[]});
 const result=reconcileTestExecutions(artifact,job);assert.equal(result.stage,'validate');if(result.stage!=='validate')return;
 assert.equal(result.tests[0].status,mismatch==='none'?'passed':mismatch==='error'?'failed':'not_run');
 if(!['none','error'].includes(mismatch))assert.ok(result.blockers.length);
});

test('validation exposes local checks and rejects tool installation without widening host permissions',()=>{
 assert.ok(validationTools.includes('bash'));assert.ok(validationTools.includes('pwsh'));assert.ok(validationTools.includes('read'));
 for(const name of ['skill','edit','write','subagent','workflow'])assert.ok(!validationTools.includes(name));
 for(const shell of ['bash','pwsh']) {
  for(const command of ['brew install gh','/opt/homebrew/bin/brew install gh','npm install','pnpm add vitest','pip3 install requests','npx vitest'])assert.ok(validationCommandBlocker(shell,{command}),command);
  for(const command of ['node --input-type=module -e "1+1"','pnpm test src/utils/chunk-items.test.ts','git diff --cached','npx --no-install vitest'])assert.equal(validationCommandBlocker(shell,{command}),undefined,command);
 }
});

test('unexecuted validation cannot present an invented read-only environment as host fact',()=>{
 const artifact=artifactSchemas.validate.parse({schemaVersion:1,stage:'validate',summary:'read only',coverage:'sandbox denies',environment:'read only',evidence:[{source:'system',detail:'denied'}],nextSteps:['escalate'],responseDraft:'change permissions',tests:[],blockers:['read only']});
 const job={kind:'validate',sessionId:'current',worktree:'/tmp/current',baseSha:'sha',patchSha256:'patch',executionRecords:[],toolDiagnostics:{permission:'workspace-write'}} as unknown as Job;
 const result=reconcileTestExecutions(artifact,job);if(result.stage!=='validate')throw Error('stage');
 assert.match(result.environment,/workspace-write/);assert.match(result.blockers[0],/尚未获工具证实/);assert.match(result.blockers[1],/模型未证实/);assert.doesNotMatch(result.responseDraft,/change permissions/);
});

test('document validation uses a real check scope by default and preserves explicit maintainer scope', () => {
 assert.match(validationInstructions('', 'docs')!, /git diff --check/);
 assert.match(validationInstructions(undefined, 'docs')!, /锚点/);
 assert.equal(validationInstructions('custom scope', 'docs'), 'custom scope');
 assert.equal(validationInstructions('', 'fix'), '');
});
