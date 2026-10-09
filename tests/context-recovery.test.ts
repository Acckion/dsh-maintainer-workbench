import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverContextBudget } from '../src/core/context-recovery.ts';
test('durable context recovery prunes before summarizing and never retries without progress', async () => {
 let summaries = 0;
 assert.equal(await recoverContextBudget('上下文预算阻塞', 0, {prune:()=>1000,compact:async()=>{summaries++;return true;}}), 'pruned');
 assert.equal(summaries, 0);
 assert.equal(await recoverContextBudget('上下文预算阻塞', 1, {prune:()=>0,compact:async()=>true}), 'compacted');
 assert.equal(await recoverContextBudget('上下文预算阻塞', 2, {prune:()=>0,compact:async()=>false}), undefined);
 assert.equal(await recoverContextBudget('上下文预算阻塞', 3, {prune:()=>{throw Error('must not run');},compact:async()=>true}), undefined);
 assert.equal(await recoverContextBudget('permission denied', 0, {prune:()=>{throw Error('must not run');},compact:async()=>true}), undefined);
});
