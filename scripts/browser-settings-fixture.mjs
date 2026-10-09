// Exercise the real plugin registration and shared settings UI with a local
// fixture host/API. No personal repository, model call or external GitHub write.
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { fixtureRunner } from '../tests/support/fixtures.ts';
import { handler, localRejection } from '../src/server/http.ts';

const directory = await mkdtemp(join(tmpdir(), 'mw-settings-browser-'));
const result = await build({ stdin: {resolveDir:process.cwd(),loader:'tsx',contents:`
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {apply} from './src/plugin/client.tsx';
  const registrations=[];
  apply({effect:fn=>fn(),uiWorkspace:{openSession(){}},slots:{
    inject:(_name,fn)=>fn(),register:(options,component)=>{registrations.push({options,component});return()=>{};}
  }});
  window.registrations=registrations.map(r=>({...r.options,label:r.options.label?.()}));
  const page=registrations.find(r=>r.options.name==='settings.section');
  if(!page)throw Error('Native settings section missing');
  createRoot(document.getElementById('root')).render(React.createElement(page.component,{close(){}}));
` }, bundle:true,write:false,format:'esm',loader:{'.css':'text'},define:{'process.env.NODE_ENV':'"production"'} });
const js = result.outputFiles[0].text;
const store = new Store(join(directory, 'state.sqlite'));
const w = new Workbench(store, directory, fixtureRunner, undefined, false, () => ({
  provider:'fixture-host',model:'host-model',agentPreset:'host-preset',adapterRegistered:true,
}));
w.githubConnection = async () => ({authenticated:false,source:'none'});
let rejectSave = false;
const api = handler(w, localRejection);
const server = createServer((req,res) => {
  if(req.url.startsWith('/maintainer/api')) {
    if(rejectSave && req.method==='POST' && req.url.endsWith('/settings/global')) {
      res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Fixture save unavailable'}));return;
    }
    return api(req,res);
  }
  if(req.url==='/fixture.js'){res.setHeader('Content-Type','application/javascript');res.end(js);return;}
  res.setHeader('Content-Type','text/html');
  res.end('<html lang="zh-CN"><body style="margin:0"><aside style="position:fixed;width:188px;height:100%;background:#eee">Harness Settings</aside><main style="margin-left:188px;padding:24px"><div id="root"></div></main><script type="module" src="/fixture.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});
try {
  const page=await browser.newPage({viewport:{width:800,height:800}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('同步记录上限（0 表示无上限）').fill('0');
  const entries=await page.evaluate(()=>window.registrations);
  assert.ok(entries.some(r=>r.name==='settings.section'&&r.label === '维护工作台'));
  await page.getByLabel('自动快速预检新增或已更新的 PR').check();
  await page.getByRole('button',{name:'执行',exact:true}).click();
  await page.getByLabel('并发任务',{exact:true}).fill('3');
  await page.getByRole('button',{name:'自动化',exact:true}).click();
  assert.equal(await page.getByLabel('同步记录上限（0 表示无上限）').inputValue(),'0','tab switch retains draft');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.getByRole('status').filter({hasText:'设置已保存'}).waitFor();
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.getByText('全局默认设置',{exact:true}).waitFor();
  assert.equal(await page.getByText('有未保存的更改',{exact:true}).count(),0,'saving unchanged settings is clean');
  assert.equal(store.settings().concurrency,3);assert.equal(store.settings().syncLimit,0);assert.equal(store.settings().autoPreflight,true);
  await page.reload();
  assert.equal(await page.getByLabel('同步记录上限（0 表示无上限）').inputValue(),'0','reopen reads saved SQLite settings');
  await page.getByLabel('同步记录上限（0 表示无上限）').fill('123');
  w.updateSettings({...store.settings(),concurrency:4});
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'另一处修改'}).waitFor();
  assert.equal(await page.getByLabel('同步记录上限（0 表示无上限）').inputValue(),'123');
  await page.getByRole('button',{name:'重新加载设置',exact:true}).click();
  await page.getByRole('button',{name:'保留草稿',exact:true}).click();
  assert.equal(await page.getByLabel('同步记录上限（0 表示无上限）').inputValue(),'123');
  await page.getByRole('button',{name:'重新加载设置',exact:true}).click();
  await page.getByRole('button',{name:'丢弃草稿并重新加载',exact:true}).click();
  await page.getByRole('button',{name:'执行',exact:true}).click();
  assert.equal(await page.getByLabel('并发任务',{exact:true}).inputValue(),'4');
  await page.getByRole('button',{name:'自动化',exact:true}).click();
  rejectSave=true;
  await page.getByLabel('同步记录上限（0 表示无上限）').fill('321');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Fixture save unavailable'}).waitFor();
  assert.equal(await page.getByLabel('同步记录上限（0 表示无上限）').inputValue(),'321');
  rejectSave=false;
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.getByRole('status').filter({hasText:'设置已保存'}).waitFor();
  await page.screenshot({path:join(directory,'native-settings-automation.png'),fullPage:true});
  await page.getByRole('button',{name:'连接',exact:true}).click();
  await page.getByText('host-model',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('独立预览 API Key',{exact:true}).count(),0);
  assert.equal(await page.getByLabel('GitHub Token',{exact:true}).inputValue(),'');
  await page.screenshot({path:join(directory,'native-settings-connections.png'),fullPage:true});
  await page.getByRole('button',{name:'工作区',exact:true}).click();
  await page.getByText('暂无保留的任务工作区。',{exact:true}).waitFor();
  const geometry=await page.locator('.mw-global-settings').evaluate(e=>({right:e.getBoundingClientRect().right,width:document.documentElement.clientWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}));
  assert.ok(geometry.right<=geometry.width+1);assert.equal(geometry.overflow,false);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,directory,coverage:['real settings.section registration','save/reopen','draft across tabs','conflict and reload/cancel','failed save recovery','host model inheritance','empty token field','bounded dialog width']}));
} finally {await browser.close();await new Promise(r=>server.close(r));await w.close();}
