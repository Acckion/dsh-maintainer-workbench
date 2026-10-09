import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArtifact} from '../src/core/artifacts.ts';
import {parseObject} from '../src/core/intelligence.ts';
const base={schemaVersion:1,stage:'docs',summary:'docs',coverage:'one file',evidence:[],nextSteps:[],responseDraft:'',changes:['Added document'],acceptanceCriteria:[],limitations:[],tests:[{command:'check',status:'not_run',output:'not executed'}]};
test('recovers Issue 4 format-retry checklist map without mutating raw output or test claims',()=>{
 const raw=JSON.stringify(base).replace('"acceptanceCriteria":[]','"acceptanceCriteria":{"目标文件":null,"相对链接":"已满足"}');
 let repaired=0;const artifact=parseArtifact('docs',parseObject(raw),()=>repaired++);
 assert.deepEqual('acceptanceCriteria' in artifact && artifact.acceptanceCriteria,['目标文件','相对链接：已满足']);
 assert.equal(repaired,1);assert.deepEqual('tests' in artifact && artifact.tests,base.tests);
 assert.ok(raw.includes('{"目标文件":null'));
});
test('rejects nested criteria maps, scalar criteria, absent required fields and malformed tests',()=>{
 for(const acceptanceCriteria of [{goal:{status:'passed'}},'goal',{goal:true},{}]) assert.throws(()=>parseArtifact('docs',{...base,acceptanceCriteria}));
 assert.throws(()=>parseArtifact('docs',{...base,changes:undefined,acceptanceCriteria:{goal:'unknown'}}));
 assert.throws(()=>parseArtifact('docs',{...base,acceptanceCriteria:{goal:'unknown'},tests:{check:'passed'}}));
});
test('valid checklists and unrelated schemas retain their original strict contract',()=>{
 let repaired=false;assert.deepEqual(parseArtifact('docs',base,()=>repaired=true),base);assert.equal(repaired,false);
 assert.throws(()=>parseArtifact('validate',{...base,stage:'validate',environment:'local',blockers:[],tests:{check:'passed'}}));
});
