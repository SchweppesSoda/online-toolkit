import { expect, test } from "@playwright/test";

test.describe("隐印工作流", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/id-photo/");
    await expect(page).toHaveTitle(/隐印/);
  });

  test("默认可跳过裁剪，直接加水印并下载", async ({ page }) => {
    await page.getByRole("button", { name: "使用演示图片" }).click();

    await expect(page.locator("#fileInfo strong")).toContainText("演示证件.png");
    await expect(page.locator("#scanDialog")).not.toHaveAttribute("open", "");
    await expect(page.locator("#exportCurrent")).toBeEnabled();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#exportCurrent").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^演示证件-已加水印\.png$/);
    const stream = await download.createReadStream();
    let byteCount = 0;
    for await (const chunk of stream) byteCount += chunk.length;
    expect(byteCount).toBeGreaterThan(10_000);
  });

  test("可自动找角、手动校准、应用矫正并恢复原图", async ({ page }) => {
    test.setTimeout(90_000);
    await page.getByRole("button", { name: "使用演示图片" }).click();
    await page.locator("#scanCurrent").click();

    await expect(page.locator("#scanDialog")).toBeVisible();
    await expect(page.locator("#scanApply")).toBeEnabled({ timeout: 45_000 });
    await expect(page.locator("#scanStatus")).toContainText("已自动找到四角");
    await expect(page.locator("#scanHost canvas")).toHaveCount(1);
    await expect(page.locator(".scanic-handle")).toHaveCount(4);

    const topLeftHandle = page.locator(".scanic-handle").first();
    const positionBeforeNudge = await topLeftHandle.getAttribute("style");
    await topLeftHandle.press("ArrowRight");
    await expect(topLeftHandle).not.toHaveAttribute("style", positionBeforeNudge);

    await page.locator("#scanApply").click();
    await expect(page.locator("#scanDialog")).not.toBeVisible({ timeout: 45_000 });
    await expect(page.locator("#fileInfo strong")).toContainText("已矫正");
    await expect(page.locator("#restoreOriginal")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#exportCurrent").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^演示证件-已矫正-已加水印\.png$/);

    await page.locator("#restoreOriginal").click();
    await expect(page.locator("#fileInfo strong")).not.toContainText("已矫正");
    await expect(page.locator("#restoreOriginal")).toBeHidden();
  });
});
