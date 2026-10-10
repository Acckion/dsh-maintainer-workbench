// Real built client, HTTP API and SQLite persistence; pre-recorded results avoid external model/GitHub calls.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { handler, localRejection } from '../src/server/http.ts';
import { seedFixture, fixtureAnalysis } from '../tests/support/fixtures.ts';

const root = await mkdtemp(join(tmpdir(), 'maintainer-conversations-browser-'));
const database = join(root, 'state.sqlite');
let store = new Store(database);
seedFixture(store);
const repo = store.repos()[0], original = store.issues()[0];
const foreign = { ...repo, id: 'fixture/other', fullName: 'fixture/other' };
store.put('repos', foreign);
for (const [category, count] of [['docs', 25], ['bug', 2], ['audit', 1]]) {
  for (let i = 1; i <= count; i++) {
    const item = { ...original, id: `${repo.id}#${category}-${i}`, number: 200 + i,
      type: 'pr', title: `${category} PR ${i}` };
    store.put('issues', item);
    store.put('jobs', { id: `${category}-${i}`, repoId: repo.id, issueId: item.id, issueSnapshot: item,
      kind: category === 'docs' ? 'docs' : 'investigate', status: 'completed', conversationCategory: category,
      revision: 'fixture', baseSha: repo.headSha, attempt: 1,
      createdAt: `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`, updatedAt: '2026-10-01',
      result: { ...fixtureAnalysis(item, 'docs'), category: category === 'audit' ? 'maintenance' : category,
        summary: `${category} conclusion ${i}` } });
  }
}
store.put('jobs', { ...store.jobs()[0], id: 'foreign', repoId: foreign.id,
  issueSnapshot: { ...original, repoId: foreign.id, title: 'Other repository PR' },
  kind: 'docs', result: { ...fixtureAnalysis(original, 'docs'), summary: 'FOREIGN_REPO_ONLY' } });
// Reopen the database before loading the client to exercise persisted history.
store.close(); store = new Store(database);
const github = new GitHub('', async () => { throw Error('Unexpected external request'); });
const workbench = new Workbench(store, root, async () => { throw Error('Fixture executor must not run'); }, github, false);
const api = handler(workbench, localRejection);
const files = { '/': ['preview.html', 'text/html'], '/app.js': ['app.js', 'application/javascript'], '/app.css': ['app.css', 'text/css'] };
const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/maintainer/api')) return api(req, res);
  const file = files[new URL(req.url, 'http://localhost').pathname];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file[1]); res.end(await readFile(join(process.cwd(), 'dist', file[0])));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });
const evidence = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const select = page.locator('[aria-label="选择仓库"]:visible, .mw-mobile-repo select:visible').first();
      await select.selectOption(repo.id);
      await page.getByRole('button', { name: 'Repository', exact: true }).click();
      const main = page.getByLabel('仓库主区', { exact: true });
      const nav = main.getByRole('navigation', { name: '问题类别子区' });
      await expect(nav.getByRole('button')).toHaveCount(8);
      await expect(main.locator('aside h3')).toHaveText(repo.fullName);
      const scope = main.getByLabel('本次范围或重点（可选）');
      await scope.fill('Audit-specific scope');
      await nav.getByRole('button', { name: /^文档维护/ }).click();
      await expect(scope).toHaveValue('');
      await scope.fill('Documentation-specific scope');
      const history = main.getByLabel('类别对话记录');
      await expect(history.locator('article')).toHaveCount(20);
      await expect(history).not.toContainText('FOREIGN_REPO_ONLY');
      await expect(history.getByText('docs conclusion 1', { exact: true })).toHaveCount(0);
      await main.getByRole('button', { name: '加载更早记录' }).click();
      await expect(history.locator('article')).toHaveCount(25);
      await expect(history).toContainText('docs conclusion 1');
      await expect(history.locator('article').first()).toContainText('PR #201');
      await expect(history.locator('article').last()).toContainText('PR #225');
      await nav.getByRole('button', { name: /^缺陷问题/ }).click();
      await expect(history.locator('article')).toHaveCount(2);
      await expect(main.locator('textarea')).toHaveCount(0);
      await nav.getByRole('button', { name: /^文档与仓库结构/ }).click();
      await expect(scope).toHaveValue('Audit-specific scope');
      await nav.getByRole('button', { name: /^文档维护/ }).click();
      await expect(scope).toHaveValue('Documentation-specific scope');
      await expect(history.locator('article')).toHaveCount(20);
      await select.selectOption(foreign.id);
      await expect(main.locator('aside h3')).toHaveText(foreign.fullName);
      await expect(scope).toHaveValue('');
      await nav.getByRole('button', { name: /^文档维护/ }).click();
      await expect(history.locator('article')).toHaveCount(1);
      await expect(history).toContainText('FOREIGN_REPO_ONLY');
      await select.selectOption(repo.id);
      await expect(main.locator('aside h3')).toHaveText(repo.fullName);
      await scope.fill(`Browser scope ${width}`);
      // Use the real HTTP action and persisted queue, with execution disabled for this UI fixture.
      await main.getByRole('button', { name: '开始检查', exact: true }).click();
      await expect(page.getByText('整理任务已派发', { exact: true })).toBeVisible();
      const queued = store.jobs().find(job => job.instructions?.includes(`Browser scope ${width}`));
      assert.ok(queued); assert.equal(queued.repoId, repo.id); assert.equal(queued.issueSnapshot.organizeMode, 'audit');
      await page.getByRole('button', { name: 'Repository', exact: true }).click();
      await expect(history).toContainText(queued.id);
      await nav.getByRole('button', { name: /^文档维护/ }).click();
      await page.screenshot({ path: join(root, `repository-categories-${width}.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
      assert.deepEqual(errors, []);
      evidence.push({ width, categories: 8, fullHistory: 25, repositoryIsolation: true, scopedDrafts: true, realApiDispatch: queued.id });
      console.log(`Repository conversations browser E2E PASS ${width}px`);
    } catch (error) {
      await page.screenshot({ path: join(root, `failure-${width}.png`), fullPage: true }); throw error;
    } finally { await page.close(); }
  }
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log('Evidence directory:', root);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); await workbench.close();
}
