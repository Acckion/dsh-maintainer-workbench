// Local synthetic repository + real API/store. Uses an isolated browser profile; no user data or external writes.
import { chromium, expect } from '@playwright/test';
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
const browser=await chromium.launch({headless:true,args:['--disable-gpu'],executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});
try {
 for(const width of [1440,480]) {
  const dir=await mkdtemp(join(tmpdir(),'maintainer-repository-ui-'));const store=new Store(':memory:');seedFixture(store);
  await git(dir,['init','-b','main']);await writeFile(join(dir,'README.md'),'# Repository\nOld setup instructions.\n');await writeFile(join(dir,'package.json'),JSON.stringify({scripts:{test:'echo fixture'}}));await git(dir,['add','.']);await git(dir,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','initial']);
  const repo={...store.repos()[0],mode:'local',localKind:'git',localPath:dir,headSha:await git(dir,['rev-parse','HEAD'])};store.put('repos',repo);
  let calls=0;const w=new Workbench(store,dir,async input=>{calls++;return fixtureRunner(input);},new GitHub('',async()=>{throw Error('Unexpected network');}),false);
  const auditId=(await w.maintenance.audit(repo.id,['README.md'])).created[0];
  const original=store.get('jobs',auditId);store.put('jobs',{...original,status:'completed',finishedAt:new Date().toISOString(),artifact:{schemaVersion:1,stage:'investigate',summary:'README commands need updating',coverage:'README.md',evidence:[{source:'package.json',detail:'test is declared'}],nextSteps:[],responseDraft:'',facts:[],hypotheses:[],reproduction:'',rootCause:'',impact:'',proposedChanges:[],acceptanceCriteria:[],blockers:[],maintenance:{complete:true,checkedPaths:['README.md'],findings:[{key:'setup-command',domain:'docs',kind:'contradiction',title:'README 启动命令与实际脚本不一致',paths:['README.md'],dependencies:['package.json'],impact:'新用户无法按文档启动',evidence:[{source:'package.json',detail:'test is declared'}],recommendation:'核对并更新 README 命令'}]}}});
  const api=handler(w,localRejection);const server=createServer(async(req,res)=>{if(req.url.startsWith('/maintainer/api'))return api(req,res);const map={'/':['preview.html','text/html'],'/app.js':['app.js','application/javascript'],'/app.css':['app.css','text/css']};const file=map[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file[1]);res.end(await readFile(join(process.cwd(),'dist',file[0])));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(15000);
  try {
   await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Repository',exact:true}).click();
   await page.getByLabel('仓库维护分类',{exact:true}).selectOption('docs');
   await expect(page.getByRole('heading',{name:'README 启动命令与实际脚本不一致',exact:true})).toBeVisible();
   const rowText=page.getByRole('navigation',{name:'仓库文件',exact:true}).locator('.mw-task-row>div').first();
   if(width>760)assert.ok((await rowText.boundingBox()).width>180,'file label retains readable width');
   await page.screenshot({path:join(dir,`repository-findings-${width}.png`),fullPage:true});
   await page.getByLabel('问题处理原因',{exact:true}).fill('本轮暂缓，等待命令确认');await page.getByRole('button',{name:'暂缓',exact:true}).click();
   await page.getByLabel('仓库问题状态',{exact:true}).selectOption('deferred');await expect(page.getByRole('heading',{name:'README 启动命令与实际脚本不一致'})).toBeVisible();
   const list=async()=>{if(width<=760){const back=page.getByRole('button',{name:'返回仓库文件列表',exact:true});if(await back.isVisible())await back.click();}};
   await list();await page.getByRole('navigation',{name:'仓库文件',exact:true}).getByRole('button',{name:/README.md/}).click();await expect(page.getByText('Old setup instructions.',{exact:true})).toBeVisible();
   await page.screenshot({path:join(dir,`repository-content-${width}.png`),fullPage:true});
   await page.reload();await page.getByRole('button',{name:'Repository',exact:true}).click();
   if(width<=760)await page.getByRole('navigation',{name:'仓库文件',exact:true}).getByRole('button',{name:/README.md/}).click();
   await expect(page.getByText('Old setup instructions.',{exact:true})).toBeVisible();
   assert.equal(calls,0,'opening, browsing and reloading must not call a model');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   console.log(JSON.stringify({passed:true,width,modelCalls:calls,screenshots:dir}));
  }catch(e){await page.screenshot({path:join(dir,'failure.png'),fullPage:true});console.error('Evidence:',dir);throw e;}
  finally{await page.close();await new Promise(resolve=>server.close(resolve));await w.close();}
 }
}finally{await browser.close();}
