import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoName } from '../src/core/repo-name.ts';

test('normalizeRepoName accepts plain names, URLs, scp links and .git suffixes', () => {
  assert.equal(normalizeRepoName('Team/One'), 'team/one');
  assert.equal(normalizeRepoName('TEAM/ONE.GIT'), 'team/one');
  assert.equal(normalizeRepoName('https://github.com/Team/one.git'), 'team/one');
  assert.equal(normalizeRepoName('http://github.com/team/two'), 'team/two');
  assert.equal(normalizeRepoName('https://github.com/Team/one/tree/main'), 'team/one');
  assert.equal(normalizeRepoName('https://github.com/team/one?tab=readme'), 'team/one');
  assert.equal(normalizeRepoName('https://github.com/team/one/'), 'team/one');
  assert.equal(normalizeRepoName('https://www.github.com/team/one'), 'team/one');
  assert.equal(normalizeRepoName('git@github.com:Team/one.git'), 'team/one');
  assert.equal(normalizeRepoName('ssh://git@github.com/team/one'), 'team/one');
  assert.equal(normalizeRepoName('  owner/repo  '), 'owner/repo');
  assert.equal(normalizeRepoName('owner/repo/extra'), 'owner/repo');
});

test('normalizeRepoName rejects non-repository input', () => {
  assert.equal(normalizeRepoName(''), undefined);
  assert.equal(normalizeRepoName('   '), undefined);
  assert.equal(normalizeRepoName('invalid'), undefined);
  assert.equal(normalizeRepoName('owner'), undefined);
  assert.equal(normalizeRepoName('/repo'), undefined);
  assert.equal(normalizeRepoName('http://gitlab.com/a/b'), undefined);
  assert.equal(normalizeRepoName('https://github.com/'), undefined);
  assert.equal(normalizeRepoName('owner/repo with space'), undefined);
});
