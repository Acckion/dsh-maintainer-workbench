// Isolated UI fixture: static assets + synthetic metadata. No model or GitHub calls.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
const at='2026-10-19T00:00:00Z';
const item=(number,type,title,classification,labels=[])=>({id:`fixture/repo#${number}`,repoId:'fixture/repo',number,type,title,body:'Fixture',author:'maintainer',labels,state:'open',comments:0,updatedAt:at,url:'',classification:classification?{...classification,revision:'fixture',jobId:`j${number}`,updatedAt:at}:undefined});
const state={repos:[{id:'fixture/repo',fullName:'fixture/repo',mode:'github',defaultBranch:'main',headSha:'abc'}],issues:[
 item(1,'issue','Broken sync',{category:'bug',priority:'P1',labels:['crash']},['Platform:Mac']),
 item(2,'issue','Add export',{category:'feature',priority:'P2',labels:[]}),item(3,'issue','New report',undefined),
 item(4,'pr','Document export',{category:'docs',priority:'P3',labels:['guide']}),item(5,'pr','Fix sync',{category:'bug',priority:'P1',labels:['crash']}),
 item(6,'pr','Changed PR',{category:'feature',priority:'P0',labels:['old'],stale:true}),
 ],jobs:[],audit:[],settings:{concurrency:2,maxJobsPerBatch:20,timeoutMs:600000,maxTokens:6000,autoTriage:false,syncIntervalMinutes:0},capabilities:{harness:false,model:false,github:false,running:0,modelName:'fixture',baseUrl:''},version:'fixture'};
let mutations=0;
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/maintainer/api/')){if(req.method!=='GET')mutations++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/maintainer/api/state'?state:{}));return;}
 const name={'/':'preview.html','/app.js':'app.js','/app.css':'app.css'}[req.url];if(!name){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile(`dist/${name}`));
 }catch{res.statusCode=500;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try { browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH}); } catch(error) { await new Promise(resolve=>server.close(resolve)); throw error; }
const dir='/tmp/maintainer-inbox-filters';await mkdir(dir,{recursive:true});
try{
 for(const width of [1280,480]){
  const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(10000);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);const rows=page.locator('.mw-issue-row');await expect(rows).toHaveCount(3);
  await page.getByRole('button',{name:'展开筛选',exact:true}).click();
  await page.getByLabel('筛选类型',{exact:true}).selectOption('bug');await page.getByLabel('筛选优先级',{exact:true}).selectOption('P1');
  await page.getByRole('checkbox',{name:'Platform:Mac',exact:true}).check();await expect(rows).toHaveCount(1);await expect(rows).toContainText('Broken sync');
  const dialog=page.getByRole('dialog',{name:'筛选问题'});const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1,'filter dialog stays inside viewport');
  await page.screenshot({path:`${dir}/combined-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'清除全部筛选',exact:true}).click();await expect(rows).toHaveCount(3);
  await page.getByLabel('筛选优先级',{exact:true}).selectOption('unset');await expect(rows).toHaveCount(1);await expect(rows).toContainText('New report');
  await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'展开筛选'})).toBeFocused();await page.getByRole('button',{name:'重置',exact:true}).click();
  await page.getByRole('button',{name:'Pull Requests',exact:true}).click();await expect(rows).toHaveCount(3);
  await page.getByRole('button',{name:'展开筛选',exact:true}).click();await page.getByLabel('筛选类型',{exact:true}).selectOption('docs');await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Document export');await expect(rows.locator('[title="本地建议标签，尚未发布到 GitHub"]')).toContainText('guide');
  await page.getByRole('button',{name:'清除全部筛选',exact:true}).click();await page.getByLabel('列表排序',{exact:true}).selectOption('priority');await expect(rows.first()).toContainText('Fix sync');
  await page.getByLabel('筛选分析状态',{exact:true}).selectOption('stale');await expect(rows).toHaveCount(1);await expect(rows).toContainText('Changed PR');await expect(rows).toContainText('分类已过期');
  await page.screenshot({path:`${dir}/stale-pr-${width}.png`,fullPage:true});await page.close();
 }
 assert.equal(mutations,0,'filtering must not enqueue tasks or publish labels');console.log(JSON.stringify({passed:true,widths:[1280,480],modelCalls:0,remoteWrites:0,screenshots:dir}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
