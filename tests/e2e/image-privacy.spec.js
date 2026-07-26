import { expect, test } from "@playwright/test";
import { deflateSync } from "node:zlib";

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const output = Buffer.alloc(12 + body.length);
  output.writeUInt32BE(body.length, 0);
  name.copy(output, 4);
  body.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, body])), 8 + body.length);
  return output;
}

function privacyPng() {
  const width = 8;
  const height = 8;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      rows[pixel] = 190;
      rows[pixel + 1] = 76 + y * 5;
      rows[pixel + 2] = 60 + x * 6;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from("Author\0Private Person", "latin1")),
    pngChunk("tEXt", Buffer.from("Description\0Office badge photo", "latin1")),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

test.describe("图片隐私清理", () => {
  test("检测隐私元数据、生成副本、复检后下载", async ({ page }) => {
    await page.goto("/image-privacy/");
    await expect(page).toHaveTitle(/图片隐私清理/);
    await page.locator("#imageFile").setInputFiles({
      name: "带隐私信息.png",
      mimeType: "image/png",
      buffer: privacyPng()
    });

    await expect(page.locator("#originalReportTitle")).toContainText("隐私信息");
    await expect(page.locator("#originalMetadata")).toContainText("Author");
    await expect(page.locator("#originalMetadata")).toContainText("Private Person");
    await expect(page.locator("#cleanImage")).toBeEnabled();

    await page.locator("#cleanImage").click();
    await expect(page.locator("#resultTitle")).toHaveText("复检通过");
    await expect(page.locator("#verification strong")).toContainText("已确认");
    await expect(page.locator("#downloadClean")).toBeEnabled();

    const downloadPromise = page.waitForEvent("download");
    await page.locator("#downloadClean").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("带隐私信息-已清理.png");
    const stream = await download.createReadStream();
    let bytes = 0;
    for await (const chunk of stream) bytes += chunk.length;
    expect(bytes).toBeGreaterThan(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
});