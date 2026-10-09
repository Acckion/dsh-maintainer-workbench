import test from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { Store } from '../src/core/store.ts';
import { kinds } from '../src/core/types.ts';
import { taskModel } from '../src/plugin/model-routing.ts';
import { assertCatalogChoice } from '../src/core/models.ts';

import {modelCatalog} from './support/model-catalog.ts';
function context() { return {
  agentDefaultModel:{currentSelection:()=>modelCatalog.default},
  llm: {listProviders:()=>modelCatalog.groups, listModels:async(id:string)=>modelCatalog.groups.find(g=>g.id===id)?.models??[],
    resolveModelInfo:async(p:string,m:string)=>modelCatalog.groups.find(g=>g.id===p)?.models.find(v=>v.id===m)},
} as unknown as Context; }

test('every native stage resolves stage > plugin default > current Harness choice, without leaking inherited effort', async () => {
  const store = new Store(':memory:');
  try {
    const defaults = store.settings(), ctx = context();
    for (const kind of kinds) {
      assert.deepEqual(await taskModel(ctx,defaults,kind), modelCatalog.default);
      const settings = {...defaults,nativeDefaultModel:{provider:'openrouter',model:'laguna'}};
      assert.deepEqual(await taskModel(ctx,settings,kind), settings.nativeDefaultModel);
      assert.deepEqual(await taskModel(ctx,{...settings,stageModels:{[kind]:{provider:'deepseek',model:'pro'}}},kind),
        {provider:'deepseek',model:'pro',reasoningEffort:'medium'});
      assert.deepEqual(await taskModel(ctx,{...settings,stageModels:{[kind]:{provider:'deepseek',model:'pro',reasoningEffort:'low'}}},kind),
        {provider:'deepseek',model:'pro',reasoningEffort:'low'});
    }
  } finally {store.close();}
});

test('removed providers/models and unsupported reasoning fail explicitly before agent creation', async () => {
  const store = new Store(':memory:');
  try {
    const ctx = context(), settings = store.settings();
    for (const choice of [{provider:'missing',model:'pro'},{provider:'deepseek',model:'removed'},
      {provider:'deepseek',model:'pro',reasoningEffort:'impossible'},{provider:'openrouter',model:'laguna',reasoningEffort:'high'}]) {
      await assert.rejects(taskModel(ctx,{...settings,nativeDefaultModel:choice},'fix'), /未加载|不在|不支持/);
      assert.throws(()=>assertCatalogChoice(choice,modelCatalog), /不在|不支持/);
    }
  } finally {store.close();}
});
