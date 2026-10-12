import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultTriageMaxTokens,effectiveOutputTokens,exhaustedOutputMessage} from '../src/core/output-budget.ts';
import {Store} from '../src/core/store.ts';
import {settingsSchema} from '../src/application/tasks.ts';

test('plan-generation budget defaults are consistent and explicit global/repository limits remain authoritative',()=>{
 const store=new Store(':memory:');const settings=store.settings();assert.equal(settings.triageMaxTokens,6000);
 const {triageMaxTokens:_,...legacy}=settings;assert.equal(settingsSchema.parse(legacy).triageMaxTokens,defaultTriageMaxTokens);
 assert.equal(effectiveOutputTokens('triage',settings),6000);assert.equal(effectiveOutputTokens('preflight',legacy),6000);
 assert.equal(effectiveOutputTokens('triage',{...settings,triageMaxTokens:1800}),1800);
 assert.equal(effectiveOutputTokens('triage',{...settings,maxTokens:2500}),2500);
 assert.equal(effectiveOutputTokens('preflight',settings,{maxTokens:3000}),3000);
 assert.equal(effectiveOutputTokens('fix',{...settings,triageMaxTokens:500},{maxTokens:9000}),9000);store.close();
});
test('output exhaustion reports the effective cap and correct stage controls without implying automatic recovery',()=>{
 const message=exhaustedOutputMessage('triage',1800);assert.match(message,/实际上限 1800/);assert.match(message,/分诊 \/ PR 预检/);assert.match(message,/较小值/);assert.match(message,/未自动/);
 assert.doesNotMatch(exhaustedOutputMessage('docs',6000),/分诊/);
});
