import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { Workbench, revision } from '../src/core/workbench.ts';
import { artifactSchemas, asAnalysis } from '../src/core/artifacts.ts';
import { GitHub } from '../src/core/github.ts';
import { git } from '../src/core/git.ts';
import { fixtureAnalysis, seedFixture } from './support/fixtures.ts';
import type { Job, Runner, Issue } from '../src/core/types.ts';

const triage = () => artifactSchemas.triage.parse({schemaVersion:1,stage:'triage',summary:'缺少复现信息',coverage:'metadata',evidence:[],nextSteps:['ask version'],responseDraft:'Which version?',category:'bug',priority:'P2',labels:[],module:'unknown',impact:'unknown',missingInfo:['version'],duplicateOf:null,duplicateReason:'',route:'needs_info',routeReason:'版本影响判断'});

test('100 lightweight jobs never inspect or clone an existing local path and keep routing separate from approval', async () => {
  const store = new Store(':memory:'); seedFixture(store); const repo = store.repos()[0];
  store.put('repos',{...repo,localPath:'/does/not/exist'});
  const base = store.issues()[0]; const ids:string[]=[];
  for(let n=1;n<=100;n++) {const id=repo.id+'#'+n;ids.push(id);store.put('issues',{...base,id,number:n});}
  let count=0;
  const runner:Runner=async({job,settings,repo})=>{assert.equal(job.worktree,undefined);assert.ok(job.analysisPath);assert.equal(settings.maxTokens,1800);assert.deepEqual(repo.profile?.sources,[]);count++;const artifact=triage();return{artifact,result:asAnalysis(artifact),engine:'test'};};
  const w = new Workbench(store,await mkdtemp(join(tmpdir(),'mw-light-')),runner,undefined,false);
  w.updateSettings({...store.settings(),maxJobsPerBatch:50});w.enqueue(ids.slice(0,50),'triage');w.enqueue(ids.slice(50),'triage');w.pump();await w.drain();
  assert.equal(count,100);assert.ok(store.jobs().every(j=>j.status==='completed'));assert.equal(store.get<Issue>('issues',ids[0])?.processing?.phase,'needs_info');
  assert.equal(store.jobs()[0].publications,undefined);await w.close();
});

test('unrelated repository commits keep Issue triage valid but invalidate code work',()=>{
  const store=new Store(':memory:');seedFixture(store);const i=store.issues()[0],r=store.repos()[0],next={...r,headSha:'b'.repeat(40)};
  assert.equal(revision(i,r,'triage'),revision(i,next,'triage'));assert.notEqual(revision(i,r,'fix'),revision(i,next,'fix'));
  assert.notEqual(revision(i,r),revision({...i,updatedAt:'new comment'},r));store.close();
});

test('repository round robin prevents one batch monopolizing a single execution slot',async()=>{
  const store=new Store(':memory:');seedFixture(store);const r=store.repos()[0],i=store.issues()[0];store.put('repos',{...r,id:'other/repo',fullName:'other/repo'});store.put('issues',{...i,id:'other/repo#1',repoId:'other/repo'});
  const order:string[]=[];const runner:Runner=async({repo,issue})=>{order.push(repo.id);return{result:fixtureAnalysis(issue,'triage'),engine:'test'};};
  const w=new Workbench(store,await mkdtemp(join(tmpdir(),'mw-fair-')),runner,undefined,false);w.updateSettings({...store.settings(),concurrency:1});w.enqueue(store.issues().map(i=>i.id),'triage');w.pump();await w.drain();
  assert.deepEqual(order.slice(0,2),[r.id,'other/repo']);await w.close();
});

test('rejected feedback reaches a retry and explicit source must belong to the same item',async()=>{
  const store=new Store(':memory:');seedFixture(store);const seen:Job[]=[];
  const runner:Runner=async({job,issue})=>{seen.push(job);return{result:fixtureAnalysis(issue,'triage'),engine:'test'};};
  const w=new Workbench(store,await mkdtemp(join(tmpdir(),'mw-feedback-')),runner,undefined,false);
  const id=w.enqueue([store.issues()[0].id],'triage').created[0];w.pump();await w.drain();await w.review(id,'reject','focus on v2 only');w.retry(id);w.pump();await w.drain();
  assert.equal(seen[1].handoff?.[0].feedback,'focus on v2 only');
  assert.throws(()=>w.enqueue([store.issues()[1].id],'triage',{sourceJobId:seen[1].id}),/同一事项/);await w.close();
});

test('implementation patch is handed into a fresh validation and independent review worktree',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mw-handoff-')),path=join(dir,'repo');await mkdir(path);
  await git(path,['init','-b','main']);await git(path,['remote','add','origin','https://github.com/fixture/queue.git']);await writeFile(join(path,'sum.cjs'),'module.exports=(a,b)=>a-b;\n');await git(path,['add','.']);await git(path,['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','initial']);const sha=await git(path,['rev-parse','HEAD']);
  const store=new Store(':memory:');seedFixture(store);store.put('repos',{...store.repos()[0],headSha:sha,localPath:path});const issue=store.issues()[0];const seen:Job[]=[];
  const runner:Runner=async({job,issue})=>{seen.push(job);if(job.kind==='fix')await writeFile(join(job.worktree!,'sum.cjs'),'module.exports=(a,b)=>a+b;\n');else assert.match(await readFile(join(job.worktree!,'sum.cjs'),'utf8'),/a\+b/);return{result:fixtureAnalysis(issue,job.kind),engine:'test'};};
  const w=new Workbench(store,dir,runner,undefined,false);
  const fix=w.enqueue([issue.id],'fix').created[0];w.pump();await w.drain();assert.equal(store.get<Job>('jobs',fix)?.status,'awaiting_review');
  const validation=w.enqueue([issue.id],'validate',{sourceJobId:fix,instructions:'check addition'}).created[0];w.pump();await w.drain();assert.equal(store.get<Job>('jobs',validation)?.status,'completed', store.get<Job>('jobs',validation)?.error);
  const review=w.enqueue([issue.id],'review',{sourceJobId:validation}).created[0];w.pump();await w.drain();assert.equal(store.get<Job>('jobs',review)?.status,'awaiting_review');
  assert.equal(new Set(seen.map(j=>j.worktree)).size,3);assert.match(await readFile(join(path,'sum.cjs'),'utf8'),/a-b/);await w.close();
});

test('stage schemas reject another stage and review findings are individually decided',async()=>{
  assert.equal(artifactSchemas.review.safeParse(triage()).success,false);
  const store=new Store(':memory:');seedFixture(store);const issue=store.issues()[0];
  const artifact=artifactSchemas.review.parse({schemaVersion:1,stage:'review',summary:'one defect',coverage:'diff',evidence:[],nextSteps:[],responseDraft:'',findings:[{id:'f1',title:'wrong sum',severity:'P1',path:'sum.js',line:1,trigger:'positive inputs',evidence:'subtracts',recommendation:'add'}],verdict:'changes_requested',blockers:[]});
  const w=new Workbench(store,'/tmp/mw-findings',undefined,undefined,false);const id=w.enqueue([issue.id],'triage').created[0];const job=store.get<Job>('jobs',id)!;store.put('jobs',{...job,status:'awaiting_review',artifact,result:asAnalysis(artifact)});
  w.finding(id,'f1','accepted');assert.equal(store.get<Job>('jobs',id)?.findingDecisions?.f1,'accepted');assert.throws(()=>w.finding(id,'missing','resolved'),/不存在/);assert.equal(store.get<Job>('jobs',id)?.status,'awaiting_review');await w.close();
});

test('PR facts preserve unknown CI rather than treating permission failure as green',async()=>{
  const sha='a'.repeat(40);const gh=new GitHub('',async input=>String(input).includes('/check-runs')?new Response('',{status:403}):String(input).includes('/reviews')?Response.json([]):Response.json({head:{sha,ref:'topic',repo:{full_name:'owner/repo'}},base:{sha:'b'.repeat(40),ref:'main'},draft:false,merged:false,mergeable:null}));
  const store=new Store(':memory:');seedFixture(store);const pr=await gh.pullRequest(store.repos()[0],1);assert.equal(pr.checks,null);assert.equal(pr.mergeable,null);assert.ok(pr.warnings.some(s=>s.includes('403')));store.close();
});

test('review publication uses accepted findings and fixed head, recovers lost response without a second review',async()=>{
  const {publish}=await import('../src/core/publish.ts');const savedToken=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='test-placeholder';
  const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue={...store.issues()[0],type:'pr' as const,url:'https://github.com/fixture/queue/pull/128'};
  const artifact=artifactSchemas.review.parse({schemaVersion:1,stage:'review',summary:'review',coverage:'diff',evidence:[],nextSteps:[],responseDraft:'',findings:[{id:'accepted',title:'include this',severity:'P2',path:'a.js',line:1,trigger:'input',evidence:'proof',recommendation:'fix'},{id:'dismissed',title:'exclude this',severity:'P2',path:'b.js',line:1,trigger:'input',evidence:'proof',recommendation:'fix'}],verdict:'changes_requested',blockers:[]});
  const job:Job={id:'review-publish',repoId:repo.id,issueId:issue.id,issueSnapshot:issue,kind:'review',status:'approved',revision:revision(issue,repo,'review'),baseSha:repo.headSha,attempt:1,createdAt:'now',updatedAt:'now',artifact,result:asAnalysis(artifact),findingDecisions:{accepted:'accepted',dismissed:'dismissed'},prContext:{headSha:repo.headSha,baseSha:'b'.repeat(40),headRef:'topic',headRepo:repo.fullName,baseRef:'main',draft:false,merged:false,mergeable:null,checks:null,reviews:[],warnings:[]}};
  store.put('issues',issue);store.put('jobs',job);let posts=0;const rows:any[]=[];
  const gh=new GitHub('',async(input,init)=>{const url=String(input);if(url.endsWith('/pulls/128'))return Response.json({head:{sha:repo.headSha,ref:'topic',repo:{full_name:repo.fullName}},base:{sha:'b'.repeat(40),ref:'main'},draft:false,merged:false,mergeable:null});if(url.endsWith('/issues/128'))return Response.json({updated_at:issue.updatedAt});if(init?.method==='POST'){posts++;const body=JSON.parse(String(init.body));assert.equal(body.commit_id,repo.headSha);assert.equal(body.event,'COMMENT');assert.match(body.body,/include this/);assert.doesNotMatch(body.body,/exclude this/);rows.push({body:body.body,html_url:issue.url+'#review-1'});throw Error('lost response');}return Response.json(rows);});
  try{await assert.rejects(publish(store,job,repo,'review',gh),/写入结果尚未确认/);const urls=await publish(store,store.get<Job>('jobs',job.id)!,repo,'review',gh);assert.equal(posts,1);assert.deepEqual(urls,[issue.url+'#review-1']);}finally{store.close();if(savedToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=savedToken;}
});

test('PR update pushes an approved patch to the existing branch without creating another PR',async()=>{
  const {publish}=await import('../src/core/publish.ts');const dir=await mkdtemp(join(tmpdir(),'mw-update-')),path=join(dir,'repo'),remote=join(dir,'remote.git');await mkdir(path);await git(path,['init','-b','topic']);await git(path,['remote','add','origin','https://github.com/fixture/queue.git']);await writeFile(join(path,'a.txt'),'before\n');await git(path,['add','.']);await git(path,['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','initial']);const base=await git(path,['rev-parse','HEAD']);await git(dir,['init','--bare',remote]);await git(path,['push',remote,'HEAD:refs/heads/topic']);
  const store=new Store(':memory:');seedFixture(store);const repo={...store.repos()[0],localPath:path,headSha:base};const issue={...store.issues()[0],type:'pr' as const,url:'https://github.com/fixture/queue/pull/128'};
  const {prepareWorktree,collectPatch}=await import('../src/core/git.ts');const job:Job={id:'update-local',repoId:repo.id,issueId:issue.id,issueSnapshot:issue,kind:'fix',status:'approved',revision:revision(issue,repo,'fix'),baseSha:base,attempt:1,createdAt:'now',updatedAt:'now',result:fixtureAnalysis(issue,'fix'),prContext:{headSha:base,baseSha:base,headRef:'topic',headRepo:repo.fullName,baseRef:'main',draft:false,merged:false,mergeable:null,checks:null,reviews:[],warnings:[]}};
  const tree=await prepareWorktree(repo,job,dir);job.worktree=tree.path;job.branch=tree.branch;await writeFile(join(tree.path,'a.txt'),'after\n');job.patch=await collectPatch(tree.path,base);store.put('repos',repo);store.put('issues',issue);store.put('jobs',job);
  let head=base;let posts=0;const gh=new GitHub('',async(input,init)=>{if(init?.method==='POST')posts++;const url=String(input);if(url.endsWith('/pulls/128'))return Response.json({head:{sha:head,ref:'topic',repo:{full_name:repo.fullName}},base:{sha:base,ref:'main'},draft:false,merged:false,mergeable:null});if(url.endsWith('/issues/128'))return Response.json({updated_at:issue.updatedAt});return Response.json([]);});
  const savedToken=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='test-placeholder';try{const urls=await publish(store,job,repo,'update_pr',gh,async(cwd,args)=>{assert.deepEqual(args.slice(0,1),['push']);assert.equal(args[2],'HEAD:refs/heads/topic');const out=await git(cwd,['push',remote,args[2]]);head=await git(cwd,['rev-parse','HEAD']);return out;});assert.deepEqual(urls,[issue.url]);assert.notEqual(head,base);assert.equal(await git(remote,['rev-parse','refs/heads/topic']),head);assert.equal(posts,0);}finally{store.close();if(savedToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=savedToken;}
});

test('PR fetch pins the API head, including fork refs, and rejects a concurrent force push',async()=>{
  const {fetchPullRequestRevision}=await import('../src/core/git.ts');const store=new Store(':memory:');seedFixture(store);const repo={...store.repos()[0],localPath:'/fixture'};
  const pr={headSha:'a'.repeat(40),baseSha:'b'.repeat(40),headRef:'topic',headRepo:'someone/fork',baseRef:'main',draft:false,merged:false,mergeable:null,checks:null,reviews:[],warnings:[]};const calls:string[][]=[];
  await fetchPullRequestRevision(repo,7,pr,undefined,async(_,args)=>{calls.push(args);return args[1]==='--is-shallow-repository'?'false':args[0]==='rev-parse'?pr.headSha:'';});assert.deepEqual(calls,[['rev-parse','--is-shallow-repository'],['fetch','origin','refs/pull/7/head'],['rev-parse','FETCH_HEAD'],['fetch','origin',pr.baseSha]]);
  await assert.rejects(fetchPullRequestRevision(repo,7,pr,undefined,async()=> 'c'.repeat(40)),/已更新/);store.close();
});

test('a new PR head can inherit historical review findings but not apply an old patch',async()=>{
  const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0];const issue={...store.issues()[0],type:'pr' as const,headSha:'a'.repeat(40),prBaseSha:'b'.repeat(40)};store.put('issues',issue);
  const w=new Workbench(store,'/tmp/mw-stale-review',undefined,undefined,false);const id=w.enqueue([issue.id],'review').created[0];const old=store.get<Job>('jobs',id)!;store.put('jobs',{...old,status:'awaiting_review',result:fixtureAnalysis(issue,'review'),patch:'historical-patch',findingDecisions:{f1:'accepted'}});store.put('issues',{...issue,headSha:'c'.repeat(40)});
  const next=w.enqueue([issue.id],'review',{sourceJobId:id}).created[0];const handoff=store.get<Job>('jobs',next)?.handoff;assert.equal(handoff?.[0].stale,true);assert.equal(handoff?.[0].findings?.f1,'accepted');assert.notEqual(store.get<Job>('jobs',next)?.revision,old.revision);await w.close();
});

test('preflight can proceed with an evidence gap and no external reply; empty comments never access GitHub', async () => {
  const artifact=artifactSchemas.preflight.parse({schemaVersion:1,stage:'preflight',summary:'可以开始代码审查',coverage:'CI 查询权限不足，状态未知',evidence:[],nextSteps:['审查多仓库任务是否保持数据隔离'],responseDraft:'',intent:'支持多仓库',risks:['核对仓库 A 是否能读取仓库 B 的结果'],readiness:'review',blockers:[]});
  const result=asAnalysis(artifact);assert.equal(result.responseDraft,'');assert.deepEqual(result.missingInfo,[]);assert.deepEqual(result.tests,[]);
  const {publish}=await import('../src/core/publish.ts');
  const store=new Store(':memory:');seedFixture(store);
  const job={id:'empty-comment',status:'approved',result:{...result,responseDraft:'  \n'}} as Job;
  let requests=0;const github={request:async()=>{requests++;throw new Error('must not access network');}} as unknown as GitHub;
  await assert.rejects(publish(store,job,store.repos()[0],'comment',github),/暂无需要发布/);
  assert.equal(requests,0);store.close();
});
