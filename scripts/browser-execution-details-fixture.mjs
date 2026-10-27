import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const out='artifacts/video-preparation/recording/acceptance-20261027/execution-details-fix';await mkdir(out,{recursive:true});
const job={id:'fixture',kind:'preflight',status:'completed',createdAt:'2026-10-27T10:00:00Z',revision:'version',baseSha:'base',sessionId:'session',artifact:{stage:'preflight',evidence:[{source:'metadata',detail:'已核对 PR 元数据，源码审查由后续步骤完成。'}]},executionRecords:[{id:'one',tool:'shell',command:'git diff base..head',recordedAt:'2026-10-27T10:01:00Z',checkoutSha:'base',exitCode:0,isError:false,truncated:false,output:'diff --git a/core.ts b/core.ts\n+export const sum = values => values.reduce((a,b) => a+b, 0);'},{id:'two',tool:'shell',command:'npm test',recordedAt:'2026-10-27T10:02:00Z',checkoutSha:'base',exitCode:1,isError:true,truncated:true,output:'FAIL: expected 3, received 2'}]};
const js=(await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import{createRoot}from'react-dom/client';import{StageExecutionDetails}from'./src/client/StageExecutionDetails.tsx';const job=${JSON.stringify(job)};createRoot(document.getElementById('root')).render(<div className="mw"><StageExecutionDetails job={job} audit={[]} tools={null} openEvidence={()=>{}} openSession={()=>{}}/></div>);`},bundle:true,write:false,format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
const css=await readFile('src/client/styles.css','utf8');const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<html><meta charset="utf-8"><style>${css}body{padding:20px;margin:0}.mw{display:block;max-width:900px;margin:auto}</style><div id="root"></div><script type="module">${js}</script></html>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});
 for(const width of [1200,420]){
  const page=await browser.newPage({viewport:{width,height:950}});await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByRole('heading',{name:'运行日志',exact:true})).toHaveCount(0);await expect(page.getByText('暂未收到运行日志。',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'查看完整执行记录',exact:true})).toHaveCount(0);
  await expect(page.getByLabel('选中命令输出',{exact:true})).toContainText('diff --git');
  const fail=page.getByRole('button',{name:'npm test 执行失败',exact:true});await expect(fail).toBeVisible();await fail.click();await expect(page.getByLabel('选中命令输出',{exact:true})).toContainText('FAIL: expected');await expect(page.getByText(/输出已裁剪/).first()).toBeVisible();
  await page.screenshot({path:out+`/commands-${width}.png`,fullPage:true});
  await page.getByRole('tab',{name:'分析依据 · 1',exact:true}).click();await expect(page.getByRole('region',{name:'分析依据阅读器',exact:true})).toBeVisible();
  await page.getByText('技术详情',{exact:true}).click();await expect(page.getByRole('heading',{name:'来源与执行环境',exact:true})).toBeVisible();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.close();
 }
 await writeFile(out+'/browser-result.json',JSON.stringify({passed:true,widths:[1200,420],checks:['empty logs and duplicate entry hidden','commands and saved output visible','failed command and truncation preserved','evidence reader switches without extra disclosure','technical metadata remains accessible','no page overflow'],externalWrites:0},null,2));console.log('execution details UI passed at 1200 and 420px');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
