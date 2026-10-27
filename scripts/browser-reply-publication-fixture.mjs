// Real reply editor + HTTP publication service + SQLite; GitHub is a local fetch fixture.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {Store} from '../src/core/store.ts';
import {Workbench} from '../src/core/workbench.ts';
import {GitHub} from '../src/core/github.ts';
import {handler,localRejection} from '../src/server/http.ts';
import {seedFixture,fixtureAnalysis} from '../tests/support/fixtures.ts';
const out='artifacts/video-preparation/recording/acceptance-20261027/reply-publication-20261027';await mkdir(out,{recursive:true});
const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue=store.issues()[0];
let attempts=0,comments=[],permissionDenied=true;
const github=new GitHub('fixture',async(input,init)=>{
 const url=String(input);
 if(init?.method==='POST'){
  attempts++;if(permissionDenied)return Response.json({message:'Resource not accessible by integration'},{status:403});
  const body=JSON.parse(String(init.body)).body;const row={body,html_url:`https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-fixture`};comments.push(row);return Response.json(row);
 }
 if(url.includes('/comments?'))return Response.json(comments);
 if(url.includes('/commits/'))return Response.json({sha:repo.headSha});
 if(url.endsWith(`/issues/${issue.number}`))return Response.json({updated_at:issue.updatedAt});
 throw Error('Unexpected fixture URL '+url);
});
const wb=new Workbench(store,'/tmp/mw-reply-publication',undefined,github,false);
const id=wb.enqueue([issue.id],'investigate').created[0];
store.put('jobs',{...store.get('jobs',id),status:'completed',result:{...fixtureAnalysis(issue,'investigate'),summary:'已核对本次修改，仍需维护者确认范围。',responseDraft:''}});
await wb.review(id,'approve','fixture only');
const job=store.get('jobs',id);const savedToken=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN='fixture';
const js=(await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ReplyPublication} from './src/client/ReplyPublication.tsx';const job=${JSON.stringify(job)};createRoot(document.getElementById('root')).render(<div className="mw"><ReplyPublication direct={location.search.includes("direct=1")} job={job} repository=${JSON.stringify(repo.fullName)} close={()=>{}} published={async()=>{}}/></div>);`},bundle:true,write:false,format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
const css=await readFile('src/client/styles.css','utf8');const serveApi=handler(wb,localRejection);
const server=createServer((req,res)=>{if(req.url?.startsWith('/maintainer/api'))return void serveApi(req,res);res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script type="module">${js}</script></html>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});const page=await browser.newPage({viewport:{width:1200,height:1000}});await page.goto(`http://127.0.0.1:${server.address().port}`);
 if(process.env.DIRECT_ONLY==='1'){
 permissionDenied=false;await page.goto(`http://127.0.0.1:${server.address().port}/?direct=1`);
 await expect(page.getByRole('heading',{name:'回复已发布',exact:true})).toBeVisible();assert.equal(comments.length,1);assert.equal(attempts,1);
 await page.screenshot({path:out+'/direct-published-fixture.png',fullPage:true});
 const result={fixtureOnly:true,externalWrites:0,directEntry:true,simulatedPostAttempts:attempts,simulatedComments:comments.length};await writeFile(out+'/direct-browser-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }else{
 const body=page.getByRole('textbox',{name:'回复内容'}),preview=page.getByRole('button',{name:'保存并核对发布预览',exact:true});
 await expect(body).toHaveValue(/已核对本次修改/);assert.equal(attempts,0);
 await body.fill('');await expect(preview).toBeDisabled();
 await page.getByRole('button',{name:'引用审查结论',exact:true}).click();await expect(body).toHaveValue(/已核对本次修改/);
 await body.fill('这是维护者编辑后的回复，保留覆盖范围说明。');await preview.click();await expect(page.getByRole('button',{name:'确认发布以上内容',exact:true})).toBeEnabled();assert.equal(attempts,0);
 assert.equal(store.draft(issue.id).reply,'这是维护者编辑后的回复，保留覆盖范围说明。');
 await body.fill('修改预览后的内容，必须重新核对。');await expect(page.getByRole('button',{name:'确认发布以上内容',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'保存并核对发布预览',exact:true}).click();await page.getByRole('button',{name:'确认发布以上内容',exact:true}).click();
 await expect(page.getByRole('alert').first()).toContainText('GitHub 403');await expect(body).toHaveValue('修改预览后的内容，必须重新核对。');assert.equal(comments.length,0);
 await page.screenshot({path:out+'/permission-error.png',fullPage:true});permissionDenied=false;
 await page.getByRole('button',{name:'重新核对预览',exact:true}).click();await page.getByRole('button',{name:'确认发布以上内容',exact:true}).click();
 await expect(page.getByRole('heading',{name:'回复已发布',exact:true})).toBeVisible();assert.equal(comments.length,1);assert.ok(comments[0].body.includes('修改预览后的内容，必须重新核对。'));
 await page.screenshot({path:out+'/published-fixture.png',fullPage:true});
 await page.goto(`http://127.0.0.1:${server.address().port}/?direct=1`);
 await expect(page.getByRole('heading',{name:'回复已发布',exact:true})).toBeVisible();assert.equal(comments.length,1);assert.equal(attempts,2);

 const result={fixtureOnly:true,externalWrites:0,modelCalls:0,checks:['empty report draft opens editable composer','empty text cannot preview','quote accepted report explicitly','preview performs no post','edited text invalidates preview','permission error remains visible and preserves edits','retry after readonly recheck posts once and shows receipt','direct entry automatically checks and reconciles receipt without extra click or duplicate'],simulatedPostAttempts:attempts,simulatedComments:comments.length};await writeFile(out+'/browser-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
}finally{await browser?.close();await new Promise(r=>server.close(r));await wb.close();if(savedToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=savedToken;}
