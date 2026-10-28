// Real App navigation with synthetic saved reviews. No model calls or GitHub writes.
import assert from 'node:assert/strict';import{createServer}from'node:http';import{readFile,mkdir,writeFile}from'node:fs/promises';import{chromium,expect}from'@playwright/test';
import{projectTimeline}from'../src/workflow/timeline.ts';import{availableActions}from'../src/workflow/actions.ts';
const at='2026-10-27T13:00:00Z';
const processing={id:'case',workItemId:'fixture/repo#36',repositoryId:'fixture/repo',workflowDefinitionVersion:'maintainer/2',lifecycle:'active',phase:'review',reason:'Saved review',waits:[],activeRunIds:[],currentRunId:'review',sourceFingerprint:'fixture',cycle:1,version:1,createdAt:at,updatedAt:at};
const issue={id:'fixture/repo#36',repoId:'fixture/repo',number:36,type:'pr',title:'Split bill',body:'Scope',author:'a',labels:[],state:'open',headSha:'head',prBaseSha:'base',comments:0,updatedAt:at,url:'https://github.com/fixture/repo/pull/36',processing};
const job={id:'review',issueId:issue.id,repoId:issue.repoId,caseId:'case',issueSnapshot:issue,kind:'review',status:'awaiting_review',attempt:1,revision:'rev',baseSha:'head',createdAt:at,updatedAt:at,prContext:{headSha:'head',baseSha:'base'},artifact:{schemaVersion:1,stage:'review',summary:'分账丢失余数，需要修订',coverage:'Saved source',evidence:[],findings:[{id:'F1',severity:'P1',reproduction:{basis:'reasoned',input:'1000/3',expected:'1000',actual:'999'},title:'分账少一分',path:'money.ts',trigger:'1000/3',evidence:'sum is 999',recommendation:'分配余数'}],gaps:[{id:'protection',kind:'external_wait',summary:'无法读取 main 分支保护规则（GitHub 404）',status:'failed',blocks:[],resolution:'交付前需核对实际门禁。',sources:['PR #36 metadata']}],verdict:'changes_requested',blockers:[],nextSteps:[],responseDraft:'分账少一分，需要修订。'},result:{summary:'分账丢失余数，需要修订',category:'feature',priority:'P2',confidence:0.8,labels:[],missingInfo:[],evidence:[],nextSteps:[],responseDraft:'分账少一分。',tests:[]}};
const out='artifacts/video-preparation/recording/acceptance-20261027/delivery-history-fix';await mkdir(out,{recursive:true});let published=false,writes=0;
processing.currentRunId='repair';processing.phase='fix';published=true;
function snapshot(){const current=published?{...job,status:'approved',publications:{comment:{status:'published',urls:[issue.url+'#issuecomment-1'],at}}}:job;return{repos:[{id:issue.repoId,fullName:'fixture/repo',mode:'github',defaultBranch:'main',headSha:'base'}],issues:[issue],jobs:[current,{...job,id:'repair',kind:'fix',status:'running',sourceJobId:job.id,createdAt:'2026-10-27T14:00:00Z',startedAt:'2026-10-27T14:00:01Z',artifact:undefined,result:undefined}],audit:[],settings:{concurrency:2,maxJobsPerBatch:20,timeoutMs:600000,maxTokens:6000,autoTriage:false,syncIntervalMinutes:0},capabilities:{harness:true,model:true,github:false,running:0,modelName:'fixture'},version:'fixture'};}
const server=createServer(async(req,res)=>{try{if(req.url.startsWith('/maintainer/api/')){if(req.method!=='GET')writes++;res.setHeader('Content-Type','application/json');const state=snapshot();res.end(JSON.stringify(req.url.includes('/processing/timeline?')?projectTimeline(issue,processing,state.jobs,[],availableActions(issue,state.jobs[0],state.jobs)):req.url.includes('/processing?')?{cases:[processing],selected:processing,events:[]}:req.url==='/maintainer/api/state'?state:{}));return;}const file={'/':'preview.html','/app.js':'app.js','/app.css':'app.css'}[req.url];if(!file){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile('dist/'+file));}catch(e){res.writeHead(500);res.end(String(e));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});
 for(const width of [1440,480]) {
 const page=await browser.newPage({viewport:{width,height:1200}});page.setDefaultTimeout(12000);
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:/^Pull Requests(?:\s|$)/}).click();await page.getByRole('button',{name:/Split bill #36/}).click();
 await page.getByRole('button',{name:/^交付与跟踪 ·/}).click();
 const panel=page.getByRole('region',{name:'选中阶段',exact:true});
 const history=panel.getByRole('region',{name:'交付与后续处理时间线',exact:true});
 await expect(history.getByText('PR 评论 · 已发布',{exact:true})).toBeVisible();
 await expect(history.getByText(/执行中/)).toBeVisible();
 await expect(history.getByRole('link',{name:'查看交付结果'})).toBeVisible();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:out+`/history-${width}.png`,fullPage:false});await page.close();
 }
 assert.equal(writes,0);console.log('delivery history passed at 1440 and 480; no writes');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
