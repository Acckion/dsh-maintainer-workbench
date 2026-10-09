import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from '../src/core/types.ts';
import { taskGroups } from '../src/client/task-presentation.ts';
const job = (id: string, kind: Job['kind'], status: Job['status'], sourceJobId?: string): Job => ({id,kind,status,sourceJobId,repoId:'r',issueId:'i',createdAt:new Date(Date.UTC(2026,9,9,0,0,id.length)).toISOString(),updatedAt:'',revision:'r',baseSha:'base',attempt:1,issueSnapshot:{} as Job['issueSnapshot']});
test('quick jobs remain available but do not create default task rows', () => {
  const jobs=[job('quick','preflight','completed'),job('fix','fix','awaiting_review','quick'),job('validation','validate','completed','fix')];
  assert.equal(taskGroups(jobs).length,1);assert.equal(taskGroups(jobs)[0].members.length,2);
  assert.equal(taskGroups(jobs,true).length,2);
});
test('independent attempts and cross-item links cannot be silently combined', () => {
  const one=job('one','fix','completed'),two=job('two','fix','completed');
  assert.equal(taskGroups([one,two]).length,2);
  const foreign={...job('validation','validate','completed','one'),issueId:'other'};
  assert.equal(taskGroups([one,foreign]).length,2);
});
test('a later failure is visible even when an earlier step passed', () => {
  const groups=taskGroups([job('fix','fix','awaiting_review'),job('validation','validate','failed','fix')]);
  assert.equal(groups[0].state,'failed');assert.equal(groups[0].latest.id,'validation');
});

test('equal timestamps retain the later source step and unresolved approvals remain visible', () => {
 const fix=job('fix','fix','awaiting_review'),check={...job('check','validate','completed','fix'),createdAt:fix.createdAt};
 const group=taskGroups([fix,check])[0];assert.equal(group.latest.id,'check');assert.equal(group.state,'attention');
});
