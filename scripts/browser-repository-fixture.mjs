// Repository UI + real API/store; synthetic local Git workspace and scripted Agent only.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { git } from '../src/core/git.ts';
import { handler, localRejection } from '../src/server/http.ts';
import { seedFixture, fixtureRunner } from '../tests/support/fixtures.ts';
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});
try {
 for(const width of [1440,390]) {
  const dir=await mkdtemp(join(tmpdir(),'maintainer-repository-ui-'));const store=new Store(':memory:');seedFixture(store);
  await git(dir,['init','-b','main']);await writeFile(join(dir,'README.md'),'# Test repository\n');await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','initial']);
  const repo={...store.repos()[0],mode:'local',localKind:'git',localPath:dir,headSha:await git(dir,['rev-parse','HEAD']),profile:{revision:'fixture',scannedAt:new Date().toISOString(),languages:['TypeScript'],roots:['src'],testPaths:['tests'],workflows:['.github/workflows/check.yml'],manifests:['package.json'],commands:[{source:'package.json',command:'npm test'}],sources:[],warnings:[]}};store.put('repos',repo);
  const w=new Workbench(store,dir,fixtureRunner,new GitHub('',async()=>{throw Error('Unexpected network');}),false);
  const auditId=w.organize(repo.id,'audit').created[0];w.pump();await w.drain();assert.equal(store.get('jobs',auditId).status,'completed');
  const original=store.get('jobs',auditId);store.put('jobs',{...original,artifact:{schemaVersion:1,stage:'investigate',summary:'README commands need updating',coverage:'README',evidence:[{source:'package.json',detail:'npm test is declared'}],nextSteps:['Update README'],responseDraft:'',facts:['npm test is declared'],hypotheses:[],reproduction:'',rootCause:'Outdated instructions',impact:'Setup instructions',proposedChanges:['Update README commands'],acceptanceCriteria:['Documented commands match manifests'],blockers:[]}});
  const api=handler(w,localRejection);const server=createServer(async(req,res)=>{if(req.url.startsWith('/maintainer/api'))return api(req,res);const map={'/':['preview.html','text/html'],'/app.js':['app.js','application/javascript'],'/app.css':['app.css','text/css']};const file=map[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file[1]);res.end(await readFile(join(process.cwd(),'dist',file[0])));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(10000);
  try {
   await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Repository',exact:true}).click();
   const choose=async(name)=>{const back=page.getByRole('button',{name:'返回仓库维护列表',exact:true});if(width<=760&&await back.isVisible())await back.click();await page.getByRole('navigation',{name:'仓库整理项目'}).getByRole('button',{name:new RegExp('^'+name)}).click();};
   await choose('检查文档与仓库结构');await page.getByRole('button',{name:'Results',exact:true}).click();await page.getByText('README commands need updating',{exact:true}).waitFor();
   await page.screenshot({path:join(dir,`repository-results-${width}.png`),fullPage:true});
   await page.locator('.mw-repository-actions').last().getByRole('button',{name:'同步与补齐文档',exact:true}).click();
   await page.getByRole('button',{name:'Configure',exact:true}).waitFor();await page.waitForFunction(id=>document.querySelector('select[aria-label="沿用检查报告"]').value===id,auditId);
   await page.getByLabel('本次范围与要求',{exact:true}).fill('README only');
   await page.screenshot({path:join(dir,`repository-configure-${width}.png`),fullPage:true});
   await choose('生成 / 更新 AGENTS.md');await page.getByRole('button',{name:'Configure',exact:true}).click();await page.getByLabel('本次范围与要求',{exact:true}).fill('Keep human guidance');
   await choose('同步与补齐文档');await page.getByRole('button',{name:'Configure',exact:true}).click();assert.equal(await page.getByLabel('本次范围与要求',{exact:true}).inputValue(),'README only');
   await page.getByRole('button',{name:'准备修改',exact:true}).click();await page.getByRole('button',{name:'查看执行与审阅',exact:true}).waitFor();
   assert.equal(await page.locator('#mw-main[data-page="organize"]').count(),1);const docs=store.jobs().find(j=>j.issueSnapshot.organizeMode==='docs');assert.match(docs.instructions,/Saved audit reference/);assert.match(docs.instructions,/README only/);
   await page.getByRole('button',{name:/^History/}).click();await page.locator('.mw-repository-history .mw-task-row').first().click();
   await page.getByRole('button',{name:'取消任务',exact:true}).click();await page.locator('.mw-repository-content').getByText('已取消',{exact:true}).waitFor();
   await choose('配置 / 修复 GitHub CI');await page.getByRole('button',{name:'Configure',exact:true}).click();await page.getByRole('button',{name:'准备修改',exact:true}).click();await page.getByRole('button',{name:'查看执行与审阅',exact:true}).waitFor();
   await page.reload();await page.getByRole('button',{name:'Repository',exact:true}).click();await choose('同步与补齐文档');await page.getByRole('button',{name:'Configure',exact:true}).click();assert.equal(await page.getByLabel('本次范围与要求',{exact:true}).inputValue(),'README only');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(dir,`repository-final-${width}.png`),fullPage:true});
   console.log(`Repository UI PASS ${width}px; screenshots ${dir}`);
  } catch(e) {await page.screenshot({path:join(dir,'failure.png'),fullPage:true});console.error('Evidence:',dir);throw e;}
  finally {await page.close();await new Promise(resolve=>server.close(resolve));await w.close();}
 }
} finally {await browser.close();}
