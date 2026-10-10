// Real client/API/persistence with isolated synthetic review evidence. No external writes/model calls.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/store.ts";
import { Workbench, revision } from "../src/core/workbench.ts";
import { GitHub } from "../src/core/github.ts";
import { handler, localRejection } from "../src/server/http.ts";
import { seedFixture, fixtureAnalysis } from "../tests/support/fixtures.ts";

const root = await mkdtemp(join(tmpdir(), "maintainer-timeline-browser-"));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
});
try {
  for (const width of [1440, 390]) {
    const store = new Store(":memory:");
    seedFixture(store);
    const github = new GitHub("", async () => {
      throw Error("Unexpected external request");
    });
    const w = new Workbench(store, root, undefined, github, false);
    const repo = {
      ...store.repos()[0],
      id: "openclaw/openclaw",
      fullName: "openclaw/openclaw",
    };
    store.put("repos", repo);
    const item = {
      ...store.issues()[0],
      id: "openclaw/openclaw#166828",
      repoId: repo.id,
      type: "pr",
      number: 166828,
      title: "test(gateway): backport FRV ordering and lifecycle fixtures",
      body: "演示夹具：回移 Gateway 测试时序修复。保持 Draft，继续核对重复与联动验证证据。",
      author: "RomneyDa",
      labels: ["gateway", "size: S"],
      headSha: "c36a2357628924657576ee061193757a75782e00",
      prBaseSha: repo.headSha,
      draft: true,
      analysis: undefined,
      processing: undefined,
      url: "https://github.com/openclaw/openclaw/pull/166828",
    };
    store.put("issues", item);
    const caseId = store.processing.current(item.id).id;
    const result = (kind) => ({
      ...fixtureAnalysis(item, kind),
      category: "maintenance",
      priority: "P2",
      summary:
        "演示结果：测试夹具同步调整与目标一致，尚未确认补丁引入的阻断问题。源码覆盖和原始分片反证仍需核对，保持 Draft。",
      missingInfo: ["审查取证：目标源码记录被截断，需要重读。"],
      responseDraft: "",
    });
    const run = (id, kind, status, time) => ({
      id,
      caseId,
      repoId: repo.id,
      issueId: item.id,
      issueSnapshot: item,
      kind,
      status,
      revision: revision(item, repo, kind),
      baseSha: item.headSha,
      attempt: 1,
      createdAt: `2026-10-09T00:00:0${time}.000Z`,
      updatedAt: new Date().toISOString(),
      result: result(kind),
      engine: "fixture",
      sessionId: `session-${id}`,
      worktree: `/fixture/worktrees/${id}`,
      prContext: {
        headSha: item.headSha,
        baseSha: repo.headSha,
        headRef: "fixture-backport",
        baseRef: "release",
        headRepo: repo.fullName,
        draft: true,
        merged: false,
        mergeable: true,
        checks: [],
        reviews: [],
        warnings: [],
      },
    });
    const saveRun = (job) => {
      store.put("jobs", { ...job, status: "queued" });
      store.put("jobs", job);
    };
    const preflight = run("timeline-preflight", "preflight", "completed", 1);
    preflight.result.summary =
      "演示预检：两个 Gateway 测试文件，未修改生产代码。Draft，需核对来源落地和资格条件。";
    preflight.artifact = {
      schemaVersion: 1,
      stage: "preflight",
      summary: preflight.result.summary,
      coverage: "演示夹具",
      evidence: [],
      nextSteps: [],
      responseDraft: "",
      intent: "测试夹具时序修复的发布分支回移",
      risks: ["重复验证和原始分片联动证据仍需核对"],
      readiness: "draft",
      blockers: [],
    };
    saveRun(preflight);
    const review = run("timeline-review-1", "review", "awaiting_review", 2);
    review.artifact = {
      schemaVersion: 1,
      stage: "review",
      summary: review.result.summary,
      coverage: "演示证据，仅读取两个测试文件的部分内容",
      evidence: [],
      nextSteps: [],
      responseDraft: "",
      verdict: "incomplete",
      findings: [],
      blockers: ["源码日志截断；原始分片运行存在失败反证，资格验证未完成"],
      inspectedSources: [
        {
          executionId: "fixture-source-1",
          path: "src/gateway/server-plugins.lifecycle.test.ts",
          line: 790,
          quote: "fixture only",
        },
        {
          executionId: "fixture-source-2",
          path: "src/gateway/server.sessions.inbound-worktree-writer.test.ts",
          line: 117,
          quote: "fixture only",
        },
      ],
    };
    saveRun(review);
    let mutations = 0;
    const api = handler(w, localRejection),
      files = {
        "/": ["preview.html", "text/html"],
        "/app.js": ["app.js", "application/javascript"],
        "/app.css": ["app.css", "text/css"],
      };
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith("/maintainer/api")) {
        if (
          req.method === "POST" &&
          /\/(jobs|classify|review|retry|rerun|publish|processing\/resume)(?:\/|$|\?)/.test(
            req.url,
          )
        )
          mutations++;
        return api(req, res);
      }
      const file = files[new URL(req.url, "http://localhost").pathname];
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader("Content-Type", file[1]);
      res.end(await readFile(join(process.cwd(), "dist", file[0])));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    // Check the displayed primary action's request contract without dispatching an executor.
    if (width === 1440) {
      const actionPage = await browser.newPage({
        viewport: { width, height: 1000 },
      });
      let payload;
      await actionPage.route("**/maintainer/api/jobs", async (route) => {
        payload = route.request().postDataJSON();
        await route.fulfill({ json: { created: [], reused: [], errors: [] } });
      });
      await actionPage.goto(`http://127.0.0.1:${server.address().port}`);
      await actionPage
        .getByLabel("选择仓库", { exact: true })
        .selectOption(repo.id);
      await actionPage.getByRole("button", { name: /^Pull Requests/ }).click();
      await actionPage
        .locator('[id="mw-item-openclaw/openclaw#166828"]')
        .click();
      await actionPage
        .getByRole("navigation", { name: "处理阶段" })
        .getByRole("button", { name: /^补充调查/ })
        .click();
      await actionPage
        .getByRole("button", { name: "补足审查证据", exact: true })
        .click();
      await expect.poll(() => payload?.kind).toBe("investigate");
      assert.equal(payload.sourceJobId, review.id);
      assert.equal(
        payload.goal,
        undefined,
        "evidence investigation must not start an implementation chain",
      );
      assert.equal(
        payload.expectedVersion,
        store.processing.current(item.id).version,
      );
      assert.deepEqual(payload.issueIds, [item.id]);
      await actionPage.close();
    }
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.addInitScript(
      ({ issueId, caseId }) =>
        localStorage.setItem(
          `maintainer.stage:${issueId}:${caseId}`,
          JSON.stringify({ view: "overview", detail: "result" }),
        ),
      { issueId: item.id, caseId },
    );
    page.setDefaultTimeout(12000);
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page
        .locator(
          '[aria-label="选择仓库"]:visible, .mw-mobile-repo select:visible',
        )
        .first()
        .selectOption(repo.id);
      await page.getByRole("button", { name: /^Pull Requests/ }).click();
      await page.locator('[id="mw-item-openclaw/openclaw#166828"]').click();
      const flow = page.getByRole("region", {
          name: "事项处理流程",
          exact: true,
        }),
        nav = flow.getByRole("navigation", { name: "处理阶段", exact: true }),
        panel = flow.getByRole("region", { name: "选中阶段", exact: true });
      await nav.getByRole("button", { name: /^测试审查/ }).waitFor();
      assert.equal(
        await flow.getByText("PR · 测试 / 夹具", { exact: true }).count(),
        0,
      );
      assert.equal(
        await flow
          .getByText("依据已读取的源码，范围仍需核对", { exact: true })
          .count(),
        0,
      );
      await expect(panel).toContainText("审查证据不足");
      await expect(page.locator(".mw-reader-state")).toHaveText("草稿");
      assert.equal(
        await flow
          .getByRole("button", { name: "处理概览", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "调查并修复", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await panel
          .getByRole("button", { name: "补足审查证据", exact: true })
          .count(),
        0,
      );
      assert.equal(await panel.locator(".mw-stage-next").count(), 0);
      await flow
        .getByRole("navigation", { name: "处理阶段" })
        .getByRole("button", { name: /^补充调查/ })
        .click();
      assert.ok(
        await panel
          .getByRole("button", { name: "补足审查证据", exact: true })
          .isEnabled(),
      );
      assert.equal(await panel.locator(".mw-stage-history").count(), 0);
      if (width === 1440) {
        const title = await panel.locator("header h3").boundingBox();
        const action = await panel
          .getByRole("button", { name: "补足审查证据", exact: true })
          .boundingBox();
        const box = await panel.boundingBox();
        const center = (r) => r.y + r.height / 2;
        assert.ok(
          Math.abs(center(title) - center(action)) <= 1,
          "title and action must align",
        );
        assert.ok(
          title.y - box.y < 24,
          "stage title must have compact top spacing",
        );
      }
      await page.screenshot({
        path: join(root, `timeline-next-action-${width}.png`),
        fullPage: true,
      });
      await flow
        .getByRole("button", { name: "返回当前阶段", exact: true })
        .click();
      await page.locator(".mw-reader-header").evaluate((el) => {
        for (let p = el; p; p = p.parentElement)
          if (p.scrollTop) p.scrollTop = 0;
      });
      await page.screenshot({
        path: join(root, `timeline-light-${width}.png`),
        fullPage: true,
      });
      const inset = await nav
        .locator('[aria-pressed="true"]')
        .evaluate(
          (el) =>
            el.querySelector(".mw-timeline-dot").getBoundingClientRect().top -
            el.getBoundingClientRect().top,
        );
      assert.ok(
        inset >= 12,
        "selected node needs breathing room above its circle",
      );
      assert.equal(
        await panel
          .getByText(preflight.result.summary, { exact: true })
          .count(),
        0,
      );
      // Future navigation only explains conditions, and never executes a task.
      await nav.getByRole("button", { name: /^补充调查/ }).click();
      await expect(panel).toContainText("此阶段尚未执行");
      assert.equal(mutations, 0);
      await nav.getByRole("button", { name: /^预检/ }).click();
      await expect(panel).toContainText(preflight.result.summary);
      assert.equal(
        await panel.getByText(review.result.summary, { exact: true }).count(),
        0,
      );
      const investigation = run(
        "timeline-investigation",
        "investigate",
        "running",
        3,
      );
      investigation.sourceJobId = review.id;
      investigation.result = undefined;
      saveRun(investigation);
      store.audit(
        "job.progress",
        "演示执行状态：正在核对源码覆盖和原始分片失败反证。",
        investigation.id,
      );
      await expect(
        flow.getByRole("complementary", { name: "当前处理与下一步" }),
      ).toContainText("补充调查 · 执行中");
      await expect(panel).toContainText(preflight.result.summary);
      await expect(panel).toContainText("正在查看历史");
      await page.locator(".mw-reader-header").evaluate((el) => {
        for (let p = el; p; p = p.parentElement)
          if (p.scrollTop) p.scrollTop = 0;
      });
      await page.screenshot({
        path: join(root, `timeline-history-${width}.png`),
        fullPage: true,
      });
      await flow
        .getByRole("button", { name: "返回当前阶段", exact: true })
        .click();
      await expect(panel).toContainText("执行中");
      await expect(
        panel.getByRole("region", { name: "处理进度", exact: true }),
      ).toContainText("正在处理");
      assert.equal(
        await panel
          .locator("header .mw-assistant-more button")
          .filter({ hasText: "停止任务" })
          .count(),
        1,
      );
      assert.equal(
        await panel
          .locator("header .mw-assistant-more button")
          .filter({ hasText: "停止任务" })
          .isVisible(),
        false,
      );
      assert.equal(
        await panel.getByText("结论与证据", { exact: true }).count(),
        0,
      );
      assert.equal(
        await panel.getByText("分析依据 · 0", { exact: true }).count(),
        0,
      );
      await panel
        .getByRole("button", { name: "查看执行详情", exact: true })
        .click();
      await expect(
        panel.getByRole("region", { name: "执行详情", exact: true }),
      ).toContainText("正在核对源码覆盖");
      await page.screenshot({
        path: join(root, `timeline-execution-${width}.png`),
        fullPage: true,
      });
      await panel
        .getByRole("button", { name: "查看阶段结果", exact: true })
        .click();
      await expect(nav.getByRole("button", { name: /^复审/ })).toBeVisible();
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForTimeout(250);
      await page.locator(".mw-reader-header").evaluate((el) => {
        for (let p = el; p; p = p.parentElement)
          if (p.scrollTop) p.scrollTop = 0;
      });
      await page.screenshot({
        path: join(root, `timeline-dark-running-${width}.png`),
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      // Keyboard navigation changes focus, not selection or execution.
      const current = nav.locator('[aria-current="step"]');
      await current.focus();
      await current.press("ArrowRight");
      assert.equal(mutations, 0);
      // Native-like input pause uses the existing durable input service.
      store.put("jobs", { ...investigation, status: "waiting_input" });
      w.processing.requestInput(
        item.id,
        {
          reason: "演示：需要确认调查范围",
          fields: [{ id: "scope", question: "是否将联动验证纳入范围？" }],
        },
        investigation.id,
      );
      await page
        .getByLabel("是否将联动验证纳入范围？", { exact: true })
        .waitFor();
      await expect(
        flow.getByRole("button", { name: "根据补充信息继续", exact: true }),
      ).toHaveCount(0);
      await expect(
        panel.getByRole("button", { name: "保存资料与未解决项", exact: true }),
      ).toBeDisabled();
      await page.evaluate(() => document.activeElement?.blur());
      await expect(
        panel.getByRole("region", { name: "处理进度", exact: true }),
      ).toContainText("需要补充资料");
      await page.screenshot({
        path: join(root, `timeline-input-${width}.png`),
        fullPage: true,
      });
      await page
        .getByLabel("是否将联动验证纳入范围？", { exact: true })
        .fill("先核对证据，不修改生产代码");
      await page
        .getByRole("button", { name: "保存资料与未解决项", exact: true })
        .click();
      await expect(
        flow.getByRole("button", { name: "根据补充信息继续", exact: true }),
      ).toBeEnabled();
      assert.equal(mutations, 0);
      store.put("jobs", {
        ...investigation,
        status: "completed",
        result: result("investigate"),
      });
      const second = run("timeline-review-2", "review", "awaiting_review", 4);
      second.artifact = {
        ...review.artifact,
        summary: "演示复审：已补足源码取证，外部资格条件仍待维护者核对。",
        verdict: "no_findings",
        blockers: [],
      };
      second.result = { ...result("review"), summary: second.artifact.summary };
      second.sourceJobId = investigation.id;
      saveRun(second);
      await expect(nav.locator('[aria-current="step"]')).toContainText(
        "维护者确认",
      );
      await nav.locator('[aria-current="step"]').click();
      await panel.getByText("关联验证与交付证据", { exact: true }).waitFor();
      await expect(
        panel.getByRole("button", { name: "接受此报告", exact: true }),
      ).toBeVisible();
      await nav.getByRole("button", { name: /^测试审查/ }).click();
      assert.equal(
        await panel
          .getByRole("button", { name: "接受此报告", exact: true })
          .count(),
        0,
        "only the current confirmation node can accept this attempt",
      );
      await flow
        .getByLabel("查看阶段尝试", { exact: true })
        .selectOption(review.id);
      await expect(panel).toContainText(review.result.summary);
      await expect(panel).toContainText("正在查看历史");
      assert.equal(
        await panel
          .getByRole("button", { name: "接受此报告", exact: true })
          .count(),
        0,
      );
      await page.locator(".mw-reader-header").evaluate((el) => {
        for (let p = el; p; p = p.parentElement)
          if (p.scrollTop) p.scrollTop = 0;
      });
      await page.screenshot({
        path: join(root, `timeline-attempt-history-${width}.png`),
        fullPage: true,
      });
      const resources = flow.locator('.mw-item-resources');
      await resources.locator(':scope > summary').click();
      assert.ok(await resources.locator('.mw-resource-row').count() >= 3);
      await resources.locator('.mw-stage-resources').first().locator(':scope > summary').click();
      await resources.getByText('隔离工作区路径', {exact:true}).first().click();
      await expect(resources).toContainText('/fixture/worktrees/timeline-preflight');
      await resources.getByRole('button', {name:'查看执行记录',exact:true}).first().click();
      await expect(panel).toContainText('正在查看历史');
      assert.equal(await panel.getByRole('button',{name:'接受此报告',exact:true}).count(),0);
      await page.screenshot({path:join(root,`item-resources-${width}.png`),fullPage:true});
      // New source cycle: archived attempts remain readable, with all write controls hidden.
      store.put("issues", { ...store.get("issues", item.id), state: "closed" });
      store.put("issues", {
        ...store.get("issues", item.id),
        state: "open",
        headSha: "d".repeat(40),
      });
      await flow
        .getByLabel("查看阶段周期", { exact: true })
        .selectOption(caseId);
      await expect(flow).toContainText("历史周期仅供查看");
      assert.equal(
        await flow
          .getByRole("button", { name: "补足审查证据", exact: true })
          .count(),
        0,
      );
      assert.equal(mutations, 0);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      console.log(
        `Timeline browser fixture PASS ${width}px; screenshots ${root}`,
      );
    } finally {
      await page.close();
      await new Promise((resolve) => server.close(resolve));
      await w.close();
    }
  }
} finally {
  await browser.close();
}
