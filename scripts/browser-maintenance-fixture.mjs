// Real client + real local API/store. GitHub responses and Agent output are fixtures.
// No user workspace, paid model request, or external GitHub mutation is used.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.ts';
import { Workbench, revision } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { handler, localRejection } from '../src/server/http.ts';
import { seedFixture, fixtureRunner, fixtureAnalysis } from '../tests/support/fixtures.ts';
import { executionRecord, saveExecutionLog } from '../src/core/execution-evidence.ts';

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });
try {
  for (const width of [1440, 390]) {
    const dir = await mkdtemp(join(tmpdir(), 'maintainer-browser-')), store = new Store(':memory:'); seedFixture(store);
    const github = new GitHub('', async () => { throw Error('Unexpected external request'); });
    const w = new Workbench(store, dir, fixtureRunner, github, false), repo = store.repos()[0];
    const pr = { ...store.issues()[3], type: 'pr', headSha: 'b'.repeat(40), prBaseSha: repo.headSha }; store.put('issues', pr);
    const artifact = { schemaVersion: 1, stage: 'review', summary: 'Fixture review', coverage: 'Fixture only', evidence: [], nextSteps: [], responseDraft: '', verdict: 'changes_requested', blockers: [], findings: [{ id: 'f1', title: 'Fixture regression', severity: 'P1', path: 'sum.ts', line: 1, trigger: 'addition', evidence: 'wrong result', recommendation: 'fix addition' }] };
    const job = { id: 'review-current', repoId: repo.id, issueId: pr.id, issueSnapshot: pr, kind: 'review', status: 'awaiting_review', revision: revision(pr, repo, 'review'), baseSha: pr.headSha, artifact, result: fixtureAnalysis(pr, 'review'), attempt: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), prContext: { headSha: pr.headSha, baseSha: pr.prBaseSha, headRef: 'feature', baseRef: 'main', headRepo: repo.fullName, draft: false, merged: false, mergeable: true, checks: [], reviews: [], warnings: [] }, handoff: [{ id: 'review-old', kind: 'review', revision: 'old', artifact }], findingFollowups: [{ sourceJobId: 'review-old', findingId: 'f1', status: 'unverified', evidence: 'Old finding needs current-version evidence' }] };
    const record = executionRecord(job, 'fixture-session', 5, { name: 'bash', arguments: '{"command":"node test.cjs"}' }, { meta: { exitCode: 1, stdout: { text: 'Fixture assertion failed' } }, message: { toolCallId: 'fixture-call' } });
    job.executionRecords = [record]; saveExecutionLog(dir, job.id, record.id, JSON.stringify({ fixture: true, exitCode: 1, output: 'Fixture assertion failed' })); store.put('jobs', job);
    let writes = 0;
    const threadSnapshot = { headSha: pr.headSha, baseSha: pr.prBaseSha, syncedAt: new Date().toISOString(), partial: false, threads: [{ id: 'thread-fixture', path: 'sum.ts', line: 1, isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: true, url: 'https://github.com/fixture/queue/pull/135#discussion', body: 'Fixture thread' }] };
    github.remotePR = async (_repo,url) => ({ url,number:135,headSha:pr.headSha,baseSha:pr.prBaseSha,state:'OPEN',draft:false,review:'CHANGES_REQUESTED',mergeState:'DIRTY',mergedAt:null,checks:[{name:'Fixture CI',status:'COMPLETED',conclusion:'FAILURE'}],closingIssues:[],partial:false,syncedAt:new Date().toISOString() });
    github.request = async () => ({number:135,state:'open'});
    github.pullRequest = async () => job.prContext;
    github.actions = async () => ({headSha:pr.headSha,syncedAt:new Date().toISOString(),jobs:[{id:42,runId:30,attempt:2,headSha:pr.headSha,name:'Fixture Actions failure',url:'https://github.com/fixture/queue/actions/runs/30',status:'completed',conclusion:'failure',steps:[{name:'Fixture regression step',number:3,status:'completed',conclusion:'failure'}]}],warnings:[]});
    github.actionLog = async () => ({jobId:42,runId:30,attempt:2,headSha:pr.headSha,text:'FIXTURE_ACTIONS_ASSERTION_FAILED',truncated:false,fetchedAt:new Date().toISOString()});
    github.threads = async () => structuredClone(threadSnapshot);
    github.setThreadResolved = async (_id, resolved, beforeSend) => { beforeSend?.(); writes++; threadSnapshot.threads[0].isResolved = resolved; };
    github.sync = async () => ({ repo, issues: store.issues().map(issue => issue.informationRequests?.length ? { ...issue, comments: issue.comments + 1, updatedAt: new Date().toISOString() } : issue) });
    github.informationReplies = async (_repo, issue) => ({ replies: [{ id: 101, author: issue.author, createdAt: new Date(Date.now() + 1000).toISOString(), url: 'https://github.com/fixture/queue/issues/131#comment', body: 'Fixture user supplied reproduction steps' }], partial: false });
    const api = handler(w, localRejection), files = { '/': ['preview.html', 'text/html'], '/app.js': ['app.js', 'application/javascript'], '/app.css': ['app.css', 'text/css'] };
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith('/maintainer/api')) return api(req, res);
      const file = files[new URL(req.url, 'http://localhost').pathname]; if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file[1]); res.end(await readFile(join(process.cwd(), 'dist', file[0])));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(12000);
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole('button', { name: '收件箱' }).click();
      await page.locator('[id="mw-item-fixture/queue#128"]').click();
      await page.getByText('事项类型、目标与验收', { exact: true }).click();
      await page.getByLabel('处理类型', { exact: true }).selectOption('feature');
      await page.getByLabel('维护目标', { exact: true }).fill('Fixture offline sync');
      await page.getByLabel('实施范围与排除项', { exact: true }).fill('Sync only');
      await page.getByLabel('验收条件（每行一项）', { exact: true }).fill('Offline operation queues');
      await page.getByLabel('维护者取舍', { exact: true }).selectOption('accepted');
      await page.getByRole('button', { name: '保存类型与验收计划', exact: true }).click();
      await page.getByText('已保存事项类型与验收计划', { exact: true }).waitFor();
      await page.getByRole('button', { name: '下一步：实施变更', exact: true }).click();
      await page.getByText(/已派发下一阶段/).waitFor();
      assert.equal(store.jobs().find(item => item.kind === 'fix')?.issueSnapshot.plan?.goal, 'Fixture offline sync');

      await page.locator('[id="mw-item-fixture/queue#131"]').click();
      await page.getByText(/补充信息与追问记录/).click();
      await page.getByLabel('已提出的问题（每行一项）', { exact: true }).fill('Which version?\nReproduction steps?');
      await page.getByRole('button', { name: '记录已提出的追问', exact: true }).click();
      await page.getByText('已记录提问', { exact: false }).waitFor();
      await page.getByLabel('已提出的问题（每行一项）', { exact: true }).fill('Which version?');
      await page.getByRole('button', { name: '记录已提出的追问', exact: true }).click();
      await page.getByLabel('已提出的问题（每行一项）', { exact: true }).evaluate(element => element.blur());
      await page.getByRole('button', { name: '同步仓库', exact: true }).click();
      await page.getByText(/有新回复，待重新评估/).waitFor();
      assert.equal(store.get('issues', 'fixture/queue#131').informationRequests.length, 1);
      await page.getByRole('button', { name: '信息已足够', exact: true }).click();
      await page.getByText('维护者确认信息已足够', { exact: false }).waitFor();

      await page.getByRole('button', { name: '待我审核' }).click();
      await page.locator('#mw-item-review-current').click();
      await page.getByRole('button',{name:'刷新关联 PR 进度',exact:true}).click();
      await page.getByText('审查要求修改',{exact:true}).waitFor();
      await page.getByText('存在合并冲突',{exact:true}).waitFor();
      await page.getByRole('button',{name:'读取 PR #135 Actions',exact:true}).click();
      await page.getByText(/Fixture regression step/).waitFor();
      await page.getByRole('button',{name:'读取 job 42 日志',exact:true}).click();
      await page.getByText('FIXTURE_ACTIONS_ASSERTION_FAILED',{exact:true}).waitFor();
      await page.screenshot({path:join(dir,`remote-progress-${width}.png`),fullPage:true});
      await page.getByText('批量处置审查发现', { exact: true }).click();
      await page.getByLabel('P1 · Fixture regression', { exact: true }).check();
      await page.getByLabel('批量处置', { exact: true }).selectOption('needs_evidence');
      await page.getByRole('button', { name: '应用到 1 项发现', exact: true }).click();
      await page.getByText('已批量保存发现处置', { exact: true }).waitFor();
      assert.equal(store.get('jobs', job.id).findingDecisions.f1, 'needs_evidence');
      await page.getByLabel('当前版本复核', { exact: true }).selectOption('still_present');
      await page.getByLabel('当前版本证据或无法验证的原因', { exact: true }).fill('Fixture regression still fails at head');
      await page.getByRole('button', { name: '保存复核', exact: true }).click();
      await page.getByText('已记录当前版本复核，需重新接受审查', { exact: true }).waitFor();
      assert.equal(store.get('jobs', job.id).findingFollowups[0].status, 'still_present');
      await page.getByText('GitHub 讨论串状态', { exact: true }).click();
      await page.getByRole('button', { name: '同步讨论串', exact: true }).click();
      await page.getByText('Fixture thread', { exact: true }).waitFor(); assert.equal(writes, 0);
      await page.getByRole('button', { name: '预览解决讨论串', exact: true }).click();
      await page.getByLabel('讨论串操作确认', { exact: true }).waitFor(); assert.equal(writes, 0);
      await page.getByRole('button', { name: '确认修改远端讨论串', exact: true }).click();
      await page.getByText(/GitHub 已解决/).waitFor(); assert.equal(writes, 1);
      await page.getByRole('button', { name: '证据', exact: true }).click();
      await page.getByRole('button', { name: '读取保存的原始工具日志', exact: true }).click();
      await page.getByText(/Fixture assertion failed/, { exact: false }).last().waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(dir, `maintenance-${width}.png`), fullPage: true });
      console.log(`Maintenance browser fixture PASS ${width}px; evidence ${dir}`);
    } catch (error) { await page.screenshot({ path: join(dir, `maintenance-failure-${width}.png`), fullPage: true }); console.error(`Browser failure evidence: ${dir}`); throw error; } finally { await page.close(); await new Promise(resolve => server.close(resolve)); await w.close(); }
  }
} finally { await browser.close(); }
