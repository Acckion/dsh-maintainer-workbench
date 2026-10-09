import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { seedFixture } from './support/fixtures.ts';

test('batch connection deduplicates names, isolates identical issue numbers and survives partial failure', async () => {
  const source = new Store(':memory:'); seedFixture(source);
  const template = source.repos()[0], issue = source.issues()[0];
  const github = new GitHub('');
  const calls: string[] = [];
  github.sync = async fullName => {
    calls.push(fullName);
    if (fullName === 'team/denied') throw Error('GitHub 404');
    const id = fullName.replace('team/', 'Team/');
    return { repo: { ...template, id, fullName: id }, issues: [{ ...issue, id: id + '#128', repoId: id }] };
  };
  const store = new Store(':memory:');
  const workbench = new Workbench(store, '/tmp/multi-repository-test', undefined, github, false);
  try {
    const batch = await workbench.syncMany(['https://github.com/Team/one.git', 'TEAM/ONE', 'team/denied', 'team/two']);
    assert.equal(batch.results.length, 3);
    assert.equal(batch.results[1].error, 'GitHub 404');
    assert.equal(batch.results[2].repoId, 'Team/two');
    assert.deepEqual(calls, ['team/one', 'team/denied', 'team/two']);
    assert.equal(store.repos().length, 2);
    assert.equal(store.issues().length, 2);
    workbench.enqueue(store.issues().map(i => i.id), 'triage');
    assert.deepEqual(new Set(store.jobs().map(j => j.repoId)), new Set(['Team/one', 'Team/two']));
    await workbench.syncMany(['team/one']);
    assert.equal(store.issues().length, 2);
    const mixed = await workbench.syncMany(['team/one', 'invalid']);
    assert.equal(mixed.results.length, 2);
    assert.equal(mixed.results[0].error, undefined);
    assert.equal(mixed.results[1].fullName, 'invalid');
    assert.match(mixed.results[1].error!, /不是有效的/);
    assert.equal(calls.at(-1), 'team/one');
  } finally { source.close(); await workbench.close(); }
});
