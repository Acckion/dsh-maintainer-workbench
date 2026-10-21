import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
const { harnessRuntime } = await import(new URL('../scripts/harness-runtime.mjs', import.meta.url).href);

test('normal launch preserves configuration when no private runtime is configured',async t=>{
 const data=await mkdtemp(join(tmpdir(),'mw-runtime-'));t.after(()=>rm(data,{recursive:true,force:true}));
 const env={PATH:'/usr/bin',DSH_HOME:'/existing',GITHUB_TOKEN:'opaque'};
 assert.deepEqual(await harnessRuntime(data,env,'/original/node'),{executable:'/original/node',env});
});

test('ordinary npm/shell restart selects configured runtime and passes it to bash',async t=>{
 const data=await mkdtemp(join(tmpdir(),'mw-runtime-'));t.after(()=>rm(data,{recursive:true,force:true}));
 const bin=join(data,'bin');await mkdir(bin);await mkdir(join(data,'runtime'));
 await symlink(process.execPath,join(bin,'node'));
 await writeFile(join(bin,'pnpm'),'#!/bin/sh\nnode --version\n',{mode:0o755});
 await writeFile(join(data,'runtime/config.json'),JSON.stringify({binDirectory:bin,nodeOptions:['--max-old-space-size=4096']}));
 const inherited={PATH:'/usr/bin:/bin',DSH_HOME:'/existing',NODE_OPTIONS:'--use-system-ca'};
 const runtime=await harnessRuntime(data,inherited,'/old/node');
 assert.equal(runtime.executable,join(bin,'node'));assert.equal(runtime.env.PATH.split(delimiter)[0],bin);
 assert.equal(runtime.env.DSH_HOME,inherited.DSH_HOME);assert.match(runtime.env.NODE_OPTIONS,/--use-system-ca.*--max-old-space-size=4096/);
 assert.equal(execFileSync('/bin/bash',['-c','node --version && pnpm --version'],{env:runtime.env,encoding:'utf8'}),`${process.version}\n${process.version}\n`);
 await writeFile(join(data,'runtime/config.json'),JSON.stringify({binDirectory:join(data,'missing')}));
 await assert.rejects(harnessRuntime(data,inherited,'/old/node'));
 await writeFile(join(data,'runtime/config.json'),'{invalid');
 await assert.rejects(harnessRuntime(data,inherited,'/old/node'));
});
