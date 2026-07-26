import { expect, test } from "@playwright/test";

test.describe("二维码隐私工具", () => {
  test("默认不启动摄像头，并可生成、下载、重新识别和检查链接", async ({ page }) => {
    await page.goto("/qr/");
    await expect(page).toHaveTitle(/二维码隐私工具/);
    await expect(page.locator("#cameraWrap")).toBeHidden();
    await expect(page.locator("#scanStatus")).toHaveText("等待选择图片或开启摄像头。");
    await expect(page).toHaveURL(/\/qr\/$/);

    await page.getByRole("tab", { name: "生成二维码" }).click();
    await page.locator("#generatorUrl").fill("https://example.com/pay?utm_source=qr&id=7");
    await page.locator("#generateQr").click();
    await expect(page.locator("#generateStatus")).toContainText("本机生成");
    await expect(page.locator("#qrCanvas")).toHaveClass(/ready/);
    await expect(page.locator("#downloadQrPng")).toBeEnabled();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#downloadQrPng").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("二维码.png");
    const qrPath = await download.path();
    expect(qrPath).toBeTruthy();

    await page.getByRole("tab", { name: "识别与检查" }).click();
    await page.locator("#qrFile").setInputFiles(qrPath);
    await expect(page.locator("#scanStatus")).toContainText("识别完成", { timeout: 20_000 });
    await expect(page.locator("#rawResult")).toContainText("https://example.com/pay?utm_source=qr&id=7");
    await expect(page.locator("#qrDetails")).toContainText("example.com");
    await expect(page.locator("#trackingClean")).toBeVisible();
    await expect(page.locator("#cleanUrlPreview")).toHaveText("https://example.com/pay?id=7");
    await expect(page.locator("#openQrLink")).toHaveAttribute("href", "https://example.com/pay?utm_source=qr&id=7");
    await expect(page).toHaveURL(/\/qr\/$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });

  test("危险协议只显示，不提供打开按钮", async ({ page }) => {
    await page.goto("/qr/");
    await page.getByRole("tab", { name: "生成二维码" }).click();
    await page.locator("#generatorType").selectOption("text");
    await page.locator("#generatorText").fill("javascript:alert(document.cookie)");
    await page.locator("#generateQr").click();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#downloadQrPng").click();
    const download = await downloadPromise;
    await page.getByRole("tab", { name: "识别与检查" }).click();
    await page.locator("#qrFile").setInputFiles(await download.path());
    await expect(page.locator("#resultRisk")).toHaveText("高风险", { timeout: 20_000 });
    await expect(page.locator("#rawResult")).toHaveText("javascript:alert(document.cookie)");
    await expect(page.locator("#openQrLink")).toBeHidden();
    await expect(page).toHaveURL(/\/qr\/$/);
  });
});