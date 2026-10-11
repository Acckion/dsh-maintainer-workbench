// Actual client + HTTP + SQLite; no model execution or external writes.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/store.ts";
import { GitHub } from "../src/core/github.ts";
import { Workbench } from "../src/core/workbench.ts";
import { handler, localRejection } from "../src/server/http.ts";
import { seedFixture, fixtureAnalysis } from "../tests/support/fixtures.ts";
const root = await mkdtemp(join(tmpdir(), "maintainer-manual-browser-"));
const screenshots = join(process.cwd(), "artifacts", "manual-steps");
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
});
try {
  for (const width of [1440, 390]) {
    const store = new Store(":memory:");
    seedFixture(store);
    const issue = store.issues()[0];
    store.put("issues", {
      ...issue,
      title: "[Bug] 启动时插件重复加载，导致响应延迟",
      analysis: fixtureAnalysis(issue, "triage"),
    });
    const wb = new Workbench(
      store,
      root,
      undefined,
      new GitHub("", async () => {
        throw new Error("Unexpected external request");
      }),
      false,
    );
    const id = wb.enqueue([issue.id], "investigate").created[0];
    wb.processing.requestInput(
      issue.id,
      {
        reason: "执行环境无法完成复现",
        fields: [{ id: "repro", question: "请提供复现结果" }],
      },
      id,
    );
    store.put("jobs", { ...store.get("jobs", id), status: "waiting_input" });
    const api = handler(wb, localRejection);
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith("/maintainer/api")) return api(req, res);
      const files = {
        "/": ["preview.html", "text/html"],
        "/app.js": ["app.js", "application/javascript"],
        "/app.css": ["app.css", "text/css"],
      };
      const file = files[new URL(req.url, "http://localhost").pathname];
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader("Content-Type", file[1]);
      res.end(await readFile(join(process.cwd(), "dist", file[0])));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const page = await browser.newPage({ viewport: { width, height: 1050 } });
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error(e.stack);
    });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page
        .locator(
          '[aria-label="选择仓库"]:visible, .mw-mobile-repo select:visible',
        )
        .first()
        .selectOption(issue.repoId);
      await page.locator(`[id="mw-item-${issue.id}"]`).click();
      const flow = page.getByRole("region", {
        name: "事项处理流程",
        exact: true,
      });
      const panel = flow.getByRole("region", { name: "选中阶段", exact: true });
      const nav = flow.getByRole("navigation", { name: "处理阶段" });
      await expect(
        nav.getByRole("button", { name: /^定位与范围/ }),
      ).toBeVisible();
      assert.equal(
        await nav.getByRole("button", { name: /^范围确认/ }).count(),
        0,
      );
      await panel
        .getByRole("button", { name: "我来完成", exact: true })
        .click();
      await expect(panel).toContainText("等待手动结果");
      const input = panel.getByRole("textbox", { name: "你的结果或要求" });
      await input.fill(
        "我已人工定位：插件注册被调用两次。只修改注册逻辑，不再复现。",
      );
      await page.screenshot({
        path: join(screenshots, `manual-input-${width}.png`),
        fullPage: true,
      });
      await panel
        .getByRole("button", { name: "提交结果并继续", exact: true })
        .click();
      await expect(nav.locator('[aria-current="step"]')).toContainText("修复");
      assert.equal(store.get("jobs", id).status, "cancelled");
      const state = store.processing.current(issue.id);
      assert.equal(state.manualCursor, "fix");
      assert.match(state.manualSteps.at(-1).text, /不再复现/);
      await nav.getByRole("button", { name: /^定位与范围/ }).click();
      await expect(panel).toContainText("只修改注册逻辑，不再复现。");
      await expect(
        panel.getByRole("button", { name: "重新打开此步骤" }),
      ).toBeVisible();
      await nav.locator('[aria-current="step"]').click();
      await panel
        .getByRole("button", { name: "跳过此步骤", exact: true })
        .click();
      await expect(nav.locator('[aria-current="step"]')).toContainText("验证");
      assert.equal(store.processing.current(issue.id).manualCursor, "validate");
      await panel
        .getByRole("button", { name: "跳过此步骤", exact: true })
        .click();
      await expect(nav.locator('[aria-current="step"]')).toContainText(
        "补丁审查",
      );
      assert.equal(
        store.jobs().length,
        1,
        "manual actions must not create fake execution jobs",
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      assert.equal(overflow, false);
      assert.deepEqual(errors, []);
      console.log(`manual workflow browser passed: ${width}px`);
    } finally {
      await page.close();
      await new Promise((r) => server.close(r));
      await wb.close();
    }
  }
} finally {
  await browser.close();
  await rm(root, { recursive: true, force: true });
}
console.log(`screenshots: ${screenshots}`);
