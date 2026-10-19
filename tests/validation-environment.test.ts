import test from 'node:test';
import assert from 'node:assert/strict';
import { validationEnvironment } from '../src/core/validation-environment.ts';
import { artifactSchemas } from '../src/core/artifacts.ts';
import type { Job, ExecutionRecord } from '../src/core/types.ts';
const artifact = artifactSchemas.validate.parse({schemaVersion:1,stage:'validate',summary:'checks',coverage:'',evidence:[],nextSteps:[],responseDraft:'',environment:'',tests:[{command:'pnpm test',status:'not_run',output:'missing'}],blockers:[],gaps:[{id:'tests',kind:'system_check',status:'pending',summary:'未运行',blocks:['validate'],resolution:'运行测试',sources:[]}]});
const record = {id:'s:1',sessionId:'s',cwd:'/tmp/current',checkoutSha:'sha',patchHash:'patch',command:'pnpm test 2>&1 | head -40',exitCode:0,output:'Error: Repository dependencies are missing from /tmp/current/node_modules. Run pnpm install'} as ExecutionRecord;
const job = {kind:'validate',sessionId:'s',worktree:'/tmp/current',baseSha:'sha',patchSha256:'patch',executionRecords:[record]} as Job;
test('actual missing dependencies route unrun checks to environment without erasing system checks',()=>{
 const result=validationEnvironment(artifact,job)!;
 assert.equal(result.gaps?.[0].kind,'system_check');assert.equal(result.gaps?.[1].kind,'environment');
 assert.deepEqual(result.gaps?.[1].sources,['s:1']);
 assert.equal(validationEnvironment(result,job),result);
});
for(const field of ['sessionId','cwd','checkoutSha','patchHash','command','output'] as const) test(`does not infer environment from mismatched ${field}`,()=>{
 assert.equal(validationEnvironment(artifact,{...job,executionRecords:[{...record,[field]:'other'}]}),artifact);
});
test('failed assertions and model-only environment claims do not become dependency waits',()=>{
 const failed={...artifact,tests:artifact.tests.map(t=>({...t,status:'failed' as const}))};
 assert.equal(validationEnvironment(failed,job),failed);
 assert.equal(validationEnvironment(artifact,{...job,executionRecords:[]}),artifact);
});
