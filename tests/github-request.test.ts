import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRequest } from '../src/core/github-request.ts';
import { GitHub } from '../src/core/github.ts';

test('transient read failure retries with the same credentials', async () => {
  let calls = 0;
  const init = { headers: { Authorization: 'Bearer test-secret' } };
  const fetcher = (async (_url, received) => {
    assert.deepEqual(received?.headers, init.headers);
    assert.ok(received?.signal);
    if (++calls === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return Response.json({ ok: true });
  }) as typeof fetch;
  assert.equal((await githubRequest(fetcher, 'https://api.github.com/user', init)).status, 200);
  assert.equal(calls, 2);
});

test('persistent transport errors redact secrets and explain network rather than auth', async () => {
  await assert.rejects(githubRequest((async () => { throw new TypeError('secret-proxy-password', { cause: { code: 'ENOTFOUND' } }); }) as typeof fetch, 'https://api.github.com/user', {}), error => {
    assert.equal((error as { kind: string }).kind, 'network');
    assert.match((error as Error).message, /域名解析失败/);
    assert.doesNotMatch((error as Error).message, /secret-proxy/);
    return true;
  });
});

test('writes and cancelled reads are not retried', async () => {
  for (const init of [{ method: 'POST' }, { signal: AbortSignal.abort() }]) {
    let calls = 0;
    await assert.rejects(githubRequest((async () => { calls++; throw new TypeError('fetch failed'); }) as typeof fetch, 'https://api.github.com/user', init));
    assert.equal(calls, 1);
  }
});

test('rate limit, permission, authentication and missing resources have distinct diagnostics', async () => {
  for (const [status, headers, kind] of [[403, { 'x-ratelimit-remaining': '0' }, 'rate_limit'], [429, {}, 'rate_limit'], [403, {}, 'permission'], [401, {}, 'auth'], [404, {}, 'not_found']] as const) {
    await assert.rejects(githubRequest((async () => new Response('', { status, headers })) as typeof fetch, 'https://api.github.com/repos/team/repo', {}), error => (error as { kind: string }).kind === kind);
  }
});

test('public repository owned by someone else syncs without login or ownership check', async () => {
  const github = new GitHub('', (async (url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    return Response.json(String(url).includes('/commits/') ? { sha: 'a'.repeat(40) } : String(url).includes('/issues?') ? [] : { full_name: 'other/public', private: false, description: '', default_branch: 'main' });
  }) as typeof fetch);
  assert.equal((await github.sync('other/public')).repo.fullName, 'other/public');
});

test('temporary server outages retry safe reads once', async () => {
  let calls = 0;
  const fetcher = (async () => new Response('', { status: ++calls === 1 ? 503 : 200 })) as typeof fetch;
  assert.equal((await githubRequest(fetcher, 'https://api.github.com/user', {})).status, 200);
  assert.equal(calls, 2);
});

test('broken response bodies retry reads and body timeouts receive Chinese diagnostics', async () => {
  let calls = 0;
  const fetcher = (async () => {
    if (++calls > 1) return Response.json({ complete: true });
    return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('socket ended', { cause: { code: 'ECONNRESET' } })); } }));
  }) as typeof fetch;
  assert.deepEqual(await (await githubRequest(fetcher, 'https://api.github.com/user', {})).json(), { complete: true });
  assert.equal(calls, 2);
  await assert.rejects(githubRequest((async () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); } }))) as typeof fetch, 'https://api.github.com/user', {}), error => {
    assert.equal((error as { kind: string }).kind, 'timeout');
    assert.match((error as Error).message, /连接超时/);
    return true;
  });
});
