import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Job,ExecutionRecord} from '../src/core/types.ts';
import {analysisEvidence,citedExecution,evidenceBlocks,evidenceTitle,numberedCode,relativeEvidencePath} from '../src/client/evidence-presentation.ts';
const job={id:'run',worktree:'/saved/worktree',executionRecords:[{id:'session:24',callId:'call-24',sourcePath:'/saved/worktree/src/index.ts',output:'<path>/saved/worktree/src/index.ts</path>\n<type>file</type>\n<content>\n18: export function sum(values: number[]) {\n19:   return values.reduce((total, value) => total + value, 0);\n20: }\n(End of file - total 20 lines)\n</content>',tool:'read'}]} as Job;

test('read envelopes render saved file text with real source coordinates and preserved indentation',()=>{
 const record=job.executionRecords![0],original=record.output;
 const blocks=evidenceBlocks(original);assert.equal(blocks.length,1);assert.equal(blocks[0].kind,'code');assert.equal(blocks[0].path,'/saved/worktree/src/index.ts');
 const code=numberedCode(blocks[0].text);assert.equal(code.sourceNumbers,true);assert.deepEqual(code.lines.map(line=>line.number),[18,19,20]);assert.equal(code.lines[1].text,'  return values.reduce((total, value) => total + value, 0);');assert.match(code.note!,/End of file/);assert.equal(record.output,original);
});
test('unrelated read prefixes and trailing explanations remain visible',()=>{
 const blocks=evidenceBlocks('Report context\n'+job.executionRecords![0].output+'\nThis is an excerpt.');assert.equal(blocks[0].text,'Report context');assert.equal(blocks[2].text,'This is an excerpt.');
 const duplicate=evidenceBlocks('src/index.ts '+job.executionRecords![0].output);assert.equal(duplicate.length,1);
});
test('multiple patches retain per-file headers, hunks and command output before the patch',()=>{
 const first='diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-old\n+new';
 const second='diff --git a/docs/read me.md b/docs/read me.md\n--- a/docs/read me.md\n+++ b/docs/read me.md\n@@ -1 +1 @@\n-old\n+new';
 const blocks=evidenceBlocks('M src/a.ts\n---DIFF---\n'+first+'\n'+second);assert.deepEqual(blocks.map(block=>block.kind),['text','diff','diff']);assert.equal(blocks[1].path,'src/a.ts');assert.equal(blocks[2].path,'docs/read me.md');assert.match(blocks[1].text,/@@ -2 \+2 @@/);
});
test('unified and fenced diff excerpts are not rendered as prose',()=>{
 assert.equal(evidenceBlocks('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b')[0].kind,'diff');
 assert.equal(evidenceBlocks('```diff\n@@ -1 +1 @@\n-a\n+b\n```')[0].kind,'diff');
 const code=evidenceBlocks('説明\n```ts\nconst value = 1;\n```\nOther note');assert.deepEqual(code.map(block=>block.kind),['text','code','text']);assert.equal(code[1].language,'ts');
});
test('ordinary logs and ambiguous numbering do not gain invented source coordinates',()=>{
 for(const text of ['1: a\n1: b','3: a\n2: b','0: not a source line','Build failed\n2: error','http://example.test\nexit 0'])assert.equal(numberedCode(text).sourceNumbers,false,text);
 const text='Error: <script>alert(1)</script>\n  detail\n\tindent';assert.equal(evidenceBlocks(text)[0].text,text);
});
test('execution citations bind uniquely within this run without session-prefix matching',()=>{
 assert.equal(citedExecution({source:'Harness execution session:24',detail:''},job)?.id,'session:24');assert.equal(citedExecution({source:'call-24',detail:''},job)?.id,'session:24');
 for(const source of ['Harness execution session:2','Harness execution session','Harness execution other:24','session:24 with more text'])assert.equal(citedExecution({source,detail:''},job),undefined);
 const duplicates={...job,executionRecords:[...job.executionRecords!,{...job.executionRecords![0]}]};assert.equal(citedExecution({source:'session:24',detail:''},duplicates),undefined);
});
test('human-readable file names use saved worktree context without modifying external paths',()=>{
 assert.deepEqual(evidenceTitle({source:'Harness execution session:24',detail:'report'},job),{title:'src/index.ts',kind:'file'});
 assert.deepEqual(evidenceTitle({source:'AGENTS.md',detail:'Saved guidance'}),{title:'AGENTS.md',kind:'file'});
 assert.equal(relativeEvidencePath('/other/file',job),'/other/file');assert.equal(relativeEvidencePath('/saved/worktree-other/src.ts',job),'/saved/worktree-other/src.ts');
});
test('artifact-only evidence remains available and finalized report evidence keeps precedence',()=>{
 const a={source:'report',detail:'finalized'},b={source:'artifact',detail:'original'};
 assert.deepEqual(analysisEvidence({artifact:{evidence:[b]}} as Job),[b]);
 assert.deepEqual(analysisEvidence({result:{evidence:[a]},artifact:{evidence:[b]}} as Job),[a]);
});
