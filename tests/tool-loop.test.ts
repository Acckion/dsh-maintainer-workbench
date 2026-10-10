import test from 'node:test';
import assert from 'node:assert/strict';
import { toolLoopPolicy } from '../src/core/tool-loop.ts';

test('Issue 4 guidance cycle is blocked despite changing shell descriptions', () => {
  const policy = toolLoopPolicy(true);
  const commands = ["sed -n '16,40p' AGENTS.md", "sed -n '82,116p' CONTRIBUTING.md", "grep -nE '^#{1,4} ' AGENTS.md", "grep -nE '^#{1,4} ' CONTRIBUTING.md"];
  for (let cycle = 0; cycle < 4; cycle++) for (const command of commands) {
    const warning = policy.guard('bash', {command, description: `cycle ${cycle}`, timeout: 1000 + cycle});
    if (cycle < 2) assert.equal(warning, undefined);
    if (cycle === 2) assert.match(warning!, /提醒/);
  }
  assert.match(policy.reason!, /重复工具调用阻塞/);
});
test('segmented reads and changed commands remain available; rejected edits cannot reset loop', () => {
  const policy = toolLoopPolicy();
  for (let offset = 1; offset <= 100; offset += 20) assert.equal(policy.guard('read', {limit:20, offset, file_path:'AGENTS.md'}), undefined);
  assert.equal(policy.guard('bash', {command:'git diff --check'}), undefined);
  assert.equal(policy.guard('bash', {command:'git diff --check'}), undefined);
  policy.edited('edit', true);
  assert.match(policy.guard('bash', {command:'git diff --check'})!, /提醒/);
  policy.edited('write', false);
  assert.equal(policy.guard('bash', {command:'git diff --check'}), undefined);
  assert.equal(policy.reason, undefined);
});
test('opaque argument strings and reordered keys cannot bypass repetition detection', () => {
  const p=toolLoopPolicy();
  assert.equal(p.guard('read','{"offset":1,"limit":20,"file_path":"A.md"}'),undefined);
  assert.equal(p.guard('read',{file_path:'A.md',limit:20,offset:1}),undefined);
  assert.match(p.guard('read',{offset:1,file_path:'A.md',limit:20})!,/提醒/);
  p.guard('read',{file_path:'A.md',limit:20,offset:1});
  assert.ok(p.reason);
});
test('varied document searches also have a bounded investigation budget', () => {
  const p=toolLoopPolicy(true);
  for(let i=0;i<60;i++) assert.equal(p.guard('bash',{command:`grep pattern${i} A.md`}),undefined);
  assert.match(p.guard('bash',{command:'grep next A.md'})!,/文档调查预算阻塞/);
  assert.ok(p.reason);
  const code=toolLoopPolicy();
  for(let i=0;i<100;i++) assert.equal(code.guard('bash',{command:`test ${i}`}),undefined);
});
test('read-only investigations cannot browse indefinitely and budget exhaustion is not success',()=>{
 const p=toolLoopPolicy(false,true);
 for(let i=0;i<60;i++) assert.equal(p.guard('read',{file_path:`source-${i}.ts`,offset:1,limit:20}),undefined);
 assert.match(p.guard('read',{file_path:'next.ts',offset:1,limit:20})!,/调查预算阻塞/);
 assert.match(p.reason!,/不代表阶段成功/);
});
