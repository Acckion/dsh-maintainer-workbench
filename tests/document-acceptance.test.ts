import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactSchemas } from '../src/core/artifacts.ts';
import { documentAcceptance,documentCheckCommand,needsDocumentCheckExecution } from '../src/core/document-acceptance.ts';
import type { Job,ExecutionRecord } from '../src/core/types.ts';
const artifact=()=>artifactSchemas.validate.parse({schemaVersion:1,stage:'validate',summary:'all passed',coverage:'all links valid',evidence:[],nextSteps:[],responseDraft:'all passed',environment:'native',tests:[],blockers:[]});
const job={kind:'validate',sourceJobId:'docs',handoff:[{id:'docs',kind:'docs'}],worktree:'/tmp/doc-worktree',sessionId:'session',baseSha:'a'.repeat(40),patchSha256:'patch',executionRecords:[]} as unknown as Job;
test('document completeness blocks diff-only reports and mismatched sessions',()=>{
 const output=documentAcceptance(artifact(),job);assert.equal(output.stage,'validate');if(output.stage!=='validate')return;assert.equal(output.tests[0].status,'not_run');assert.equal(output.blockers.length,4);assert.doesNotMatch(output.responseDraft,/all passed/);
 const record={id:'session:1',sessionId:'other',cwd:job.worktree,checkoutSha:job.baseSha,patchHash:'patch',command:documentCheckCommand(job),exitCode:0,isError:false,output:'DOCUMENT_CHECKS_JSON={"checks":{"whitespace":true,"link_files":true,"link_anchors":true,"exact_repetition":true}}'} as ExecutionRecord;
 const wrong=documentAcceptance(artifact(),{...job,executionRecords:[record]});if(wrong.stage==='validate')assert.equal(wrong.tests[0].status,'not_run');
 const passed=documentAcceptance(artifact(),{...job,executionRecords:[{...record,sessionId:'session'}]});if(passed.stage==='validate'){assert.equal(passed.tests[0].status,'passed');assert.equal(passed.blockers.length,0);assert.match(passed.coverage,/语义重复需人工/);}
});

test('diff success cannot suppress mandatory checker repair; failed checker is not repeated',()=>{
 const diff={command:'git diff --check',exitCode:0,isError:false} as ExecutionRecord;
 assert.equal(needsDocumentCheckExecution(job,[diff]),true);
 assert.equal(needsDocumentCheckExecution(job,[diff,{...diff,command:documentCheckCommand(job),exitCode:1,isError:true}]),false);
});

test('checker exit-code echo retains current-session evidence without accepting arbitrary shell wrappers',()=>{
 const record={id:'session:1',sessionId:'session',cwd:job.worktree,checkoutSha:job.baseSha,patchHash:'patch',command:documentCheckCommand(job)+'; echo "REQUIRED_CHECK_EXIT=$?"',exitCode:0,isError:false,output:'DOCUMENT_CHECKS_JSON={"checks":{"whitespace":true,"link_files":true,"link_anchors":true,"exact_repetition":true}}\nREQUIRED_CHECK_EXIT=0'} as ExecutionRecord;
 assert.equal(needsDocumentCheckExecution(job,[record]),false);
 const passed=documentAcceptance(artifact(),{...job,executionRecords:[record]});
 if(passed.stage==='validate'){assert.equal(passed.tests[0].status,'passed');assert.equal(passed.tests[0].command,record.command);assert.equal(passed.tests[0].executionId,record.id);assert.deepEqual(passed.blockers,[]);}
 for(const change of [{sessionId:'other'},{patchHash:'other'},{cwd:'/tmp/other'},{checkoutSha:'other'},{command:documentCheckCommand(job)+' | cat'},{command:record.command+'; true'},{command:documentCheckCommand(job)+'; echo "REQUIRED_CHECK_EXIT=$(true)"'}]){
  const output=documentAcceptance(artifact(),{...job,executionRecords:[{...record,...change}]});
  if(output.stage==='validate')assert.equal(output.tests[0].status,'not_run',JSON.stringify(change));
 }
 const failure={...record,id:'session:2',output:'DOCUMENT_CHECKS_JSON={"checks":{"whitespace":false,"link_files":true,"link_anchors":true,"exact_repetition":true}}\nREQUIRED_CHECK_EXIT=1'};
 const failed=documentAcceptance(artifact(),{...job,executionRecords:[record,failure]});
 if(failed.stage==='validate'){assert.equal(failed.tests[0].status,'failed');assert.equal(failed.tests[0].executionId,failure.id);assert.ok(failed.blockers.some(b=>b.includes('whitespace')));}
});

 test('document checker resolves from plugin location, independent of cwd and ships in package',async()=>{
  const before=process.cwd();const {tmpdir}=await import('node:os');const {readFileSync}=await import('node:fs');
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.ok(pkg.files.includes('scripts/verify-document-patch.mjs'));
  try{process.chdir(tmpdir());const command=documentCheckCommand({worktree:'/tmp/worktree',baseSha:'a'.repeat(40)});assert.match(command,/scripts[/\\]verify-document-patch\.mjs/);assert.ok(!command.includes("'/tmp/scripts/"));}finally{process.chdir(before);}
 });

test('host document command executes in the native shell with spaces and apostrophes in paths',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {git}=await import('../src/core/git.ts');
 const root=await mkdtemp(join(tmpdir(),"document check's-"));
 try {
  await git(root,['init']);await writeFile(join(root,'README.md'),'# Fixture\n\nOriginal text.\n');await git(root,['add','.']);
  await git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','baseline']);
  const baseSha=await git(root,['rev-parse','HEAD']);await writeFile(join(root,'README.md'),'# Fixture\n\nOriginal text.\n\nClarified behavior.\n');
  const command=documentCheckCommand({worktree:root,baseSha});
  const args=process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',command]:['-c',command];
  const {stdout}=await promisify(execFile)(process.platform==='win32'?'pwsh':'bash',args,{cwd:root,timeout:20000});
  const line=stdout.split('\n').find(line=>line.startsWith('DOCUMENT_CHECKS_JSON='));assert.ok(line);
  const result=JSON.parse(line.slice('DOCUMENT_CHECKS_JSON='.length));
  assert.deepEqual(result.checks,{whitespace:true,link_files:true,link_anchors:true,exact_repetition:true});
 }finally{await rm(root,{recursive:true,force:true});}
});
