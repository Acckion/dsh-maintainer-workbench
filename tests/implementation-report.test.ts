import test from 'node:test';
import assert from 'node:assert/strict';
import { implementationReportEvidence } from '../src/core/implementation-report.ts';
import type { ExecutionRecord } from '../src/core/types.ts';
test('report evidence stays bounded and preserves process outcomes without repeating source bodies', () => {
 const records = Array.from({length:30}, (_,i)=>({id:`session:${i}`,callId:`call_${i}`,tool:i===29?'bash':'read',sourcePath:'README.md',command:i===29?'git diff --check':undefined,exitCode:i===29?0:null,isError:false,output:i===29?'CHECK_PASSED':'SOURCE'.repeat(10000)} as ExecutionRecord));
 const output = implementationReportEvidence(records,'docs');
 assert.ok(output.length < 5300);
 assert.ok(!output.includes('SOURCESOURCE'));
 const last = JSON.parse(output).records.at(-1);
 assert.equal(last.executionId,'session:29');assert.equal(last.exitCode,0);assert.equal(last.command,'git diff --check');
 assert.equal(records[0].output.length,60000);
});
