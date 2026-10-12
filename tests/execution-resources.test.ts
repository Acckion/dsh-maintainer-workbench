import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {executionResourceGroups} from '../src/client/execution-resources.ts';
import {ExecutionResources} from '../src/client/ExecutionResources.tsx';
import type {Job,Issue} from '../src/core/types.ts';
import type {WorkspaceRecord} from '../src/domain/workspaces.ts';
const issue:Issue={id:'owner/repo#3',repoId:'owner/repo',number:3,title:'Document task',type:'issue',body:'',author:'owner',labels:[],state:'open',comments:0,updatedAt:'2026-10-10',url:''};
const run=(id:string,kind:Job['kind'],time:number):Job=>({id,issueId:issue.id,repoId:issue.repoId,issueSnapshot:issue,kind,status:'completed',attempt:1,createdAt:`2026-10-10T00:00:0${time}Z`,updatedAt:'2026-10-10',revision:'r',baseSha:'base',sessionId:`session-${id}`,worktree:`/worktrees/${id}`});
const workspace=(id:string,ownerRunId:string):WorkspaceRecord=>({id,ownerRunId,repositoryId:issue.repoId,path:`/worktrees/${ownerRunId}`,branch:'branch',checkoutSha:'base',purpose:'fixture',status:'retained',updatedAt:'2026-10-10'});
test('resources aggregate by exact item and owner, retain retry history and lightweight sessions without changing records',()=>{
 const docs=run('docs','docs',1),validate={...run('validate','validate',2),sourceJobId:docs.id},retry={...run('retry','validate',3),status:'failed' as const,sourceJobId:docs.id};
 const light={...run('light','triage',0),worktree:undefined,analysisPath:'/analysis/light'};
 const otherIssue={...issue,id:'another/repo#3',repoId:'another/repo'};
 const other={...run('other','review',4),repoId:otherIssue.repoId,issueId:otherIssue.id,issueSnapshot:otherIssue};
 const jobs=[retry,other,validate,docs,light],workspaces=[workspace('docs-w',docs.id),workspace('validate-w',validate.id),workspace('orphan','missing'),{...workspace('foreign',docs.id),repositoryId:'another/repo'}];
 const before=JSON.stringify({jobs,workspaces});const result=executionResourceGroups(jobs,[issue,otherIssue],workspaces);
 assert.equal(result.groups.length,2);
 const group=result.groups.find(g=>g.issue.id===issue.id)!;
 assert.deepEqual(group.jobs.map(j=>j.id),['light','docs','validate','retry']);
 assert.deepEqual(group.workspaces.map(w=>w.id),['docs-w','validate-w']);
 assert.deepEqual(result.unassigned.map(w=>w.id),['orphan','foreign']);
 assert.equal(JSON.stringify({jobs,workspaces}),before);
});
test('resource rows show human stage/status/source and keep removed directories out of cleanup controls',()=>{
 const docs=run('docs','docs',1),validate={...run('validate','validate',2),sourceJobId:docs.id};
 const html=renderToStaticMarkup(React.createElement(ExecutionResources,{jobs:[validate,docs],workspaces:[{...workspace('docs-w',docs.id),status:'removed'}],openSession:()=>{},openExecution:()=>{},workspaceAction:w=>w.status==='removed'?null:'inspect'}));
 assert.match(html,/文档维护 · 第 1 次/);assert.match(html,/来源：.*文档维护 · 第 1 次/);
 assert.match(html,/目录状态：.*已清理/);assert.match(html,/打开验证变更会话/);assert.match(html,/查看执行记录/);
 assert.match(html,/session-validate/);assert.doesNotMatch(html,/inspect/);
});

test('one stage contains all attempts across retries and cycles while preserving their distinct paths and sessions',()=>{
 const docs={...run('docs','docs',1),caseId:'previous'};
 const first={...run('validate-1','validate',2),status:'failed' as const,caseId:'previous'};
 const retry={...run('validate-2','validate',3),caseId:'current',sourceJobId:docs.id};
 const jobs=[retry,docs,first],before=JSON.stringify(jobs);
 const html=renderToStaticMarkup(React.createElement(ExecutionResources,{jobs,currentCaseId:'current',openSession:()=>{}}));
 assert.equal((html.match(/class="mw-resource-stage"/g) ?? []).length,2);
 assert.match(html,/2 次尝试 · 已完成/);assert.match(html,/验证变更 · 第 2 次/);
 for(const id of ['docs','validate-1','validate-2']) {assert.match(html,new RegExp(`/worktrees/${id}`));assert.match(html,new RegExp(`session-${id}`));}
 assert.match(html,/当前周期/);assert.match(html,/历史周期/);assert.equal(JSON.stringify(jobs),before);
});
