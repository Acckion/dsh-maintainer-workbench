// Real UI/API/Git isolation; only the model is simulated. No external calls.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from '../src/core/git.ts';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { handler, localRejection } from '../src/server/http.ts';
import { seedFixture, fixtureAnalysis } from '../tests/support/fixtures.ts';

const dir = await mkdtemp(join(tmpdir(), 'mw-dirty-browser-')), root = join(dir, 'repo');
await mkdir(root); await git(root, ['init', '-b', 'main']);
await writeFile(join(root, 'README.md'), '# Committed baseline\n');
await git(root, ['add', '.']);
await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '-m', 'baseline']);
const sha = await git(root, ['rev-parse', 'HEAD']);
await writeFile(join(root, 'AGENTS.md'), '# Pending user document\n');
await git(root, ['add', 'AGENTS.md']);
const originalIndex = await readFile(join(root, '.git', 'index'));
const store = new Store(':memory:'); seedFixture(store);
store.put('repos', { ...store.repos()[0], mode: 'local', localKind: 'git', discovered: true, dirty: true, localPath: root, headSha: sha });
const runner = async ({ job, issue }) => {
  assert.notEqual(job.worktree, root);
  assert.equal(await readFile(join(job.worktree, 'README.md'), 'utf8'), '# Committed baseline\n');
  await assert.rejects(readFile(join(job.worktree, 'AGENTS.md')), { code: 'ENOENT' });
  await writeFile(join(job.worktree, 'AGENTS.md'), '# Isolated generated instructions\n');
  return { result: fixtureAnalysis(issue, job.kind), engine: 'fixture' };
};
const w = new Workbench(store, join(dir, 'data'), runner, new GitHub('', async () => { throw Error('Unexpected network call'); }), true);
const api = handler(w, localRejection);
const files = { '/': ['preview.html', 'text/html'], '/app.js': ['app.js', 'application/javascript'], '/app.css': ['app.css', 'text/css'] };
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/maintainer/api')) return api(req, res);
  const file = files[new URL(req.url, 'http://localhost').pathname];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file[1]); res.end(await readFile(join(process.cwd(), 'dist', file[0])));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: 'Repository', exact: true }).click();
  await page.getByRole('button', { name: '生成 / 更新 AGENTS.md', exact: true }).click();
  const action = page.getByRole('button', { name: '检查并准备修改', exact: true });
  assert.equal(await action.isEnabled(), true);
  await action.click();
  await page.waitForFunction(async () => {
    const state = await (await fetch('/maintainer/api/state')).json();
    return state.jobs.some(j => j.issueSnapshot.organizeMode === 'agents' && j.status === 'awaiting_review');
  });
  await w.drain();
  const id = store.jobs().find(j => j.issueSnapshot.organizeMode === 'agents').id;
  const job = store.get('jobs', id);
  assert.equal(job.status, 'awaiting_review', job.error);
  assert.match(job.patch, /Isolated generated instructions/);
  assert.doesNotMatch(job.patch, /Pending user document/);
  assert.deepEqual(await readFile(join(root, '.git', 'index')), originalIndex);
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# Pending user document\n');
  await page.screenshot({ path: join(dir, 'dirty-organization.png'), fullPage: true });
  console.log('PASS: enabled dirty-workspace UI -> API -> isolated document task -> frozen patch; source unchanged. Evidence:', dir);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await w.close(); }
