// Isolated real API/SQLite + React form. No model calls or external writes.
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../src/core/store.ts';
import {Workbench} from '../src/core/workbench.ts';
import {artifactSchemas,asAnalysis} from '../src/core/artifacts.ts';
import {handler,localRejection} from '../src/server/http.ts';
import {seedFixture} from '../tests/support/fixtures.ts';
const dir=await mkdtemp(join(tmpdir(),'mw-gaps-browser-'));
const store=new Store(join(dir,'fixture.sqlite'));seedFixture(store);
const wb=new Workbench(store,dir,async()=>{throw Error('No model calls');},undefined,false);
const original=store.issues()[0];
const plan={category:'bug',goal:'整理启动失败资料和追问草稿',scope:'仅只读查阅，不修改文件、不实施修复',reproduction:'尚未提供，无法复现',expected:'正常启动',actual:'偶尔失败',acceptanceCriteria:['生成追问草稿，不发布'],decision:'accepted'};
store.put('issues',{...original,plan});
const wait=wb.processing.requestInput(original.id,{reason:'调查记录已保存，等待失败机器的资料',fields:[{id:'version',question:'失败机器的版本是什么？',purpose:'information',actor:'reporter'},{id:'logs',question:'失败日志是什么？',purpose:'information',actor:'reporter'},{id:'comparison',question:'可选成功对比？',purpose:'information',actor:'reporter',required:false}]});
const css=await readFile('src/client/styles.css','utf8');
const appJs=await readFile('dist/app.js');const appCss=await readFile('dist/app.css');
const bundle=await build({stdin:{loader:'tsx',resolveDir:process.cwd(),contents:`
import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {GapSummary} from './src/client/GapSummary.tsx';import {ProcessingInput} from './src/client/ProcessingInput.tsx';import {IssuePlanning} from './src/client/IssuePlanning.tsx';
const gaps=[{id:'read',kind:'system_check',summary:'核对启动文档',status:'not_checked',blocks:['investigate'],resolution:'',sources:[]},{id:'log',kind:'reporter_information',summary:'失败机器的日志未知',status:'unknown',blocks:['fix'],resolution:'报告者提供日志',sources:[]},{id:'decision',kind:'maintainer_decision',summary:'是否允许修改启动模块',status:'unknown',blocks:['fix'],resolution:'只读调查完成后确认实施计划',sources:[]}];
async function load(){const state=await (await fetch('/maintainer/api/state')).json();return {issue:state.issues.find(i=>i.id===${JSON.stringify(original.id)}),jobs:state.jobs};}
function Fixture(){const [issue,setIssue]=useState(${JSON.stringify(store.issues()[0])});const [jobs,setJobs]=useState([]);function restore(state){setIssue(state.issue);setJobs(state.jobs);}useEffect(()=>{void load().then(restore);},[]);async function act(path,data){const res=await fetch('/maintainer/api'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await res.json();if(!res.ok)throw Error(result.error);restore(await load());return result;}
return <main className="mw mw-shell" style={{padding:20,display:'block',maxWidth:900}}><h1>缺口与人工补充（隔离测试）</h1><GapSummary plan={{gaps}}/><ProcessingInput issue={issue} busy={false} act={act}/><IssuePlanning key={issue.processing?.id} issue={issue} busy={false} act={act} start={async()=>{throw Error('Must not execute');}}/></main>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`},bundle:true,write:false,format:'esm'});
const api=handler(wb,localRejection);const server=createServer((req,res)=>{
 if(req.url?.startsWith('/maintainer/api')){void api(req,res);return;}
 if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(appJs);return;}
 if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(appCss);return;}
 if(req.url==='/app'){res.setHeader('Content-Type','text/html');res.end('<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');return;}
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
 res.setHeader('Content-Type','text/html');res.end(`<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nbody{margin:0;font-family:system-ui}select,textarea{max-width:100%;box-sizing:border-box}.mw-gap-summary p{overflow-wrap:anywhere}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});
try{for(const width of [1440,390]){
 // A fresh wait for each viewport; keep this fixture isolated from user records.
 if(width===390){for(const job of store.jobs())store.put('jobs',{...job,status:'cancelled'});store.put('issues',{...original,plan});wb.processing.requestInput(original.id,{reason:'等待报告者资料',fields:[{id:'version',question:'失败机器的版本是什么？',purpose:'information',actor:'reporter'},{id:'logs',question:'失败日志是什么？',purpose:'information',actor:'reporter'},{id:'comparison',question:'可选成功对比？',required:false}]});}
 // Exercise the real App plan view, not just the standalone form. Navigation must not submit input or start jobs.
 const planPage=await browser.newPage({viewport:{width,height:1000}});
 await planPage.goto(`http://127.0.0.1:${server.address().port}/app`);
 await planPage.locator('[aria-label="选择仓库"]:visible, .mw-mobile-repo select:visible').first().selectOption(original.repoId);
 await planPage.locator('[id="mw-item-'+original.id+'"]').click();
 await planPage.getByRole('tab',{name:'处理计划',exact:true}).click();
 await expect(planPage.getByRole('button',{name:'保存资料与未解决项',exact:true})).toBeVisible();
 await expect(planPage.getByRole('button',{name:'保存资料与未解决项',exact:true})).toHaveCount(1);
 await planPage.screenshot({path:join(dir,`plan-input-${width}.png`),fullPage:true});
 assert.equal(store.processing.current(original.id).waits.at(-1).answers,undefined);
 await planPage.close();
 const initialJobs=store.jobs().length;const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 await expect(page.getByText('系统待检查',{exact:true})).toBeVisible();await expect(page.getByText(/解除条件尚未明确，不能据此判定缺口已解决/)).toBeVisible();await expect(page.getByText('等待报告者资料',{exact:true}).first()).toBeVisible();
 await page.getByLabel('失败机器的版本是什么？',{exact:true}).fill('v1.2.3');
 await page.getByLabel('失败日志是什么？资料状态',{exact:true}).selectOption('unknown');
 await page.getByRole('button',{name:'保存资料与未解决项',exact:true}).click();
 await expect.poll(()=>store.processing.current(original.id).waits.at(-1).answers?.version.value).toBe('v1.2.3');
 assert.equal(store.processing.current(original.id).waits.at(-1).state,'open');
 await page.reload();await expect(page.getByLabel('失败机器的版本是什么？',{exact:true})).toHaveValue('v1.2.3');await expect(page.getByLabel('失败日志是什么？资料状态',{exact:true})).toHaveValue('unknown');
 await expect(page.getByRole('button',{name:'确认并开始只读调查',exact:true})).toBeVisible();
 await page.screenshot({path:join(dir,`gaps-input-${width}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByLabel('失败日志是什么？资料状态',{exact:true}).selectOption('provided');await page.getByLabel('失败日志是什么？',{exact:true}).fill('exit=1; unable to open configuration');await page.getByRole('button',{name:'保存资料与未解决项',exact:true}).click();
 await expect.poll(()=>store.processing.current(original.id).waits.at(-1).state).toBe('satisfied');assert.deepEqual(store.issues().find(i=>i.id===original.id).plan,plan);assert.equal(store.jobs().length,initialJobs);assert.deepEqual(errors,[]);await expect(page.getByRole('button',{name:'重新分析，生成新草稿',exact:true})).toHaveCount(0);await page.screenshot({path:join(dir,`gaps-${width}.png`),fullPage:true});await page.close();
 // Replay completed Agent triage with a system-check gap ID in legacy missingInfo.
 const number=width===1440?141:142;
 const systemIssue={...original,processing:undefined,orchestration:undefined,plan:undefined,id:`${original.repoId}#${number}`,number,title:'shell: Unix socket advisory scan（回归测试）'};
 store.put('issues',systemIssue);
 const sourceId=wb.enqueue([systemIssue.id],'triage').created[0];
 const source=store.get('jobs',sourceId);
 const systemReport=artifactSchemas.triage.parse({schemaVersion:1,stage:'triage',summary:'评论称 dev 已修复，需 Agent 读取当前源码核实',coverage:'仅完成元数据分诊',evidence:[],nextSteps:[],responseDraft:'',category:'bug',priority:'P2',labels:[],module:'core/shell',impact:'Unix socket 命令无法执行',missingInfo:['g1'],duplicateOf:null,duplicateReason:'',route:'needs_info',routeReason:'尚未检查源码',
   gaps:[{id:'g1',kind:'system_check',summary:'评论结论尚未经过源码核实',status:'not_checked',blocks:['investigate'],resolution:'Agent 读取 parse.ts 和 file-access.ts 并核对当前版本',sources:['issue:comment:3']}],
   planDraft:{category:'bug',goal:'核实 Unix socket advisory scan 的当前行为',scope:'只读检查 shell 源码，不修改代码',reproduction:'',expected:'',actual:'',acceptanceCriteria:['保存源码判断依据'],route:'investigate',sources:[],missingInfo:[]}});
 store.put('jobs',{...source,status:'completed',artifact:systemReport,result:asAnalysis(systemReport)});
 wb.orchestration.completed(store.get('jobs',sourceId));
 const handoffPage=await browser.newPage({viewport:{width,height:1000}});const handoffErrors=[];handoffPage.on('pageerror',e=>handoffErrors.push(e.message));
 await handoffPage.goto(`http://127.0.0.1:${server.address().port}/app`);
 await handoffPage.locator('[aria-label="选择仓库"]:visible, .mw-mobile-repo select:visible').first().selectOption(original.repoId);
 await handoffPage.locator(`[id="mw-item-${systemIssue.id}"]`).click();
 const flow=handoffPage.getByRole('region',{name:'事项处理流程',exact:true});
 await expect(flow.getByText('系统待检查',{exact:true})).toBeVisible();
 await flow.getByRole('navigation',{name:'处理阶段'}).getByRole('button',{name:/^定位与范围/}).click();
 const start=flow.getByRole('button',{name:'开始调查',exact:true});await expect(start).toBeEnabled();
 await expect(flow.getByRole('textbox',{name:'用户补充信息',exact:true})).toHaveCount(0);
 const dispatch=handoffPage.waitForResponse(r=>r.url().endsWith('/jobs') && r.request().method()==='POST');
 await start.click();const dispatched=await dispatch;assert.equal(dispatched.status(),200);
 const childId=(await dispatched.json()).created[0];const child=store.get('jobs',childId);
 assert.equal(child.kind,'investigate');assert.equal(child.sourceJobId,sourceId);
 assert.equal(child.handoff.find(h=>h.id===sourceId).artifact.gaps[0].kind,'system_check');
 assert.equal(store.get('jobs',sourceId).artifact.gaps[0].status,'not_checked');
 assert.equal(store.processing.current(systemIssue.id).waits.some(w=>w.type==='user_input' && w.state==='open'),false);
 await expect(flow.getByRole('region',{name:'处理进度',exact:true})).toContainText('等待执行');
 await handoffPage.screenshot({path:join(dir,`system-gap-handoff-${width}.png`),fullPage:true});
 assert.deepEqual(handoffErrors,[]);await handoffPage.close();
 console.log(`Gaps input fixture PASS ${width}px; screenshots ${dir}`);
}}finally{await browser.close();await new Promise(r=>server.close(r));await wb.close();}
