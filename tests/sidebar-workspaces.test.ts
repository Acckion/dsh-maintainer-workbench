import test from 'node:test';
import assert from 'node:assert/strict';
import {sidebarRuns} from '../src/domain/sidebar-workspaces.ts';
import {sidebarWorkspaceGroups} from '../src/plugin/sidebar-workspaces.ts';
import {Store} from '../src/core/store.ts';
import {seedFixture} from './support/fixtures.ts';
import type {Job} from '../src/core/types.ts';

test('native sidebar ownership uses saved paths and full item/stage identity, retaining unique attempt ordinals',()=>{
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue=store.issues()[0];
 const job:Job={id:'v1',repoId:repo.id,issueId:issue.id,issueSnapshot:issue,kind:'validate',status:'failed',worktree:'/var/tasks/v1',sessionId:'session-v1',revision:'r',baseSha:'base',attempt:1,createdAt:'2026-10-10T00:00:01Z',updatedAt:''};
 const jobs=[{...job,id:'v2',worktree:'/var/tasks/v2',sessionId:'session-v2',createdAt:'2026-10-10T00:00:02Z'},job,{...job,id:'review',kind:'review' as const,worktree:'/var/tasks/review'},{...job,id:'foreign',repoId:'foreign/repo',issueId:'foreign/repo#128',worktree:'/var/tasks/foreign'}];
 const rows=sidebarRuns(jobs,[repo]);const workspaces=jobs.map(j=>({workspaceId:j.id,title:'unreliable title',path:j.worktree!}));
 const groups=sidebarWorkspaceGroups([...workspaces,{workspaceId:'alias',path:'/private/var/tasks/v1',title:'alias'},{workspaceId:'ordinary',path:'/unowned',title:'Issue #128'}],rows);
 assert.equal(groups.length,3);const validation=groups.find(g=>g.members.some(m=>m.run.id==='v2'))!;
 assert.deepEqual(validation.members.map(m=>m.attempt),[2,1,1]);assert.equal(validation.members[0].run.sessionId,'session-v2');
 assert.match(validation.title,/Issue #128 · 验证变更/);assert.ok(!groups.some(g=>g.members.some(m=>m.workspace.workspaceId==='ordinary')));
 assert.equal(sidebarWorkspaceGroups(workspaces,[...rows,{...rows[0],id:'ambiguous'}]).flatMap(g=>g.members).some(m=>m.run.id==='v2'),false);
 const recovery=sidebarWorkspaceGroups(workspaces,[...rows,{...rows[0],id:'recovery',sessionId:'recovery-session',createdAt:'2026-10-10T00:00:03Z'}]).find(g=>g.members.some(m=>m.workspace.workspaceId==='v2'))!;
 assert.deepEqual(recovery.members.find(m=>m.workspace.workspaceId==='v2')!.attempts.map(a=>a.run.sessionId),['session-v2','recovery-session']);
 store.close();
});

test('sidebar metadata omits raw reports, repository credentials, command output and patches',()=>{
 const store=new Store(':memory:');seedFixture(store);const repo=store.repos()[0],issue=store.issues()[0];
 const job={id:'run',repoId:repo.id,issueId:issue.id,issueSnapshot:issue,kind:'review',status:'completed',attempt:1,revision:'r',baseSha:'base',createdAt:'',updatedAt:'',rawOutput:'secret-report',patch:'secret-patch',instructions:'secret-instructions'} as Job;
 const text=JSON.stringify(sidebarRuns([job],[repo]));assert.ok(!text.includes('secret-'));assert.ok(!text.includes(issue.body));assert.equal(sidebarRuns([job],[repo])[0].group,JSON.stringify([repo.id,issue.id,'review']));store.close();
});
