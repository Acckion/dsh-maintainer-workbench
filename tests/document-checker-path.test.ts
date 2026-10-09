import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('nested Markdown local heading links resolve to their own file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'docs-anchor-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8'});
 git('init','-q');git('config','user.name','test');git('config','user.email','test@example.invalid');await mkdir(join(dir,'docs'));await writeFile(join(dir,'docs/a.md'),'# Introduction\n');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD').trim();await writeFile(join(dir,'docs/a.md'),'# Introduction\n\n[Intro](#introduction)\n');
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/verify-document-patch.mjs',import.meta.url)),dir,base],{encoding:'utf8'});
 const data=JSON.parse(output.trim().slice('DOCUMENT_CHECKS_JSON='.length));assert.equal(data.checks.link_files,true);assert.equal(data.checks.link_anchors,true);
});
