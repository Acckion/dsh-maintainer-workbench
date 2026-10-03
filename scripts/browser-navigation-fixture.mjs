// Product-level navigation regression: the API is intercepted, never authenticated.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const now = '2026-10-03T00:00:00.000Z';
const issue = (id, repoId, number, title) => ({ id, repoId, number, title, body:'fixture', author:'maintainer', labels:['bug'], state:'open', type:'issue', comments:1, updatedAt:now, url:'' });
const analysis = { summary:'fixture evidence', category:'bug', priority:'P1', confidence:.9, labels:[], missingInfo:[], duplicateOf:null, duplicateReason:'', evidence:[{source:'fixture',detail:'local'}], nextSteps:[], responseDraft:'', tests:[] };
const repo = id => ({ id, fullName:`fixture/${id}`, description:'', defaultBranch:'main', headSha:'abc', localPath:'/tmp', mode:'github', syncedAt:now, syncWarning:null });
const i1=issue('i1','a',1,'Alpha bug'), i2=issue('i2','a',2,'Beta bug');
const job = (id, issueSnapshot, status='awaiting_review') => ({ id, repoId:'a', issueId:issueSnapshot.id, kind:'triage', status, revision:'abc', baseSha:'abc', issueSnapshot, attempt:1, createdAt:now, updatedAt:now, result:analysis });
let snapshot={ repos:[repo('a'),repo('b')], issues:[i1,i2,issue('i3','b',3,'Other')], jobs:[job('task-a',i1),job('task-b',i1),job('task-review',i2,'failed')], audit:[], settings:{concurrency:2,maxJobsPerBatch:3,timeoutMs:1,provider:'',model:'',maxTokens:1,agentPreset:'standard',permissionPreset:'',syncIntervalMinutes:1,autoTriage:false}, capabilities:{harness:false,model:false,github:false,modelName:'fixture',baseUrl:'',running:0}, version:'fixture' };
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH||'/usr/bin/chromium'});
let activePage;
const overallTimeoutMs=Number(process.env.WORKBENCH_TEST_TIMEOUT_MS||45000);
let timeout;
try {
  await Promise.race([(async()=>{ for (const width of [1440,390]) { const page=activePage=await browser.newPage({viewport:{width,height:844}}); page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(10_000); await page.route('**/maintainer/api/**', async route=>{ const url=new URL(route.request().url()); if(url.pathname.endsWith('/state')) return route.fulfill({json:snapshot}); return route.fulfill({json:{created:['task-a'],reused:[],errors:[]}}); }); await page.goto(process.env.WORKBENCH_TEST_URL||'http://127.0.0.1:4317'); await page.getByRole('button',{name:'收件箱'}).click(); await page.getByLabel('搜索问题').fill('Alpha'); const main=page.locator('#mw-main'),issueRow=page.locator('#mw-item-i1'); await issueRow.click(); const scrollTopBefore=await main.evaluate(e=>{ e.scrollTop=30; return e.scrollTop; }); assert.ok(scrollTopBefore>0); await page.getByRole('button',{name:'查看执行记录'}).evaluate(button=>button.click()); await page.getByRole('button',{name:'返回来源列表'}).click(); await issueRow.waitFor(); await page.waitForTimeout(40); assert.equal(await page.getByLabel('搜索问题').inputValue(),'Alpha'); assert.equal(await page.evaluate(()=>document.activeElement?.id),'mw-item-i1'); const scrollTopAfter=await main.evaluate(e=>e.scrollTop); assert.ok(Math.abs(scrollTopAfter-scrollTopBefore)<=2,`scroll position changed from ${scrollTopBefore} to ${scrollTopAfter}`); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); await page.screenshot({path:`/tmp/navigation-fixture-${width}.png`}); await page.close(); activePage=undefined; } })(),new Promise((_,reject)=>{ timeout=setTimeout(()=>reject(new Error(`fixture navigation exceeded ${overallTimeoutMs}ms`)),overallTimeoutMs); })]);
  console.log('fixture navigation: A desktop/mobile PASS');
} catch (error) {
  if (activePage) await activePage.screenshot({path:'/tmp/navigation-fixture-failure.png',fullPage:true}).catch(()=>{});
  console.error(error?.stack||error);
  process.exitCode=1;
} finally { clearTimeout(timeout); await browser.close(); }
