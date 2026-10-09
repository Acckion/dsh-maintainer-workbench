import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { handler, localRejection } from '../src/server/http.ts';
import { fixtureRunner } from './support/fixtures.ts';
import { modelCatalog } from './support/model-catalog.ts';
import { settingsIdentity } from '../src/client/settings-draft.ts';

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mw-global-settings-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const w = new Workbench(store, dir, fixtureRunner, undefined, false, () => ({
    model: 'host-fixture', provider: 'fixture', adapterRegistered: true, agentPreset: 'host-default',
  }), async () => modelCatalog);
  const server = createServer(handler(w, localRejection));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/maintainer/api/settings/global`;
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await w.close(); await rm(dir, {recursive:true,force:true}); });
  return { dir, store, w, url };
}

test('global settings projection excludes repository/job data and inherits current host model', async t => {
  const { store, url } = await setup(t);
  store.issues = store.jobs = store.repos = () => { throw Error('Settings must not load repository data'); };
  store.audits = () => { throw Error('Settings must not load audit data'); };
  const response = await fetch(url), snapshot = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(snapshot).sort(), ['capabilities', 'revision', 'settings']);
  assert.equal(snapshot.capabilities.host.model, 'host-fixture');
  assert.equal(snapshot.revision.length, 64);
  assert.equal(snapshot.settings.autoTriage, false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('native and workbench settings share durable storage and reject stale edits', async t => {
  const { store, url, dir } = await setup(t);
  const before = await (await fetch(url)).json();
  const next = { ...before.settings, syncLimit: 0, autoPreflight: true, concurrency: 3 };
  const post = (settings: unknown, revision: string) => fetch(url, {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,revision}),
  });
  const accepted = await post(next, before.revision), after = await accepted.json();
  assert.equal(accepted.status, 200); assert.notEqual(after.revision, before.revision);
  const second = new Store(join(dir, 'state.sqlite'));
  try { assert.equal(second.settings().syncLimit, 0); assert.equal(second.settings().autoPreflight, true); }
  finally { second.close(); }
  const stale = await post({...before.settings, concurrency: 4}, before.revision);
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'SETTINGS_CONFLICT');
  assert.equal(store.settings().concurrency, 3);
  // The legacy write endpoint also invalidates a previously loaded native form.
  const legacy = await fetch(url.replace('/global',''), { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...next,concurrency:2}) });
  assert.equal(legacy.status, 200);
  assert.equal((await post(next, after.revision)).status, 409);
});

test('global settings validates limits and retains the existing origin/auth guard', async t => {
  const { store, url } = await setup(t);
  const before = await (await fetch(url)).json();
  const invalid = await fetch(url, { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings:{...before.settings,concurrency:99},revision:before.revision}) });
  assert.equal(invalid.status, 400); assert.equal(store.settings().concurrency, 2);
  const denied = await fetch(url, {headers:{Origin:'https://untrusted.example'}});
  assert.equal(denied.status, 403);
});

test('draft cleanliness ignores SQLite row metadata and property order but tracks edits', () => {
  const store = new Store(':memory:');
  try {
    const settings = store.settings();
    const reordered = Object.fromEntries(Object.entries(settings).reverse()) as typeof settings;
    assert.equal(settingsIdentity(settings), settingsIdentity({...reordered, id:'main'} as typeof settings));
    const models={...settings,stageModels:{review:{provider:'p',model:'m'},fix:{provider:'p',model:'n'}}};
    assert.equal(settingsIdentity(models),settingsIdentity({...models,stageModels:{fix:{model:'n',provider:'p'},review:{model:'m',provider:'p'}},nativeDefaultModel:undefined}));
    assert.notEqual(settingsIdentity(settings), settingsIdentity({...reordered, syncLimit:0}));
  } finally { store.close(); }
});


test('configured Harness choices persist across reopen and catalog/validation expose no credentials', async t => {
  const {store,url,dir} = await setup(t);
  const catalogResponse = await fetch(url.replace('/settings/global','/models'));
  assert.equal(catalogResponse.status,200); assert.deepEqual(await catalogResponse.json(),modelCatalog);
  assert.equal((await fetch(url.replace('/settings/global','/models'),{headers:{Origin:'https://untrusted.example'}})).status,403);
  let before = await (await fetch(url)).json();
  const send = (settings:unknown) => fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,revision:before.revision})});
  const selected = {...before.settings,nativeDefaultModel:{provider:'openrouter',model:'laguna'},stageModels:{review:{provider:'deepseek',model:'pro',reasoningEffort:'high'}}};
  const accepted=await send(selected);assert.equal(accepted.status,200);before=await accepted.json();
  const reopened = new Store(join(dir,'state.sqlite'));
  try {assert.deepEqual(reopened.settings().nativeDefaultModel,selected.nativeDefaultModel);assert.deepEqual(reopened.settings().stageModels,selected.stageModels);} finally {reopened.close();}
  for (const settings of [{...selected,stageModels:{invented:{provider:'deepseek',model:'pro'}}},
    {...selected,nativeDefaultModel:{provider:'deepseek',model:'removed'}},
    {...selected,stageModels:{review:{provider:'deepseek',model:'pro',reasoningEffort:'invalid'}}},
    {...selected,stageModels:null}]) {
    assert.equal((await send(settings)).status,400);assert.deepEqual(store.settings().stageModels,selected.stageModels);
  }
  assert.equal((await send({...selected,nativeDefaultModel:undefined,stageModels:{}})).status,200);
  assert.equal(store.settings().nativeDefaultModel,undefined);assert.deepEqual(store.settings().stageModels,{});
});
