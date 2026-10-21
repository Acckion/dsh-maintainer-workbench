import test from 'node:test';
import assert from 'node:assert/strict';
import { executionOutcome } from '../src/core/execution-outcome.ts';
import { reconcileTestExecutions } from '../src/core/execution-links.ts';
import { assembleReport } from '../src/core/report-assembly.ts';
import { artifactSchemas } from '../src/core/artifacts.ts';
import type { ExecutionRecord, Job } from '../src/core/types.ts';
import { execFileSync } from 'node:child_process';

const base = {id:'s:1',sessionId:'s',tool:'bash',cwd:'/owned',checkoutSha:'sha',patchHash:'patch',exitCode:0,isError:false,truncated:false,recordedAt:'now'};
for (const [command, output, expected] of [
  ['pnpm build 2>&1 | tail -25; echo "EXIT=${PIPESTATUS[0]}"', 'failure\nEXIT=1\n', 'failed'],
  ['pnpm build 2>&1 | tail -25; echo "EXIT:${PIPESTATUS[0]}"', 'failure\nEXIT:1\n', 'failed'],
  ['pnpm test | tail -25; echo "PIPESTATUS0=${PIPESTATUS[0]}"', 'failure\nPIPESTATUS0=1\n', 'failed'],
  ['pnpm test | tail -40; echo "[exit ${PIPESTATUS[0]}]"', '[exit 127]\n', 'failed'],
  ['pnpm test | tail -40; echo "EXIT=${PIPESTATUS[0]}"', 'PASS\nEXIT=0\n', 'passed'],
  ['pnpm test | tail -40; echo "EXIT=${PIPESTATUS[0]}"', 'PASS', 'not_run'],
  ['pnpm test | tail -40; pwd; echo "EXIT=${PIPESTATUS[0]}"', 'EXIT=0', 'not_run'],
  ['set -o pipefail\npnpm test | tail -40\nstatus=${PIPESTATUS[0]}\necho "status=$status"\nexit $status', 'PASS\nstatus=0', 'passed'],
  ['pnpm test | tail -40', 'PASS', 'not_run'],
  ['pnpm build; echo "EXIT=$?"', 'EXIT=1', 'failed'],
  ['cd /worktree && pnpm test; echo "EXIT_CODE=$?"', 'PASS\nEXIT_CODE=0', 'passed'],
  ['pnpm test; echo "EXIT_STATUS=$?"', 'FAIL\nEXIT_STATUS=1', 'failed'],
  ['pnpm test; echo "EXIT_CODE=$?"', 'EXIT=0', 'not_run'],
  ['pnpm build; echo done', 'done', 'not_run'],
  ['set -o pipefail; pnpm test | tail -40', 'PASS', 'passed'],
  ['set -o pipefail; pnpm test | tail -40; echo done', 'done', 'not_run'],
  ['cat source.ts', 'EXIT=1\n', 'passed'],
  ['node -e "console.log(1 | 2)"', '3', 'passed'],
] as const) test(`check process outcome: ${command} / ${expected}`, () => {
  const record = {...base,command,output} as ExecutionRecord;
  assert.equal(executionOutcome(record), expected);
  const job = {kind:'validate',sessionId:'s',worktree:'/owned',baseSha:'sha',patchSha256:'patch',executionRecords:[record]} as Job;
  const artifact = artifactSchemas.validate.parse({schemaVersion:1,stage:'validate',summary:'check',coverage:'check',environment:'owned',evidence:[],nextSteps:[],responseDraft:'',tests:[{command,status:'passed',output:'claim',executionId:record.id}],blockers:[]});
  const reconciled = reconcileTestExecutions(artifact,job);
  assert.equal('tests' in reconciled && reconciled.tests[0].status,expected);
  const compact = assembleReport('validate',{reportFormat:'compact-v1',summary:'check',coverage:'check',environment:'owned',tests:[{executionId:record.id,status:'passed'}],blockers:[]},job);
  assert.equal('tests' in compact && compact.tests[0].status,expected);
});

test('truncated pipeline status output cannot certify all checks passed',()=>{
 assert.equal(executionOutcome({...base,command:'pnpm test | tail; echo "EXIT=${PIPESTATUS[0]}"',output:'EXIT=0',truncated:true} as ExecutionRecord),'not_run');
});

test('real shell success cannot conceal the check failure before tail and echo',()=>{
 const command = 'sh -c "exit 7" | tail -10; echo "EXIT=${PIPESTATUS[0]}"';
 const output = execFileSync('/bin/bash',['-c',command],{encoding:'utf8'});
 assert.match(output,/EXIT=7/);
 assert.equal(executionOutcome({...base,command,output} as ExecutionRecord),'failed');
});
