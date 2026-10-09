import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git, gitFailure, fetchPullRequestRevision } from '../src/core/git.ts';
import type { Repo, PRContext } from '../src/core/types.ts';

test('Git timeout is distinct from auth failure; transport errors redact credentials',()=>{
  assert.match(gitFailure({killed:true,signal:'SIGTERM'},'clone',240000).message,/超过 240 秒/);
  assert.doesNotMatch(gitFailure({killed:true,signal:'SIGTERM'},'clone',240000).message,/权限不足/);
  const abort=Object.assign(new Error('Cancelled'),{name:'AbortError'});
  assert.equal(gitFailure(abort,'clone',240000),abort);
  const message=gitFailure({stderr:'fatal https://user:secret@proxy/ ghp_abc123'},'fetch',30000).message;
  assert.doesNotMatch(message,/secret|ghp_abc123/);
});

test('shallow repository extends history until PR merge-base is available and preserves exact refs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'maintainer-shallow-pr-')),source=join(root,'source'),checkout=join(root,'checkout');
  await mkdir(source);await git(source,['init','-b','main']);
  const commit=async(text:string)=>{await writeFile(join(source,'code.txt'),text);await git(source,['add','.']);await git(source,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m',text]);return git(source,['rev-parse','HEAD']);};
  const common=await commit('common');await git(source,['branch','topic']);
  for(let i=0;i<8;i++)await commit(`main-${i}`);
  const base=await git(source,['rev-parse','HEAD']);await git(source,['checkout','topic']);await writeFile(join(source,'feature.txt'),'PR full source');await git(source,['add','.']);await git(source,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','topic']);
  const head=await git(source,['rev-parse','HEAD']);await git(source,['update-ref','refs/pull/7/head',head]);await git(source,['checkout','main']);
  await git(root,['clone','--depth=2','--single-branch','--no-tags',`file://${source}`,checkout]);
  assert.equal(await git(checkout,['rev-parse','--is-shallow-repository']),'true');
  const repo={localPath:checkout} as Repo;
  const pr={headSha:head,baseSha:base} as PRContext;
  const calls:string[][]=[];
  await fetchPullRequestRevision(repo,7,pr,undefined,async(cwd,args,auth,signal,timeout)=>{
    calls.push(args);
    if(args[0]==='fetch') {
      // Small initial windows deliberately exercise the deepening path.
      const local=args.map(x=>x==='origin'?`file://${source}`:x==='--depth=64'?'--depth=2':x);
      return git(cwd,local,false,signal,timeout);
    }
    return git(cwd,args,auth,signal,timeout);
  });
  assert.ok(calls.some(args=>args.includes('--deepen=256')));
  assert.equal(await git(checkout,['merge-base',base,head]),common);
  assert.equal(await git(checkout,['show',`${head}:feature.txt`]),'PR full source');
  assert.equal(await readFile(join(checkout,'code.txt'),'utf8'),'main-7');
});

test('unavailable shallow ancestry stops review rather than treating an incomplete diff as verified',async()=>{
  const pr={headSha:'a'.repeat(40),baseSha:'b'.repeat(40)} as PRContext;
  let deepens=0;
  await assert.rejects(fetchPullRequestRevision({localPath:'/fixture'} as Repo,7,pr,undefined,async(_,args)=>{
    if(args[1]==='--is-shallow-repository')return 'true';
    if(args[1]==='FETCH_HEAD')return pr.headSha;
    if(args[0]==='merge-base')throw new Error('missing history');
    if(args.some(x=>x.startsWith('--deepen=')))deepens++;
    return '';
  }),/共同祖先尚未下载完整/);
  assert.equal(deepens,3);
});
