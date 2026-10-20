// Task UI acceptance with isolated metadata and mocked controls; never contacts GitHub or a model.
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
const at='2026-10-20T00:00:00Z';
const item=(number,type,title)=>({id:`fixture/repo#${number}`,repoId:'fixture/repo',number,type,title,body:'Fixture',author:'maintainer',labels:[],state:'open',comments:0,updatedAt:at,url:''});
const issue=item(1,'issue','Issue task'),pr=item(2,'pr','PR task'),archived=item(3,'issue','Archived source');
const decision=item(5,'issue','Confirm Issue goal'),decisionPR=item(6,'pr','Confirm PR goal');
decision.processing={phase:'decision',version:1,waits:[]};decisionPR.processing={phase:'needs_info',version:1,waits:[]};
const record=(id,source,kind,status,extra={})=>({id,issueId:source.id,repoId:source.repoId,issueSnapshot:source,kind,status,attempt:1,revision:'fixture',baseSha:'abc123',createdAt:at,updatedAt:at,...extra});
const common={schemaVersion:1,evidence:[],nextSteps:[],responseDraft:'',coverage:'selected run only'};
const parent=record('run-investigate',issue,'investigate','completed',{artifact:{...common,stage:'investigate',summary:'Historical investigation result',facts:[],hypotheses:[],proposedChanges:[],acceptanceCriteria:[],blockers:[],reproduction:'not confirmed',rootCause:'unknown',impact:'fixture'}});
const fix=record('run-fix',issue,'fix','awaiting_review',{sourceJobId:parent.id,createdAt:'2026-10-20T00:01:00Z',patch:'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+own saved change\n',artifact:{...common,stage:'fix',summary:'Selected fix result',changes:['Updated the requested file'],acceptanceCriteria:[],limitations:[],tests:[]}});
const review=record('run-review',pr,'review','awaiting_review',{artifact:{...common,stage:'review',summary:'Selected PR review result',verdict:'no_findings',findings:[],blockers:[]}});
const running=record('run-active',item(4,'issue','Active task'),'investigate','running');
const snapshot=()=>({repos:[{id:'fixture/repo',fullName:'fixture/repo',mode:'github',defaultBranch:'main',headSha:'abc123'}],issues:[issue,pr,running.issueSnapshot,decision,decisionPR],jobs:[parent,fix,review,running,record('run-archived',archived,'investigate','failed',{error:'Saved failure for archived source'})],audit:[{id:1,jobId:fix.id,at,action:'job.progress',detail:'FIX RUN LOG'},{id:2,jobId:parent.id,at,action:'job.progress',detail:'PARENT RUN LOG'}],settings:{concurrency:2,maxJobsPerBatch:20,timeoutMs:600000,maxTokens:6000,autoTriage:false,syncIntervalMinutes:0},capabilities:{harness:false,model:false,github:false,running:1,modelName:'fixture',baseUrl:''},version:'fixture'});
const mutations=[],requests=[];let state=snapshot();
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/maintainer/api/')){requests.push(req.url);let body='';for await(const chunk of req)body+=chunk;if(req.method!=='GET'){mutations.push({path:req.url,body:body?JSON.parse(body):{}});if(req.url.endsWith('/cancel'))state.jobs=state.jobs.map(j=>j.id===JSON.parse(body).id?{...j,status:'cancelled'}:j);}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/maintainer/api/state'?state:{}));return;}
 const file={'/':'preview.html','/app.js':'app.js','/app.css':'app.css'}[req.url];if(!file){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(`dist/${file}`));
 }catch{res.writeHead(500);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;try{browser=await chromium.launch({headless:true,args:['--disable-gpu'],executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});}catch(e){await new Promise(resolve=>server.close(resolve));throw e;}
const dir='/tmp/maintainer-task-detail';await mkdir(dir,{recursive:true});let page;
try{
 for(const width of [1440,480]){
  state=snapshot();mutations.length=0;requests.length=0;
  page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(10000);page.on('pageerror',error=>console.error(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.getByRole('button',{name:/^Tasks(?:\s|$)/}).click();
  const list=page.locator('#mw-list-tasks'),detail=page.getByRole('complementary',{name:'任务详情',exact:true});
  const pendingDetail=page.getByRole('complementary',{name:'待确认事项详情',exact:true});
  for(const pending of [decision,decisionPR]){
   await page.locator(`[id="mw-decision-${pending.id}"]`).click();
   await expect(page.locator('#mw-main')).toHaveAttribute('data-page','tasks');
   await expect(page.getByRole('button',{name:/^Tasks(?:\s|$)/})).toHaveAttribute('aria-current','page');
   await expect(pendingDetail).toHaveAttribute('data-issue-id',pending.id);
   await expect(pendingDetail.getByRole('heading',{name:pending.title,exact:true})).toBeVisible();
   await expect(detail).toHaveCount(0);
   if(pending.type==='issue')await expect(pendingDetail.getByRole('region',{name:'事项类型与补充信息',exact:true})).toBeVisible();
   if(width>760)await expect(list).toBeVisible();else await expect(list).not.toBeVisible();
   await page.screenshot({path:`${dir}/pending-${pending.type}-${width}.png`,fullPage:true});
   await pendingDetail.getByRole('button',{name:'关闭待确认事项详情',exact:true}).click();
   await expect(list).toBeVisible();await expect(page.locator('#mw-main')).toHaveAttribute('data-page','tasks');
  }
  assert.equal(mutations.length,0,'Selecting pending decisions never starts work or changes the plan');
  await list.getByRole('button',{name:'展开筛选',exact:true}).click();await page.getByLabel('任务状态筛选',{exact:true}).selectOption('all');await page.keyboard.press('Escape');
  await page.getByLabel('搜索任务',{exact:true}).fill('Issue task');await page.locator('#mw-item-run-fix').click();
  await expect(detail).toHaveAttribute('data-job-id','run-fix');await expect(detail.getByText('Selected fix result',{exact:true})).toBeVisible();
  await expect(page.locator('#mw-main')).toHaveAttribute('data-page','tasks');await expect(page.getByRole('region',{name:'事项处理流程',exact:true})).toHaveCount(0);await expect(detail.getByRole('button',{name:'Summary',exact:true})).toHaveCount(0);
  if(width>760)await expect(list).toBeVisible();else await expect(list).not.toBeVisible();
  await detail.getByRole('button',{name:'执行记录',exact:true}).click();await expect(detail.getByText('FIX RUN LOG',{exact:true})).toBeVisible();await expect(detail.getByText('PARENT RUN LOG',{exact:true})).toHaveCount(0);
  await detail.getByRole('button',{name:'文件差异',exact:true}).click();await expect(detail.getByText('+own saved change',{exact:true})).toBeVisible();
  await detail.getByRole('button',{name:'审阅与证据',exact:true}).click();await expect(detail.getByRole('region',{name:'审阅摘要',exact:true})).toBeVisible();
  await page.screenshot({path:`${dir}/evidence-${width}.png`,fullPage:true});
  await detail.getByLabel('选择任务处理步骤',{exact:true}).selectOption('run-investigate');await expect(detail).toHaveAttribute('data-job-id','run-investigate');await expect(detail.getByText('Historical investigation result',{exact:true})).toBeVisible();
  await detail.getByRole('button',{name:'文件差异',exact:true}).click();await expect(detail.getByRole('heading',{name:'本次任务没有保存文件差异',exact:true})).toBeVisible();await expect(detail.getByText('+own saved change',{exact:true})).toHaveCount(0);
  await detail.getByLabel('选择任务处理步骤',{exact:true}).selectOption('run-fix');await expect(detail.getByText('Selected fix result',{exact:true})).toBeVisible();
  const beforeSource=requests.length;assert.equal(mutations.length,0,'Opening task details must never dispatch or publish');assert.ok(!requests.slice(0,beforeSource).some(path=>/\/detail|\/files|\/activity|\/comments/.test(path)),'Task selection does not fetch GitHub Issue/PR reader sections');
  await detail.getByRole('button',{name:'查看关联 Issue #1',exact:true}).click();await expect(page.locator('#mw-main')).toHaveAttribute('data-page','inbox');await page.getByRole('button',{name:'返回来源列表',exact:true}).click();if(width<=760){await expect(list).toBeVisible();await page.locator('#mw-item-run-fix').click();}await expect(detail).toHaveAttribute('data-job-id','run-fix');
  await detail.getByRole('button',{name:'关闭任务详情',exact:true}).click();await expect(list).toBeVisible();await expect(page.getByLabel('搜索任务',{exact:true})).toHaveValue('Issue task');
  await page.getByLabel('搜索任务',{exact:true}).fill('PR task');await page.locator('#mw-item-run-review').click();await expect(detail.getByText('Selected PR review result',{exact:true})).toBeVisible();await expect(detail.getByRole('button',{name:'查看关联 PR #2',exact:true})).toBeVisible();await expect(page.locator('#mw-main')).toHaveAttribute('data-page','tasks');
  await detail.getByRole('button',{name:'关闭任务详情',exact:true}).click();await page.getByLabel('搜索任务',{exact:true}).fill('Archived');await page.locator('#mw-item-run-archived').click();await expect(detail.getByText('Saved failure for archived source',{exact:true})).toBeVisible();await expect(detail.getByRole('button',{name:/查看关联/})).toHaveCount(0);
  await detail.getByRole('button',{name:'关闭任务详情',exact:true}).click();await page.getByLabel('搜索任务',{exact:true}).fill('Active');await page.locator('#mw-item-run-active').click();await expect(detail).toHaveAttribute('data-job-id','run-active');await detail.getByRole('button',{name:'停止任务',exact:true}).click();await expect(detail.getByText('任务已停止',{exact:true})).toBeVisible();assert.deepEqual(mutations.map(m=>[m.path,m.body.id]),[['/maintainer/api/cancel','run-active']]);
  await page.screenshot({path:`${dir}/selected-task-${width}.png`,fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.close();console.log(JSON.stringify({passed:true,width,modelCalls:0,screenshots:dir}));
 }
}catch(e){if(page&&!page.isClosed())await page.screenshot({path:`${dir}/failure.png`,fullPage:true});throw e;}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
