import test from 'node:test';
import assert from 'node:assert/strict';
import {PullRequestClient} from '../src/infrastructure/github/pull-requests.ts';
import {GitHubRequestError} from '../src/core/github-request.ts';
import {githubCheckNotices,genericGitHubCoverageGap} from '../src/core/github-check-notices.ts';
import type {PRContext,Repo} from '../src/core/types.ts';
const sha='a'.repeat(40),repo={fullName:'owner/repo'} as Repo;
const pr:PRContext={headSha:sha,baseSha:'b'.repeat(40),headRef:'topic',headRepo:'fork/repo',baseRef:'main',draft:false,merged:false,mergeable:true,checks:{check_runs:[]},reviews:[],warnings:[]};
function client(protectedFlag:boolean|undefined,errorKind:'not_found'|'permission'|'network'='not_found'){
 const paths:string[]=[];
 const request=async(path:string,init?:RequestInit)=>{
  paths.push(path);assert.ok(!init?.method||init.method==='GET');
  if(path.endsWith('/pulls/36'))return {head:{sha,ref:'topic',repo:{full_name:'fork/repo'}},base:{sha:'b'.repeat(40),ref:'main'},draft:false,merged:false,mergeable:true};
  if(path.endsWith('/branches/main'))return protectedFlag===undefined?{}:{protected:protectedFlag};
  if(path.endsWith('/protection'))throw new GitHubRequestError(errorKind,'test read failed');
  if(path.includes('/rules/'))return [];
  if(path.includes('/actions/runs'))return {workflow_runs:[{head_sha:sha,status:'completed',conclusion:'action_required',html_url:'https://github.com/owner/repo/actions/runs/1'}]};
  return path.includes('/check-runs')?{check_runs:[]}:[];
 };
 return {paths,client:new PullRequestClient({request,graphql:async()=>null,fetcher:fetch})};
}
test('unprotected branch skips protection endpoint and approval is separate from protection',async()=>{
 const c=client(false);const result=await c.client.pullRequest(repo,36);
 assert.equal(result.branchProtectionRead,'not_configured');assert.ok(!c.paths.some(p=>p.endsWith('/protection')));
 const notices=githubCheckNotices(result);assert.match(notices[0].title,/未配置/);assert.match(notices[1].title,/CI 需要人工处理/);assert.equal(notices[1].url,'https://github.com/owner/repo/actions/runs/1');
 assert.ok(!result.warnings.some(w=>w.includes('无法读取')));
});
test('404 never establishes absent rules; permission failure differs from connectivity',async()=>{
 for(const [kind,label] of [['not_found','not_found'],['permission','permission_denied'],['network','unavailable']] as const){
  const c=client(undefined,kind),result=await c.client.pullRequest(repo,36);
  assert.equal(result.branchProtectionRead,label);assert.ok(!githubCheckNotices(result)[0].title.includes('未配置'));
  assert.ok(result.warnings.length>1);
 }
});
test('empty checks are not green; old snapshots disclose unknown protection and skip old-head approval',()=>{
 const notices=githubCheckNotices({...pr,branchProtection:null,branchRules:[],workflowRuns:{workflow_runs:[{head_sha:'other',conclusion:'action_required'}]}});
 assert.match(notices[0].title,/尚未确认/);assert.match(notices[1].title,/尚无可用/);
 const withRules=githubCheckNotices({...pr,branchProtectionRead:'not_configured',branchRules:[{type:'required_status_checks'}]});assert.match(withRules[0].title,/已读取/);
});
test('generic coverage text can be replaced without hiding actual required gates or local failures',()=>{
 const gap={id:'old',kind:'external_wait' as const,status:'failed' as const,summary:'无法读取 main 分支保护规则与 CI 检查',blocks:[],resolution:'等待',sources:[]};
 assert.equal(genericGitHubCoverageGap(gap),true);
 assert.equal(genericGitHubCoverageGap({...gap,id:'host_required_ci'}),false);
 assert.equal(genericGitHubCoverageGap({...gap,summary:'CI 本地依赖缺失'}),false);
 assert.equal(genericGitHubCoverageGap({...gap,summary:'CI test failed'}),false);
});

test('Actions preserves an approval-required workflow even when it has no jobs yet',async()=>{
 const {ActionsClient}=await import('../src/infrastructure/github/actions.ts');
 const c=new ActionsClient({request:async(path)=>path.includes('/attempts/')?{total_count:0,jobs:[]}:{total_count:1,workflow_runs:[{id:12,head_sha:sha,run_attempt:1,status:'completed',conclusion:'action_required',html_url:'https://github.com/owner/repo/actions/runs/12'}]},graphql:async()=>null,fetcher:fetch});
 const result=await c.actions(repo,sha);assert.equal(result.jobs.length,0);assert.equal(result.runs?.[0].conclusion,'action_required');assert.equal(result.runs?.[0].headSha,sha);
});
