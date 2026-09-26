import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { handler, localRejection } from '../src/server/http.ts';

test('startup migration removes legacy demo rows and their audit but preserves real repositories and settings', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'maintainer-migration-')), 'db.sqlite');
  const old = new Store(path);
  old.put('repos', { id:'old-demo',mode:'demo' });
  old.put('repos', { id:'demo/atlas',mode:'github' }); // A real GitHub repo must not be removed by name.
  old.put('issues', {id:'fake-issue',repoId:'old-demo'}); old.put('issues',{id:'real-issue',repoId:'demo/atlas'});
  old.put('jobs',{id:'fake-job',repoId:'old-demo',status:'running'}); old.put('jobs',{id:'real-job',repoId:'demo/atlas',status:'approved'});
  old.put('jobs',{id:'orphan-demo',repoId:'missing',engine:'demo / simulated'});
  old.put('settings',{id:'main',concurrency:3});
  old.audit('demo.seed','old sample data'); old.audit('job.completed','fake result','fake-job'); old.audit('job.completed','real result','real-job'); old.close();
  const upgraded = new Store(path);
  assert.deepEqual(upgraded.repos().map(r=>r.id),['demo/atlas']);
  assert.deepEqual(upgraded.issues().map(i=>i.id),['real-issue']);
  assert.deepEqual(upgraded.jobs().map(j=>j.id),['real-job']);
  assert.deepEqual(upgraded.audits().map(a=>a.jobId),['real-job']); assert.equal(upgraded.settings().concurrency,3); upgraded.close();
  const reopened = new Store(path); assert.equal(reopened.repos().length,1); reopened.close();
});

test('new installation stays empty and removed demo endpoint cannot restore fake records', async () => {
  const store = new Store(':memory:'); const w = new Workbench(store,'/tmp/maintainer-empty',undefined,undefined,false);
  const server = createServer(handler(w,localRejection)); await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/maintainer/api`;
    const result = await fetch(base+'/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(result.status,404); const state=await (await fetch(base+'/state')).json();
    assert.deepEqual(state.repos,[]); assert.deepEqual(state.issues,[]); assert.deepEqual(state.jobs,[]);
  } finally { await new Promise<void>(r=>server.close(()=>r())); await w.close(); }
});
