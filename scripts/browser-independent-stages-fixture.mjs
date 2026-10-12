import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { availableActions } from '../src/workflow/actions.ts';
import { projectTimeline } from '../src/workflow/timeline.ts';

const now = '2026-10-11T00:00:00Z';
const processing = { id: 'fixture-case', workItemId: 'fixture-item', repositoryId: 'fixture', workflowDefinitionVersion: 'maintainer/2', lifecycle: 'active', phase: 'triage', reason: 'Fixture only', waits: [], activeRunIds: [], sourceFingerprint: 'fixture', cycle: 1, version: 1, createdAt: now, updatedAt: now };
const issue = { id: 'fixture-item', repoId: 'fixture', number: 1, type: 'issue', title: 'Queue ordering', body: 'Investigate fixture queue ordering', author: 'fixture', labels: [], state: 'open', comments: 0, updatedAt: now, url: '', processing };
const projection = availableActions(issue);
const timeline = projectTimeline(issue, processing, [], [], projection);
const client = await build({ write: false, bundle: true, format: 'iife', jsx: 'automatic', stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorkflowDetail} from './src/client/WorkflowDetail.tsx';
import {AssistantActions} from './src/client/AssistantActions.tsx';
const issue = ${JSON.stringify(issue)};
window.sent = [];
const act = async (path, data) => { window.sent.push({path, data}); return {created:['fixture-run']}; };
createRoot(document.getElementById('root')).render(<WorkflowDetail issue={issue} jobs={[]}
  render={() => <p>Fixture result</p>} track={() => null} evidence={() => null} context={() => null}
  actions={(job, projected) => <AssistantActions issue={issue} history={[]} job={job} busy={false} projected={projected} act={act} openEvidence={() => {}} />} />);
` } });
const styles = await readFile(resolve('src/client/styles.css'));
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  if (path === '/client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(client.outputFiles[0].contents); }
  else if (path === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(styles); }
  else if (path.endsWith('/processing/timeline')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(timeline)); }
  else if (path.endsWith('/processing')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ cases: [processing] })); }
  else response.end('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><body style="margin:0"><main id="root" style="padding:16px;max-width:1000px;margin:auto"></main><script src="/client.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });
  await mkdir('artifacts', { recursive: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const navigation = page.getByRole('navigation', { name: '处理阶段' });
    await navigation.getByRole('button').filter({ hasText: '验证' }).click();
    assert.equal(await page.evaluate(() => window.sent.length), 0, 'Selecting a node must never start it');
    const input = page.getByLabel('用户补充信息', { exact: true });
    assert.equal(await input.getAttribute('required'), '');
    assert.ok(await page.getByRole('status').filter({ hasText: '依赖节点' }).isVisible());
    const launch = page.getByRole('button', { name: '验证改动', exact: true });
    assert.equal(await launch.isDisabled(), true);
    await input.fill('Validate queue ordering at the recorded checkout; no source patch is supplied.');
    assert.equal(await launch.isDisabled(), false);
    await launch.click();
    const sent = await page.evaluate(() => window.sent);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, '/jobs');
    assert.equal(sent[0].data.kind, 'validate');
    assert.equal(sent[0].data.sourceJobId, undefined);
    assert.equal(sent[0].data.goal, undefined);
    assert.equal(sent[0].data.forceNew, true);
    assert.equal(sent[0].data.instructions, sent[0].data.supplementalInfo);
    await page.getByLabel('独立执行节点').selectOption('review');
    assert.equal(await input.getAttribute('required'), '');
    await page.getByLabel('独立执行节点').selectOption('triage');
    assert.equal(await input.getAttribute('required'), null);
    await page.getByRole('button', { name: '开始分诊', exact: true }).click();
    const rootDispatch = await page.evaluate(() => window.sent.at(-1));
    assert.equal(rootDispatch.path, '/jobs', 'Independent triage must retain supplementary context rather than using batch classification');
    assert.match(rootDispatch.data.instructions, /queue ordering/);
    assert.deepEqual(errors, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    await page.screenshot({ path: `artifacts/independent-stages-${width}.png`, fullPage: true });
    await page.close();
  }
  console.log('PASS: independent future-node dispatch, required-input warning, optional root input, no automatic continuation, desktop/mobile layout.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
