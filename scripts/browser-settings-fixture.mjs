// Exercise the real plugin registration and shared settings UI with a local
// fixture host/API. No personal repository, model call or external GitHub write.
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { modelCatalog } from '../tests/support/model-catalog.ts';
import { fixtureRunner } from '../tests/support/fixtures.ts';
import { handler, localRejection } from '../src/server/http.ts';

const directory = await mkdtemp(join(tmpdir(), 'mw-settings-browser-'));
const result = await build({ stdin: {resolveDir:process.cwd(),loader:'tsx',contents:`
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {apply} from './src/plugin/client.tsx';
  const registrations=[];
  const source={items:[],state:'idle',phase:'ready',error:null},listeners=new Set();
  window.workspaceFixture={path:null,error:'',calls:[]};
  apply({effect:fn=>fn(),uiWorkspace:{openSession(){},pickDirectory:async()=>window.workspaceFixture.path},workspaces:{
    list:{getSnapshot:()=>source,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}},
    create:async({path})=>{if(window.workspaceFixture.error)throw Error(window.workspaceFixture.error);
      window.workspaceFixture.calls.push(path);
      let row=source.items.find(w=>w.path===path);
      if(!row){row={workspaceId:'fixture-'+source.items.length,title:path.split('/').at(-1),path};source.items=[...source.items,row];listeners.forEach(fn=>fn());}
      return row;}
  },slots:{inject:(_name,fn)=>fn(),register:(options,component)=>{registrations.push({options,component});return()=>{};}}});
  window.registrations=registrations.map(r=>({...r.options,label:r.options.label?.()}));
  const page=registrations.find(r=>r.options.name==='settings.section');
  if(!page)throw Error('Native settings section missing');
  createRoot(document.getElementById('root')).render(React.createElement(page.component,{close(){}}));
` }, bundle:true,write:false,format:'esm',loader:{'.css':'text'},define:{'process.env.NODE_ENV':'"production"'} });
const js = result.outputFiles[0].text;
const store = new Store(join(directory, 'state.sqlite'));
const w = new Workbench(store, directory, fixtureRunner, undefined, false, () => ({
  provider:'fixture-host',model:'host-model',agentPreset:'host-preset',adapterRegistered:true,
}), async()=>modelCatalog);
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
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end('<html lang="zh-CN"><body style="margin:0"><div data-shortcut-modal="settings"><nav style="position:fixed;width:188px;height:100%;background:#f5f6f7"><button style="display:flex;gap:8px;padding:9px 12px;border:0;background:transparent"><svg width="16" height="16"><circle cx="8" cy="8" r="5"/></svg>维护工作台</button><button id="unrelated"><svg width="16" height="16"></svg>通用设置</button></nav><main style="margin-left:188px;padding:24px"><div id="root"></div></main></div><script type="module" src="/fixture.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});
try {
  const page=await browser.newPage({viewport:{width:800,height:800}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('同步记录上限（0 表示无上限）').fill('0');
  const entries=await page.evaluate(()=>window.registrations);
  await page.locator('button[data-mw-settings-entry]').waitFor({state:'attached',timeout:2000});
  assert.equal(await page.locator('#unrelated').getAttribute('data-mw-settings-entry'),null);
  assert.equal(await page.locator('button[data-mw-settings-entry]>svg').evaluate(e=>getComputedStyle(e).visibility),'hidden');
  assert.ok(entries.some(r=>r.name==='settings.section'&&r.label === '维护工作台'));
  assert.equal(await page.getByRole('button',{name:'保存设置',exact:true}).count(),0);
  assert.equal(await page.getByText('全局默认设置',{exact:true}).count(),0);
  await expect.poll(()=>store.settings().syncLimit).toBe(0);
  await page.getByRole('switch',{name:'自动快速预检新增或已更新的 PR',exact:true}).check();
  await page.getByRole('button',{name:'执行',exact:true}).click();
  await page.getByLabel('并发任务',{exact:true}).fill('3');
  await expect.poll(()=>store.settings().concurrency).toBe(3);
  await page.reload(); await page.getByRole('button',{name:'执行',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('input[aria-label="并发任务"]')?.value==='3',{},{timeout:2000});
  rejectSave=true;
  await page.getByLabel('并发任务',{exact:true}).fill('4');
  await page.getByRole('alert').filter({hasText:'Fixture save unavailable'}).waitFor();
  assert.equal(await page.getByLabel('并发任务',{exact:true}).inputValue(),'4');
  rejectSave=false;
  await page.getByRole('button',{name:'重试保存',exact:true}).click();
  await page.getByRole('alert').waitFor({state:'hidden'});
  assert.equal(store.settings().concurrency,4);
  w.updateSettings({...store.settings(),concurrency:1});
  await page.getByLabel('并发任务',{exact:true}).fill('2');
  await page.getByRole('alert').waitFor();
  assert.equal(store.settings().concurrency,1,'conflict cannot overwrite a newer revision');
  await page.getByRole('button',{name:'重新加载设置',exact:true}).click();
  await page.getByRole('button',{name:'保留草稿',exact:true}).click();
  assert.equal(await page.getByLabel('并发任务',{exact:true}).inputValue(),'2');
  await page.getByRole('button',{name:'重新加载设置',exact:true}).click();
  await page.getByRole('button',{name:'丢弃草稿并重新加载',exact:true}).click();
  await expect(page.getByLabel('并发任务',{exact:true})).toHaveValue('1');

  await page.getByRole('button',{name:'连接',exact:true}).click();
  assert.equal(await page.getByText('执行环境',{exact:true}).count(),0);
  assert.equal(await page.getByLabel('GitHub Token',{exact:true}).inputValue(),'');
  const status=await page.locator('.mw-auth-status').boundingBox();
  const token=await page.getByLabel('GitHub Token',{exact:true}).boundingBox();
  const saveToken=await page.getByRole('button',{name:'保存',exact:true}).boundingBox();
  assert.ok(status.y<token.y);assert.ok(saveToken.x>token.x+token.width-1);
  await page.screenshot({path:join(directory,'native-settings-connections.png'),fullPage:true});
  await page.getByRole('button',{name:'模型',exact:true}).click();
  await page.getByRole('button',{name:/^默认模型/}).click();
  await page.getByRole('menu',{name:'默认模型选择'}).getByRole('menuitemradio',{name:'Poolside: Laguna S.1 (free)',exact:true}).click();
  await expect.poll(()=>store.settings().nativeDefaultModel?.model).toBe('laguna');
  await page.getByText('高级设置 · 按阶段选择模型',{exact:false}).click();
  await page.getByRole('button',{name:/^代码审查 使用插件默认模型/}).click();
  await page.getByRole('menu',{name:'代码审查选择'}).getByRole('menuitemradio',{name:'DeepSeek-V4-Pro',exact:true}).click();
  await page.getByLabel('代码审查推理等级',{exact:true}).selectOption('high');
  await expect.poll(()=>store.settings().stageModels?.review?.reasoningEffort).toBe('high');
  await page.reload(); await page.getByRole('button',{name:'模型',exact:true}).click();
  await page.getByRole('button',{name:/^默认模型 Poolside/}).waitFor();
  await page.getByRole('button',{name:'工作区',exact:true}).click();
  await page.getByText('暂无保留的任务工作区。',{exact:true}).waitFor();
  const add=page.getByRole('button',{name:'添加工作区',exact:true});
  await add.click();assert.equal(await page.evaluate(()=>window.workspaceFixture.calls.length),0,'cancelled picker does not create workspace');
  await page.evaluate(()=>window.workspaceFixture.path='/fixture/repository');
  await add.click();await page.getByRole('status').filter({hasText:'已添加 repository'}).waitFor();
  await page.getByText('/fixture/repository',{exact:true}).waitFor();
  await add.click();assert.equal(await page.getByText('/fixture/repository',{exact:true}).count(),1,'repeat addition is idempotent');
  await page.evaluate(()=>window.workspaceFixture.error='Fixture directory unavailable');
  await add.click();await page.getByRole('alert').filter({hasText:'Fixture directory unavailable'}).waitFor();
  await page.evaluate(()=>{window.workspaceFixture.error='';window.workspaceFixture.path='/fixture/second';});
  await add.click();await page.getByText('/fixture/second',{exact:true}).waitFor();
  await page.screenshot({path:join(directory,'native-settings-workspaces.png'),fullPage:true});
  await page.getByRole('button',{name:'自动化',exact:true}).click();
  await page.screenshot({path:join(directory,'native-settings-official-light.png'),fullPage:true});
  await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));
  await page.screenshot({path:join(directory,'native-settings-official-dark.png'),fullPage:true});
  const geometry=await page.locator('.mw-global-settings').evaluate(e=>({right:e.getBoundingClientRect().right,width:document.documentElement.clientWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}));
  assert.ok(geometry.right<=geometry.width+1);assert.equal(geometry.overflow,false);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,directory,coverage:['native settings registration and branch icon','debounced autosave and reload','failed autosave draft and retry','default and per-stage model autosave','compact connection layout','workspace add cancel repeat error retry','light dark layouts']}));
} finally {await browser.close();await new Promise(r=>server.close(r));await w.close();}
