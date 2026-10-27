import test from 'node:test';
import assert from 'node:assert/strict';
import {classificationCurrent,classificationRevision} from '../src/core/classification.ts';
import type {Issue,Job} from '../src/core/types.ts';
const base:Issue={id:'repo#12',repoId:'repo',type:'pr',number:12,title:'Add sum',body:'Details',author:'a',labels:[],state:'open',comments:0,updatedAt:'2026-10-27T10:00:00Z',headSha:'head',prBaseSha:'base',url:'https://github.com/owner/repo/pull/12'};
const classification={category:'feature' as const,priority:'P2' as const,labels:[],revision:classificationRevision(base),jobId:'preflight',updatedAt:'2026-10-27T10:01:00Z'};
const source={id:'preflight',repoId:base.repoId,issueId:base.id,issueSnapshot:base} as Job;
const replied={...base,comments:1,updatedAt:'2026-10-27T11:00:00Z',classification};
const receipt={status:'published' as const,urls:[base.url+'#issuecomment-123'],remoteUpdatedAt:replied.updatedAt,at:'2026-10-27T11:00:01Z'};
const review={...source,id:'review',publications:{comment:receipt}} as Job;
test('confirmed own reply preserves classification without changing the original input hash',()=>{
 assert.notEqual(classificationRevision(replied),classification.revision);
 assert.equal(classificationCurrent(replied,[source,review]),true);
 assert.equal(classificationCurrent({...base,classification},[source]),true);
});
test('unexplained comments, edits, code changes and labels still invalidate classification',()=>{
 for(const patch of [{comments:2},{body:'edited'},{title:'edited'},{headSha:'new'},{prBaseSha:'new'},{labels:['new']},{updatedAt:'2026-10-27T11:01:00Z'}])
 assert.equal(classificationCurrent({...replied,...patch},[source,review]),false,JSON.stringify(patch));
});
test('missing, failed, pending, unrelated or old receipts never forgive a comment change',()=>{
 assert.equal(classificationCurrent(replied,[source]),false);
 for(const patch of [{status:'failed'},{status:'publishing'},{urls:[]},{remoteUpdatedAt:undefined},{remoteUpdatedAt:'2026-10-27T09:00:00Z'},{urls:['https://github.com/owner/repo/pull/12']}])
 assert.equal(classificationCurrent(replied,[source,{...review,publications:{comment:{...receipt,...patch}}} as Job]),false);
 assert.equal(classificationCurrent(replied,[source,{...review,issueId:'other'}]),false);
 assert.equal(classificationCurrent(replied,[review]),false);
});
test('receipt reconciliation cannot count the same comment twice',()=>{
 const duplicate={...review,id:'duplicate'};
 assert.equal(classificationCurrent(replied,[source,review,duplicate]),true);
 assert.equal(classificationCurrent({...replied,comments:2},[source,review,duplicate]),false);
});
