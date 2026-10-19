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
  store.put('issues',{...store.issues()[0],id:repo.id+'#42',number:42,type:'pr',title:'Expose export API',headSha:repo.headSha,prBaseSha:repo.headSha});
  let calls=0;const w=new Workbench(store,dir,async input=>{calls++;return fixtureRunner(input);},new GitHub('',async()=>{throw Error('Unexpected network');}),false);
  const auditId=(await w.maintenance.audit(repo.id,['README.md'])).created[0];
  const original=store.get('jobs',auditId);store.put('jobs',{...original,status:'completed',finishedAt:new Date().toISOString(),artifact:{schemaVersion:1,stage:'investigate',summary:'README commands need updating',coverage:'README.md',evidence:[{source:'package.json',detail:'test is declared'}],nextSteps:[],responseDraft:'',facts:[],hypotheses:[],reproduction:'',rootCause:'',impact:'',proposedChanges:[],acceptanceCriteria:[],blockers:[],maintenance:{complete:true,checkedPaths:['README.md'],documents:[{path:'README.md',role:'安装与使用入口',audience:'用户与贡献者',authority:'current',relatedPaths:['package.json']}],findings:[{key:'setup-command',domain:'docs',kind:'contradiction',title:'README 启动命令与实际脚本不一致',paths:['README.md'],dependencies:['package.json'],impact:'新用户无法按文档启动',evidence:[{source:'package.json',detail:'test is declared'}],recommendation:'核对并更新 README 命令'}]}}});
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
   await list();await page.getByRole('navigation',{name:'仓库文件',exact:true}).getByRole('button',{name:/README.md/}).click();await expect(page.getByText('Old setup instructions.',{exact:true})).toBeVisible();await expect(page.getByText(/读者：用户与贡献者/)).toBeVisible();
   await page.screenshot({path:join(dir,`repository-content-${width}.png`),fullPage:true});
   await page.reload();await page.getByRole('button',{name:'Repository',exact:true}).click();
   if(width<=760)await page.getByRole('navigation',{name:'仓库文件',exact:true}).getByRole('button',{name:/README.md/}).click();
   await expect(page.getByText('Old setup instructions.',{exact:true})).toBeVisible();
   assert.equal(calls,0,'opening, browsing and reloading must not call a model');
   await page.getByRole('button',{name:'准备文档修改',exact:true}).click();
   await page.getByLabel('维护目标',{exact:true}).fill('补齐 README 使用说明');
   await page.getByLabel('维护补充要求',{exact:true}).fill('保留原有说明');
   await page.getByRole('region',{name:'仓库修改计划'}).getByRole('button',{name:'返回',exact:true}).click();
   await page.getByRole('button',{name:'准备文档修改',exact:true}).click();await expect(page.getByLabel('维护补充要求',{exact:true})).toHaveValue('保留原有说明');
   await page.getByRole('button',{name:'准备计划预览',exact:true}).click();await page.getByRole('button',{name:'确认范围并连续执行',exact:true}).waitFor();
   await page.screenshot({path:join(dir,`repository-plan-${width}.png`),fullPage:true});
   await page.getByRole('button',{name:'确认范围并连续执行',exact:true}).click();await page.getByRole('button',{name:'取消任务',exact:true}).click();
   await expect(page.getByText('已取消',{exact:true})).toBeVisible();assert.equal(calls,0,'queuing and cancellation do not run a model in this manual fixture');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.getByRole('button',{name:/^Pull Requests/}).click();await page.locator('.mw-issue-row').filter({hasText:'Expose export API'}).click();
   await page.getByRole('button',{name:'检查文档影响',exact:true}).click();
   if(width<=760)await page.getByRole('button',{name:'返回仓库文件列表',exact:true}).click();
   await expect(page.getByLabel('仓库检查来源',{exact:true})).toHaveValue(repo.id+'#42');assert.equal(calls,0,'PR handoff only selects context; it must not call the model');
   await page.screenshot({path:join(dir,`repository-pr-${width}.png`),fullPage:true});
   const category=page.getByLabel('仓库维护分类',{exact:true}),source=page.getByLabel('仓库检查来源',{exact:true});
   for(const value of ['overview','docs','agents','ci'])assert.equal(await category.locator(`option[value="${value}"]`).isEnabled(),true,'Every category stays selectable from PR context');
   await page.getByRole('complementary',{name:'仓库文件与问题'}).getByRole('button',{name:/^文档 /}).click();
   await list();await expect(source).toHaveValue(repo.id+'#42');
   await category.selectOption('agents');await expect(page.getByRole('button',{name:'更新 Agent 指引',exact:true})).toBeVisible();
   await expect(page.getByText('已切换到当前仓库；PR 来源目前用于文档影响检查与同步。',{exact:true})).toBeVisible();
   await list();await expect(source).toHaveValue('');
   await category.selectOption('ci');await expect(page.getByRole('button',{name:'配置或修复 CI',exact:true})).toBeVisible();
   await list();await category.selectOption('overview');await expect(page.getByRole('heading',{name:'仓库识别',exact:true})).toBeVisible();
   await page.getByRole('button',{name:/^Tasks/}).click();await page.getByRole('button',{name:'Repository',exact:true}).click();
   await expect(category).toHaveValue('overview');await expect(source).toHaveValue('');
   await source.selectOption(repo.id+'#42');
   await list();await expect(category).toHaveValue('docs');
   await page.reload();await page.getByRole('button',{name:'Repository',exact:true}).click();
   await expect(source).toHaveValue(repo.id+'#42');await category.selectOption('ci');
   await expect(page.getByRole('button',{name:'配置或修复 CI',exact:true})).toBeVisible();
   await page.screenshot({path:join(dir,`repository-category-switch-${width}.png`),fullPage:true});
   assert.equal(calls,0,'Switching categories and restoring PR context never calls a model');

   console.log(JSON.stringify({passed:true,width,modelCalls:calls,screenshots:dir}));
  }catch(e){await page.screenshot({path:join(dir,'failure.png'),fullPage:true});console.error('Evidence:',dir);throw e;}
  finally{await page.close();await new Promise(resolve=>server.close(resolve));await w.close();}
 }
}finally{await browser.close();}
