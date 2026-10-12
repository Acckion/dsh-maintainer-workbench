import test from 'node:test';
import assert from 'node:assert/strict';
import {messageStreamRecovery, recoverableMessageStream} from '../src/core/message-stream-recovery.ts';
const failure={code:'MALFORMED_RESPONSE',message:'DeepSeek Messages stream: event precedes message_start'};
test('a malformed pre-start stream retries the same step twice and has a session-wide cap',()=>{
 const p=messageStreamRecovery();
 assert.equal(p.next(failure,1,1),'retry');assert.equal(p.next(failure,1,1),'retry');assert.equal(p.next(failure,1,1),'exhausted');
 assert.equal(p.next(failure,1,2),'retry');assert.equal(p.next(failure,2,1),'retry');assert.equal(p.next(failure,3,1),'exhausted');assert.equal(p.attempts,4);
});
test('other protocol errors, budget failures and tool loops are not reclassified as transient streams',()=>{
 const p=messageStreamRecovery();
 for(const f of [{...failure,code:'HTTP_ERROR'},{...failure,message:'DeepSeek Messages stream: duplicate message_start'},{code:'WORKBENCH_TOOL_LOOP',message:'重复工具调用阻塞'},{code:'WORKBENCH_CONTEXT_BUDGET',message:'上下文预算阻塞'}]) assert.equal(p.next(f,1,1),undefined);
 assert.equal(p.attempts,0);
});

test('only an empty pre-start stream throw becomes a recoverable finish',async()=>{
 const error=Object.assign(new Error(failure.message),{code:failure.code});
 const collect=async(stream:AsyncIterable<unknown>)=>{const chunks=[];for await(const chunk of stream)chunks.push(chunk);return chunks;};
 assert.deepEqual(await collect(recoverableMessageStream(async function*(){throw error;})),[{type:'finish',reason:{kind:'error',failure}}]);
 await assert.rejects(collect(recoverableMessageStream(async function*(){throw new Error('network unavailable');})),/network unavailable/);
 await assert.rejects(collect(recoverableMessageStream(async function*(){yield {type:'finish',reason:{kind:'error',failure}};throw error;})),/event precedes/);
});
