import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DeliveryTimeline,deliveryHistory} from '../src/client/DeliveryTimeline.tsx';
import type {Job} from '../src/core/types.ts';
const review={id:'review',repoId:'r',issueId:'i',caseId:'case',kind:'review',status:'approved',createdAt:'2026-10-27T13:00:00Z',finishedAt:'2026-10-27T13:05:00Z',publications:{comment:{status:'published',at:'2026-10-27T13:06:00Z',urls:['https://example.test/comment']}}} as Job;
const repair={...review,id:'repair',kind:'fix',status:'running',createdAt:'2026-10-27T14:00:00Z',startedAt:'2026-10-27T14:00:01Z',finishedAt:undefined,publications:undefined,sourceJobId:review.id} as Job;
test('published review retains saved delivery plus live repair and later failure without mutating records',()=>{
 const unrelated={...repair,id:'unrelated',sourceJobId:undefined},otherCycle={...repair,id:'other-cycle',caseId:'other'};
 const jobs=[review,repair,unrelated,otherCycle];const before=JSON.stringify(jobs);
 const rows=deliveryHistory(review,jobs);
 assert.deepEqual(rows.map(r=>r.id),['review:result','review:comment','repair:start']);
 assert.equal(rows[1].url,'https://example.test/comment');assert.equal(JSON.stringify(jobs),before);
 const html=renderToStaticMarkup(React.createElement(DeliveryTimeline,{job:review,jobs,open:()=>{}}));
 assert.match(html,/交付与后续处理时间线/);assert.match(html,/PR 评论 · 已发布/);assert.match(html,/执行中/);
 const failed={...repair,status:'failed',finishedAt:'2026-10-27T14:02:00Z',error:'verification failed'} as Job;
 const later=deliveryHistory(failed,[review,failed]);assert.ok(later.some(r=>r.id==='review:comment'));assert.equal(later.at(-1)?.error,'verification failed');
});
