import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentValidationRanges, documentInspectionPolicy } from '../src/core/document-validation.ts';
test('document inspection follows changed paragraphs and added link headings, rejects avatar scanning and duplicates', async () => {
 const root=await mkdtemp(join(tmpdir(),'doc-scope-'));await mkdir(join(root,'docs'));
 await writeFile(join(root,'docs/install.md'),'intro\n'.repeat(149)+'### From source\n');
 const patch='+++ b/README.md\n@@ -35,6 +35,10 @@\n+[Setup](docs/install.md#from-source)\n';
 const ranges=await documentValidationRanges(root,patch);
 assert.ok(ranges.some(r=>r.path==='docs/install.md' && r.start===145));
 const policy=documentInspectionPolicy(root,ranges);
 assert.equal(policy.guard('read',{filePath:'README.md',offset:35,limit:10}),undefined);
 assert.match(policy.guard('read',{filePath:'README.md',offset:35,limit:10})!,/已读取/);
 assert.match(policy.guard('read',{filePath:'README.md',offset:191,limit:10})!,/相关段落/);
 assert.equal(policy.guard('grep',{path:'docs/install.md',pattern:'From source'}),undefined);
 assert.ok(policy.guard('glob',{}));
 for(let i=0;i<20;i++)policy.guard('read',{filePath:'README.md',offset:191,limit:10});
 assert.equal(policy.exhausted,true);
 assert.equal(policy.guard('bash',{command:'git diff --check HEAD'}),undefined);
});

test('native file_path reads are accepted and rejected ranges provide executable hints',()=>{
 const policy=documentInspectionPolicy('/tmp/docs',[{path:'README.md',start:35,end:60,reason:'changed'}]);
 assert.equal(policy.guard('read',{file_path:'README.md',offset:35,limit:20}),undefined);
 const error=policy.guard('read',{file_path:'README.md',offset:1,limit:20});
 assert.match(error!,/"file_path":"README.md","offset":35,"limit":20/);
 assert.ok(policy.guard('read',{file_path:'outside.md',offset:35,limit:20}));
});
