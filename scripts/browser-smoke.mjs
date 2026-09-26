// Run against a freshly started, empty development instance; never seeds product data.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  await page.goto(process.env.WORKBENCH_TEST_URL ?? 'http://127.0.0.1:4317');
  await page.getByRole('heading', { name: '连接你的第一个仓库' }).waitFor();
  await page.getByRole('button', { name: '连接 GitHub 仓库', exact: true }).click();
  await page.getByPlaceholder('owner/repository').waitFor();
  assert.equal(await page.getByPlaceholder('owner/repository').inputValue(), '');
  await page.getByRole('button', {name:'关闭'}).click();
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log('Empty onboarding, connect dialog and mobile layout passed.');
} finally { await browser.close(); }
