// Isolated UI metadata only: no model calls, real repositories, or remote writes.
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
const at='2026-10-20T00:00:00Z';
const item=(number,title)=>({id:`fixture/repo#${number}`,repoId:'fixture/repo',number,type:'issue',title,body:'Fixture',author:'maintainer',labels:[],state:'open',comments:0,updatedAt:at,url:''});
const issues=[item(1,'Needs review'),item(2,'Running investigation'),item(3,'Completed investigation'),item(4,'Failed change'),item(5,'Quick classification'),item(6,'Confirm export scope')];
issues[5].informationRequests=[{id:'input',state:'reply_received'}];
const job=(number,status,kind='investigate')=>({id:`job-${number}`,issueId:issues[number-1].id,repoId:'fixture/repo',issueSnapshot:issues[number-1],kind,status,attempt:1,revision:'fixture',baseSha:'fixture',createdAt:at,updatedAt:at});
const state={repos:[{id:'fixture/repo',fullName:'fixture/repo',mode:'github',defaultBranch:'main',headSha:'fixture'}],issues,jobs:[job(1,'awaiting_review'),job(2,'running'),job(3,'completed'),job(4,'failed','fix'),job(5,'completed','triage')],audit:[],settings:{concurrency:2,maxJobsPerBatch:20,timeoutMs:600000,maxTokens:6000,autoTriage:false,syncIntervalMinutes:0},capabilities:{harness:false,model:false,github:false,running:1,modelName:'fixture',baseUrl:''},version:'fixture'};
let mutations=0;
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/maintainer/api/')){if(req.method!=='GET')mutations++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/maintainer/api/state'?state:{}));return;}
 const file={'/':'preview.html','/app.js':'app.js','/app.css':'app.css'}[req.url];if(!file){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(`dist/${file}`));
 }catch{res.statusCode=500;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;try{browser=await chromium.launch({headless:true,args:['--disable-gpu'],executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});}catch(e){await new Promise(resolve=>server.close(resolve));throw e;}
const dir='/tmp/maintainer-task-filters';await mkdir(dir,{recursive:true});let page;
try{
 for(const width of [1440,480]){
  page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(10000);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.getByRole('button',{name:/^Tasks(?:\s|$)/}).click();
  const list=page.locator('#mw-list-tasks'),rows=list.locator('[id^="mw-item-"]'),decisions=list.locator('.mw-decision-row'),search=page.getByLabel('搜索任务',{exact:true}),filter=list.getByRole('button',{name:'展开筛选',exact:true}),popup=page.getByRole('dialog',{name:'筛选任务',exact:true}),summary=list.locator('.mw-filter-summary');
  await expect(rows).toHaveCount(1);await expect(decisions).toHaveCount(1);await expect(summary).toContainText('1 个任务 · 1 个待确认事项 · 需要我处理');
  await expect(page.getByLabel('任务状态筛选',{exact:true})).toHaveCount(0);
  const a=await search.boundingBox(),b=await filter.boundingBox();assert.ok(Math.abs((a.y+a.height/2)-(b.y+b.height/2))<3,'Search and filter align in one row');
  await search.fill('review');await expect(rows).toHaveCount(1);await expect(decisions).toHaveCount(0);
  await search.fill('export');await expect(rows).toHaveCount(0);await expect(decisions).toHaveCount(1);
  await list.getByRole('button',{name:'重置',exact:true}).click();await expect(search).toHaveValue('');await expect(rows).toHaveCount(4);await expect(decisions).toHaveCount(0);await expect(filter).not.toHaveClass(/active/);
  await filter.click();const status=page.getByLabel('任务状态筛选',{exact:true});await expect(status).toBeFocused();
  const bounds=await popup.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1,'Popover stays inside the viewport');
  await status.selectOption('running');await expect(rows).toHaveCount(1);await expect(rows).toContainText('Running investigation');
  await status.selectOption('completed');await expect(rows).toHaveCount(1);await page.getByRole('checkbox',{name:'包含快速分诊与预检',exact:true}).check();await expect(rows).toHaveCount(2);await expect(filter).toHaveText('2');await expect(summary).toContainText('含快速任务');
  await page.screenshot({path:`${dir}/combined-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'清除全部筛选',exact:true}).click();await expect(status).toHaveValue('all');await expect(rows).toHaveCount(4);await expect(page.getByRole('checkbox',{name:'包含快速分诊与预检',exact:true})).not.toBeChecked();
  await status.selectOption('failed');await expect(rows).toHaveCount(1);await expect(rows).toContainText('Failed change');
  await page.keyboard.press('Escape');await expect(popup).toHaveCount(0);await expect(filter).toBeFocused();
  await search.fill('missing');await expect(rows).toHaveCount(0);await expect(list.getByText('当前筛选下没有任务，可切换筛选或从 Issues 或 Pull Requests 开始处理。',{exact:true})).toBeVisible();
  await list.getByRole('button',{name:'重置',exact:true}).click();await filter.click();await search.click();await expect(popup).toHaveCount(0);
  await search.fill('Running');await expect(rows).toHaveCount(1);await page.getByRole('button',{name:/^Issues/}).click();await page.getByRole('button',{name:/^Tasks(?:\s|$)/}).click();await expect(search).toHaveValue('Running');await expect(rows).toHaveCount(1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${dir}/search-${width}.png`,fullPage:true});await page.close();
 }
 assert.equal(mutations,0,'Searching and filtering must not change data or run tasks');console.log(JSON.stringify({passed:true,widths:[1440,480],modelCalls:0,mutations,screenshots:dir}));
}catch(e){if(page&&!page.isClosed())await page.screenshot({path:`${dir}/failure.png`,fullPage:true});throw e;}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
