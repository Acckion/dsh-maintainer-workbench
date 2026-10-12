// Native sidebar DOM contract + real React updates. Isolated data; no Host writes.
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'mw-native-sidebar-'));
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {installSidebarWorkspaceGroups} from './src/plugin/sidebar-workspaces.ts';
const workspaces=[{workspaceId:'foreign',title:'My project',path:'/ordinary'},{workspaceId:'v2',title:'legacy validation retry',path:'/tasks/v2'},{workspaceId:'docs',title:'legacy docs',path:'/tasks/docs'},{workspaceId:'v1',title:'legacy validation',path:'/tasks/v1'}];
const source={getSnapshot:()=>({items:workspaces}),subscribe:()=>()=>{}};
const run=(id,kind,time,status)=>({id,repoId:'tong437/openclaw',issueId:'tong437/openclaw#3',kind,status,createdAt:'2026-10-10T00:00:0'+time+'Z',sessionId:'session-'+id,path:'/tasks/'+id,group:JSON.stringify(['tong437/openclaw','tong437/openclaw#3',kind]),title:'Issue #3 · '+(kind==='docs'?'文档维护':'验证变更')+' · tong437/openclaw'});
const runs=[run('v1','validate',2,'failed'),run('v2','validate',3,'completed'),run('docs','docs',1,'completed')];
window.opened=[];window.menu=[];window.disposed=false;
function Sidebar(){const [expanded,setExpanded]=useState({foreign:true,v1:true,v2:true,docs:true}),[search,setSearch]=useState(false);
 useEffect(()=>{const dispose=installSidebarWorkspaceGroups(source,document,async()=>runs);window.disposeGroups=()=>{dispose();window.disposed=true;};return dispose;},[]);
 return <><button onClick={()=>setSearch(v=>!v)}>搜索视图</button><div className="fixture_list">{workspaces.map(w=>search?<div className="search-row" key={w.workspaceId}>{w.title}</div>:<div className="fixture_groupSection" key={w.workspaceId}>
 <span className="native_tooltip"><div className="fixture_projectRow" data-row-key={'workspace:'+w.workspaceId} role="treeitem" aria-expanded={expanded[w.workspaceId]} draggable onClick={()=>setExpanded(e=>({...e,[w.workspaceId]:!e[w.workspaceId]}))}>
 <span className="fixture_folder">📁</span><span className="fixture_projectText"><span className="fixture_title">{w.title}</span></span><span className="fixture_rowActions"><button onClick={e=>{e.stopPropagation();window.menu.push(w.workspaceId);}}>工作区操作 {w.workspaceId}</button></span></div></span>
 {expanded[w.workspaceId]&&<div className="fixture_sessionRow" data-row-key={'session:session-'+w.workspaceId} role="treeitem" aria-selected="false" onClick={()=>window.opened.push('session-'+w.workspaceId)}><span className="fixture_title">original session {w.workspaceId}</span><button onClick={e=>{e.stopPropagation();window.menu.push('session-'+w.workspaceId);}}>会话菜单 {w.workspaceId}</button></div>}
 </div>)}</div></>;
}
createRoot(document.getElementById('root')).render(<Sidebar/>);
`},bundle:true,write:false,format:'esm',target:'es2022'});
const css=await readFile('src/client/styles.css','utf8');
const server=createServer((req,res)=>{
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].text);return;}
 res.setHeader('Content-Type','text/html');res.end(`<html lang="zh-CN"><head><style>${css}\nbody{margin:0;font-family:system-ui}.sidebar{width:320px;padding:12px;box-sizing:border-box}.fixture_list{display:block}.fixture_groupSection{margin:12px 0}.fixture_projectRow,.fixture_sessionRow{display:flex;align-items:center;gap:8px;height:36px;cursor:pointer}.fixture_projectText,.fixture_sessionRow>.fixture_title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}.fixture_sessionRow{padding-left:24px}.fixture_title{font-size:14px}button{font-size:11px}</style></head><body><aside class="sidebar"><h2>工作区</h2><div id="root"></div></aside><script type="module" src="/fixture.js"></script></body></html>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});
try{for(const width of [1440,390]){
 const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await expect(page.locator('[data-mw-stage-header="leader"]')).toHaveCount(2);
 assert.equal(await page.locator('[data-row-key^="workspace:"]:visible').count(),3);
 const validation=page.getByRole('treeitem',{name:'Issue #3 · 验证变更 · tong437/openclaw',exact:true});
 await expect(page.locator('[data-mw-attempt-title="第 1 次 · 失败"]')).toHaveCount(1);await expect(page.locator('[data-mw-attempt-title="第 2 次 · 已完成"]')).toHaveCount(1);
 await page.locator('[data-row-key="session:session-v1"]').click();assert.deepEqual(await page.evaluate(()=>window.opened),['session-v1']);
 await page.getByRole('button',{name:'会话菜单 v1',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.menu),['session-v1']);
 await validation.click();await expect(page.locator('[data-row-key="session:session-v1"]')).toHaveCount(0);await expect(page.locator('[data-row-key="session:session-v2"]')).toHaveCount(0);
 await validation.focus();await page.keyboard.press('Enter');await expect(page.locator('[data-row-key="session:session-v1"]')).toHaveCount(1);await expect(page.locator('[data-row-key="session:session-v2"]')).toHaveCount(1);
 await page.getByRole('button',{name:'工作区操作 foreign',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.menu),['session-v1','foreign']);
 assert.equal(await page.getByRole('button',{name:'工作区操作 v2',exact:true}).count(),0);
 await page.screenshot({path:join(dir,`native-sidebar-stages-${width}.png`),fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByRole('button',{name:'搜索视图',exact:true}).click();await expect(page.locator('[data-mw-stage-header]')).toHaveCount(0);assert.equal(await page.locator('.search-row').count(),4);
 await page.getByRole('button',{name:'搜索视图',exact:true}).click();await expect(page.locator('[data-mw-stage-header="leader"]')).toHaveCount(2);
 await page.evaluate(()=>window.disposeGroups());await expect(page.locator('[data-mw-stage-header]')).toHaveCount(0);assert.equal(await page.locator('[data-row-key^="workspace:"]:visible').count(),4);assert.deepEqual(errors,[]);
 console.log('Native sidebar stage adapter PASS '+width+'px; screenshots '+dir);await page.close();
}}finally{await browser.close();await new Promise(r=>server.close(r));}
