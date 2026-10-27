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

test('user output token budgets above former 8000 and 32000 caps persist without clamping', async()=>{
 const {Workbench}=await import('../src/core/workbench.ts');
 const {seedFixture}=await import('./support/fixtures.ts');
 const store=new Store(':memory:');seedFixture(store);
 const wb=new Workbench(store,'/tmp/output-budget-settings',undefined,undefined,false);
 try {
  const settings=settingsSchema.parse({...store.settings(),triageMaxTokens:65536,maxTokens:131072});
  wb.updateSettings(settings);
  assert.equal(store.settings().triageMaxTokens,65536);
  assert.equal(store.settings().maxTokens,131072);
  wb.updatePolicy(store.repos()[0].id,{autoTriage:false,syncIntervalMinutes:0,timeoutMs:600000,maxTokens:262144});
  assert.equal(store.repos()[0].policy?.maxTokens,262144);
  assert.equal(effectiveOutputTokens('preflight',store.settings(),store.repos()[0].policy),65536);
  assert.equal(effectiveOutputTokens('review',store.settings(),store.repos()[0].policy),262144);
  for(const invalid of [NaN,Infinity,-1,1000.5])assert.equal(settingsSchema.safeParse({...settings,triageMaxTokens:invalid}).success,false);
 }finally{await wb.close();}
});

test('global output token fields expose no fixed HTML maximum',async()=>{
 const React=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {GlobalSettingsFields}=await import('../src/client/GlobalSettingsFields.tsx');
 const store=new Store(':memory:');
 try {
  const markup=renderToStaticMarkup(React.createElement(GlobalSettingsFields,{settings:{...store.settings(),triageMaxTokens:65536,maxTokens:131072},update:()=>{},panel:'execution',native:true}));
  for(const label of ['分诊 / PR 预检输出 Token 上限','每次请求输出 Token 上限']){
   const input=markup.match(new RegExp('<input[^>]*aria-label="'+label+'"[^>]*>'))?.[0];assert.ok(input);assert.doesNotMatch(input,/\smax=/);
  }
 }finally{store.close();}
});

test('explicit repository inheritance follows changed global limits, while independent budgets stay intact',async()=>{
 const {Workbench}=await import('../src/core/workbench.ts');const {seedFixture}=await import('./support/fixtures.ts');
 const store=new Store(':memory:');seedFixture(store);const wb=new Workbench(store,'/tmp/token-inheritance-test',undefined,undefined,false);
 try{
  const repo=store.repos()[0];const policy={autoTriage:false,syncIntervalMinutes:0,timeoutMs:600000,maxTokens:4096,inheritMaxTokens:true};
  wb.updatePolicy(repo.id,policy);const saved=store.repos()[0].policy!;assert.equal(saved.inheritMaxTokens,true);assert.equal(saved.maxTokens,4096);
  const settings={maxTokens:600000,triageMaxTokens:500000};assert.equal(effectiveOutputTokens('review',settings,saved),600000);assert.equal(effectiveOutputTokens('preflight',settings,saved),500000);
  assert.equal(effectiveOutputTokens('review',{...settings,maxTokens:65536},saved),65536);
  assert.equal(effectiveOutputTokens('review',settings,{...saved,inheritMaxTokens:false}),4096);
  assert.equal(effectiveOutputTokens('review',settings,{maxTokens:4096}),4096);
 }finally{await wb.close();}
});
