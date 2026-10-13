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
import { draftFromJob } from "../src/core/change-plan.ts";
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
    const current = store.get("issues", issue.id);
    const draft = draftFromJob(
      current,
      store.repos()[0],
      store.get("jobs", id),
    );
    store.put("issues", {
      ...current,
      orchestration: {
        draft: {
          ...draft,
          scope: "只修改插件注册路径",
          acceptanceCriteria: ["避免重复注册"],
          missingInfo: [],
        },
      },
    });
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
      await expect(flow.getByRole("combobox", { name: "独立执行节点", exact: true })).toHaveCount(0);
      await expect(flow.getByRole("textbox", { name: "用户补充信息", exact: true })).toHaveCount(0);
      await expect(
        nav.getByRole("button", { name: /^定位与范围/ }),
      ).toBeVisible();
      assert.equal(
        await nav.getByRole("button", { name: /^范围确认/ }).count(),
        0,
      );
      const tabs = panel.getByRole("tablist", { name: "阶段详情" });
      await tabs.getByRole("tab", { name: "处理计划", exact: true }).click();
      await expect(
        panel
          .locator(".mw-workflow-card")
          .getByText("范围：只修改插件注册路径", { exact: true }),
      ).toBeVisible();
      assert.equal(
        await panel
          .locator("summary")
          .filter({ hasText: "处理建议与进度" })
          .count(),
        0,
      );
      assert.equal(
        await panel
          .getByRole("button", { name: "修改建议", exact: true })
          .count(),
        0,
      );
      await panel.locator(".mw-plan-editor > summary").click();
      await expect(
        panel.getByRole("textbox", { name: "维护目标", exact: true }),
      ).toBeVisible();
      // Every disclosure exposes content directly, rather than only a second disclosure.
      assert.equal(
        await panel.locator("details:not([open]) details").count(),
        0,
      );
      await tabs.getByRole("tab", { name: "进度与结果", exact: true }).click();
      await page.screenshot({
        path: join(screenshots, `workflow-result-${width}.png`),
        fullPage: true,
      });
      await tabs.getByRole("tab", { name: "进度与结果", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(
        tabs.getByRole("tab", { name: "手动处理", exact: true }),
      ).toBeFocused();
      await expect(
        tabs.getByRole("tab", { name: "手动处理", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      const input = panel.getByRole("textbox", { name: "你的结果或要求" });
      await expect(input).toBeVisible();
      const manualText =
        "我已人工定位：插件注册被调用两次。只修改注册逻辑，不再复现。";
      await input.fill(manualText);
      await tabs.getByRole("tab", { name: "进度与结果", exact: true }).click();
      await tabs.getByRole("tab", { name: "手动处理", exact: true }).click();
      await expect(input).toHaveValue(manualText);
      assert.equal(store.jobs().length, 1);
      assert.equal(
        store.processing.current(issue.id).manualSteps?.length ?? 0,
        0,
        "navigation must not change workflow state",
      );
      await panel
        .getByRole("button", { name: "停止 Agent，由我处理", exact: true })
        .click();
      await expect(panel).toContainText("等待手动结果");
      await expect(input).toHaveValue(manualText);
      assert.equal(
        store.processing.current(issue.id).manualSteps.at(-1).text,
        "",
        "taking control must not implicitly submit a draft result",
      );
      await panel
        .getByRole("button", { name: "保存补充", exact: true })
        .click();
      await expect(panel.getByRole("status")).toContainText("补充已保存");
      await expect(nav.locator('[aria-current="step"]')).toContainText(
        "定位与范围",
      );
      assert.equal(
        store.processing.current(issue.id).manualSteps.at(-1).mode,
        "supplement",
      );
      await input.fill(manualText);
      await page.screenshot({
        path: join(screenshots, `manual-input-${width}.png`),
        fullPage: true,
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(
        tabs.getByRole("tab", { name: "手动处理", exact: true }),
      ).toHaveCSS("color", "rgb(236, 238, 240)");
      await page.screenshot({
        path: join(screenshots, `manual-input-dark-${width}.png`),
        fullPage: true,
      });
      await page.emulateMedia({ colorScheme: "light" });
      await tabs.getByRole("tab", { name: "执行记录", exact: true }).click();
      await expect(
        panel.getByRole("region", { name: "执行详情", exact: true }),
      ).toBeVisible();
      assert.equal(
        await panel
          .getByRole("button", { name: "保存补充输入", exact: true })
          .count(),
        0,
        "cancelled execution must stay read-only",
      );
      await tabs.getByRole("tab", { name: "手动处理", exact: true }).click();
      await expect(input).toHaveValue(manualText);
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
      await tabs.getByRole("tab", { name: "手动处理", exact: true }).click();
      await expect(
        panel.getByRole("button", { name: "重新打开此步骤" }),
      ).toBeVisible();
      await nav.locator('[aria-current="step"]').click();
      await tabs.getByRole("tab", { name: "手动处理", exact: true }).click();
      await panel
        .getByRole("button", { name: "跳过此步骤", exact: true })
        .click();
      await expect(nav.locator('[aria-current="step"]')).toContainText("验证");
      assert.equal(store.processing.current(issue.id).manualCursor, "validate");
      assert.equal(
        store.processing.current(issue.id).manualSteps.at(-1).text,
        "",
        "skipping must not implicitly submit a draft result",
      );
      await tabs.getByRole("tab", { name: "手动处理", exact: true }).click();
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
