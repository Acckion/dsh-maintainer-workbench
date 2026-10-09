import test from 'node:test';
import assert from 'node:assert/strict';
import { requestBudget, documentTools, documentReadBlocker, budgetBlockedStream } from '../src/core/context-budget.ts';
test('request budget accounts for system, schemas and all message roles without storing text', () => {
  const messages = [{role:'system', content:'secret instructions'}, {role:'tool', content:'x'.repeat(40000)}];
  const budget = requestBudget(messages, [{name:'read', description:'read file'}], 'host rules');
  assert.ok(budget.estimatedInputTokens > 20000);
  assert.equal(budget.roles.length, 2);
  assert.equal(budget.roles[1].role, 'tool');
  assert.ok(!JSON.stringify(budget).includes('secret instructions'));
  assert.ok(requestBudget(messages, [{description:'x'.repeat(1000)}]).estimatedInputTokens > requestBudget(messages, []).estimatedInputTokens);
  assert.ok(documentTools.includes('edit') && documentTools.includes('bash'));
  assert.ok(!documentTools.includes('skill') && !documentTools.includes('subagent_fork'));
});

test('document reads require bounded segments without rewriting source output', () => {
 assert.ok(documentReadBlocker('read', {filePath:'README.md'}));
 assert.ok(documentReadBlocker('read', {limit:2000}));
 assert.equal(documentReadBlocker('read', {offset:150,limit:20}), undefined);
 assert.equal(documentReadBlocker('edit', {}), undefined);
});

test('budget blocking emits recoverable finish rather than throwing outside host recovery', async () => {
 const chunks = [];
 for await (const chunk of budgetBlockedStream('上下文预算阻塞')) chunks.push(chunk);
 assert.deepEqual(chunks, [{type:'finish',reason:{kind:'error',failure:{code:'WORKBENCH_CONTEXT_BUDGET',message:'上下文预算阻塞'}}}]);
});

test('request estimate excludes attribution and cached metadata without removing visible content', () => {
 const plain = {role:'user', content:[{type:'text',text:'mandatory instructions'}]};
 const attributed = {...plain, source:{kind:'runtime-context',sections:[{text:'x'.repeat(50000)}]}, id:'event-id'};
 assert.deepEqual(requestBudget([plain], []), requestBudget([attributed], []));
 assert.ok(requestBudget([{...plain,content:[{type:'text',text:'x'.repeat(50000)}]}], []).estimatedInputTokens > 24000);
});
