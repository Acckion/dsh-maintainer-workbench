import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticToolLimit, toolLoopPolicy } from '../src/core/tool-loop.ts';

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
test('all tool stages have a finite budget, warn before exhaustion and preserve report submission',()=>{
 for(const kind of ['investigate','review','docs','validate','fix','ci']){
  const p=toolLoopPolicy(kind==='docs',kind==='investigate',{kind,limit:60});let warned=false;
  for(let i=0;i<60;i++){const notice=p.guard('read',{file_path:`source-${i}.ts`});if(notice)warned=true;assert.equal(p.reason,undefined);}
  assert.ok(warned);assert.match(p.guard('read',{file_path:'next.ts'})!,/预算已达上限/);
  assert.match(p.reason!,/不代表阶段成功/);assert.equal(p.guard('submit_stage_report',{report:{}}),undefined);assert.equal(p.state.used,60);
 }
});
test('scope-aware defaults and explicit override remain independent of token limits',()=>{
 assert.equal(automaticToolLimit('investigate',['README.md']),80);
 assert.equal(automaticToolLimit('investigate',['docs']),120);
 assert.equal(automaticToolLimit('investigate',[]),180);
 assert.equal(toolLoopPolicy(false,true,{limit:200,scope:['README.md']}).state.limit,200);
});
test('varying glob suffixes cannot consume the whole task in search churn',()=>{
 const p=toolLoopPolicy(false,true,{scope:['README.md']});
 for(let i=0;i<50&&!p.reason;i++)p.guard('glob',{pattern:`docs/lang${i}/**`});
 assert.match(p.reason!,/搜索无进展/);assert.ok(p.state.used<50);
});
test('edits reset exact-repeat detection but never reset the overall task budget',()=>{
 const p=toolLoopPolicy(true,false,{limit:10});
 for(let i=0;i<10;i++){p.guard('read',{file_path:`source${i}`});p.edited('write',false);}
 assert.match(p.guard('read',{file_path:'next'})!,/预算已达上限/);
});
test('report tool guards do not double-count calls or consume exploration allowance',()=>{
  const p=toolLoopPolicy(false,true,{limit:10});for(let i=0;i<10;i++)p.guard('submit_stage_report',{});
  assert.equal(p.state.used,0);assert.equal(p.reason,undefined);
});
test('pwsh executions count toward the same budget and repetition detection as bash',()=>{
  const p=toolLoopPolicy(true,false,{kind:'docs',limit:10});
  assert.equal(p.guard('pwsh',{command:'Get-Content AGENTS.md'}),undefined);
  assert.equal(p.guard('pwsh',{command:'Get-Content AGENTS.md'}),undefined);
  assert.match(p.guard('pwsh',{command:'Get-Content AGENTS.md'})!,/提醒/);
  assert.equal(p.state.used,3,'Windows shell executions must count when the tool is named pwsh');
  assert.equal(p.guard('bash',{command:'Get-Content AGENTS.md'}),undefined,'a different tool name starts a separate fingerprint');
  assert.equal(p.state.used,4);
});
