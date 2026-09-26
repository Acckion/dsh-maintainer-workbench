import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGitHubAuth } from '../src/core/github-auth.ts';
import { GitHub } from '../src/core/github.ts';

test('credentials prefer explicit token and environment, without switching identities', async () => {
  const cli = async () => { throw Error('must not call CLI'); };
  assert.deepEqual(await resolveGitHubAuth('explicit', { GITHUB_TOKEN: 'env' }, cli), { token: 'explicit', source: 'token' });
  assert.equal((await resolveGitHubAuth('', { GITHUB_TOKEN: 'env' }, cli)).token, '');
  assert.equal((await resolveGitHubAuth(undefined, { GH_TOKEN: 'env' }, cli)).token, 'env');
  assert.deepEqual(await resolveGitHubAuth(undefined, {}, async () => 'cli\n'), { token: 'cli', source: 'gh' });
  assert.deepEqual(await resolveGitHubAuth(undefined, {}, async () => { throw Error('unavailable'); }), { token: '', source: 'anonymous' });
});
test('private sync authenticates every API request and retains visibility; status never exposes token', async () => {
  const github = new GitHub('test-secret', (async (url, init) => {
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer test-secret');
    const path = String(url);
    return Response.json(path.endsWith('/user') ? { login: 'maintainer' } : path.includes('/commits/') ? { sha: 'a'.repeat(40) } : path.includes('/issues?') ? [] : { full_name: 'team/private', private: true, description: '', default_branch: 'main' });
  }) as typeof fetch);
  assert.equal((await github.sync('team/private')).repo.private, true);
  assert.deepEqual(await github.connection(), { authenticated: true, source: 'token', login: 'maintainer' });
});
