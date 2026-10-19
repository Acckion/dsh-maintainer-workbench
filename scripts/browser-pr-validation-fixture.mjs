// Isolated React fixture: no model execution or GitHub writes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const now='2026-10-12T00:00:00Z';
const plan={category:'maintenance',goal:'核对分块边界测试',scope:'只读审查与范围测试',acceptanceCriteria:['范围测试通过'],reproduction:'',expected:'',actual:'',decision:'accepted'};
const issue={id:'fixture#1',repoId:'fixture',number:1,type:'pr',title:'回归用例',state:'open',orchestration:{run:{id:'run',inputKey:'key',planVersion:'1',plan,route:'review',status:'review',currentJobId:'review',completedJobIds:['review'],reason:'源码审查已完成',startedAt:now,deadlineAt:'2026-10-13T00:00:00Z',maxSteps:8}}};
const review={id:'review',kind:'review',issueId:issue.id,repoId:'fixture',issueSnapshot:{...issue,plan},status:'awaiting_review',createdAt:now,artifact:{stage:'review',verdict:'no_findings',blockers:[],findings:[],gaps:[{id:'test',kind:'system_check',status:'not_checked',summary:'范围测试未执行',blocks:['validate'],resolution:'执行范围测试',sources:[]}]}};
const bundle=await build({write:false,bundle:true,format:'iife',jsx:'automatic',stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import {WorkflowCard} from './src/client/WorkflowCard.tsx';
const issue=${JSON.stringify(issue)},review=${JSON.stringify(review)};window.sent=[];
let history=[review];
if(location.search.includes('environment')) {issue.orchestration.run.status='blocked';issue.orchestration.run.currentJobId='validation';issue.orchestration.run.reason='缺少依赖；验证工作区：/fixture/validation';history.push({id:'validation',kind:'validate',status:'waiting_environment',issueId:issue.id,issueSnapshot:review.issueSnapshot});}
createRoot(document.getElementById('root')).render(<WorkflowCard issue={issue} history={history} busy={false} act={async(path,data)=>{window.sent.push({path,data});return {};}}/>);
`}});
const css=await readFile('src/client/styles.css');
const server=createServer((req,res)=>{
 if(req.url.startsWith('/maintainer/api/item-draft')) {res.setHeader('Content-Type','application/json');res.end('{}');}
 else if(req.url==='/client.js') {res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}
 else if(req.url==='/styles.css') {res.setHeader('Content-Type','text/css');res.end(css);}
 else res.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="root" style="max-width:1000px;margin:auto;padding:12px"></div><script src="/client.js"></script></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});await mkdir('artifacts',{recursive:true});
 for(const width of [1440,390]) for(const mode of ['pending','environment']) {
  const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?${mode}`);
  const button=page.getByRole('button',{name:mode==='pending'?'继续工作流，补齐验证':'重新检查环境并继续验证',exact:true});await button.waitFor();
  assert.equal(await page.evaluate(()=>window.sent.length),0);await button.click();
  assert.deepEqual(await page.evaluate(()=>window.sent),[{path:'/workflow/resume',data:{issueId:issue.id,expectedVersion:undefined}}]);
  assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`artifacts/pr-validation-${mode}-${width}.png`,fullPage:true});await page.close();
 }
 console.log('PASS: workflow validation handoff and environment recovery buttons, no independent dispatch, desktop/mobile layout.');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
