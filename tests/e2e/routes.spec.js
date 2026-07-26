import { expect, test } from "@playwright/test";

test.describe("在线工具箱路由", () => {
  test("首页展示四个工具并进入各自独立路径", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/在线工具箱/);
    await expect(page.getByRole("link", { name: /证件图片/ })).toHaveAttribute("href", "/id-photo/");
    await expect(page.getByRole("link", { name: /云剪贴板/ })).toHaveAttribute("href", "/clipboard/");
    await expect(page.getByRole("link", { name: /图片隐私清理/ })).toHaveAttribute("href", "/image-privacy/");
    await expect(page.getByRole("link", { name: /二维码隐私工具/ })).toHaveAttribute("href", "/qr/");

    await page.getByRole("link", { name: /证件图片/ }).click();
    await expect(page).toHaveURL(/\/id-photo\/$/);
    await expect(page).toHaveTitle(/隐印/);
  });

  test("剪贴板入口可独立打开，文字清晰并自动生成可编辑密码", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => { globalThis.__copiedPassword = value; }
        }
      });
    });
    await page.goto("/clipboard/");

    await expect(page).toHaveTitle(/剪贴板/);
    await expect(page.locator('[data-view="entry"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "创建隐私房间" })).toBeVisible();

    const password = page.locator('[data-role="password"]');
    const passwordPattern = /^(?:[A-HJ-NP-Z2-9]{4}-){4}[A-HJ-NP-Z2-9]{4}$/;
    await expect(password).toHaveValue(passwordPattern);
    await expect(password).toHaveAttribute("type", "text");
    const firstPassword = await password.inputValue();

    await page.getByRole("button", { name: "重新生成" }).click();
    await expect(password).toHaveValue(passwordPattern);
    await expect.poll(() => password.inputValue()).not.toBe(firstPassword);
    await page.getByRole("button", { name: "复制密码" }).click();
    await expect.poll(() => page.evaluate(() => globalThis.__copiedPassword))
      .toBe(await password.inputValue());

    await password.fill("我自己输入的长密码-2026");
    await expect(password).toHaveValue("我自己输入的长密码-2026");

    const contentFontSizes = await page.evaluate(() => [
      '[data-role="mode-help"]',
      ".clipboard-mode small",
      ".clipboard-field > small",
      ".clipboard-check small",
      ".clipboard-join-note span",
      ".tool-shell-footer"
    ].map((selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)));
    expect(Math.min(...contentFontSizes)).toBeGreaterThanOrEqual(13);
    expect(await password.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)))
      .toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    )).toBe(true);
  });
});
