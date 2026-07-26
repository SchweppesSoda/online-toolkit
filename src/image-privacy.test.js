import { describe, expect, it } from "vitest";
import { buildMetadataReport, categorizeMetadataTag, cleanFilename, formatBytes, metadataValue } from "./image-privacy.js";

describe("图片隐私元数据分类", () => {
  it("识别位置、身份、设备、时间和普通技术字段", () => {
    expect(categorizeMetadataTag("GPSLatitude")).toBe("location");
    expect(categorizeMetadataTag("Artist")).toBe("identity");
    expect(categorizeMetadataTag("CameraModelName")).toBe("device");
    expect(categorizeMetadataTag("DateTimeOriginal")).toBe("time");
    expect(categorizeMetadataTag("ImageDescription")).toBe("content");
    expect(categorizeMetadataTag("Image Width")).toBe("technical");
  });

  it("高风险字段优先标记，技术参数不算隐私信息", () => {
    const report = buildMetadataReport({
      GPSLatitude: { description: "31.2304" },
      Model: { description: "Example Phone" },
      "Image Width": { description: "1200px" }
    });
    expect(report.risk).toBe("high");
    expect(report.privacyItems).toHaveLength(2);
    expect(report.items.find((item) => item.name === "Image Width")?.category).toBe("technical");
  });

  it("没有隐私字段时给出安全结果", () => {
    expect(buildMetadataReport({ "File Type": { description: "PNG" } })).toMatchObject({ risk: "safe", privacyItems: [] });
  });
});

describe("图片清理辅助函数", () => {
  it("安全生成下载文件名", () => {
    expect(cleanFilename("旅行:原图.JPG", "image/jpeg")).toBe("旅行-原图-已清理.jpg");
    expect(cleanFilename("clipboard", "image/png")).toBe("clipboard-已清理.png");
  });

  it("避免把大段二进制内容塞进界面", () => {
    expect(metadataValue({ value: new Uint8Array(64) })).toContain("64 字节");
  });

  it("以易读形式显示文件大小", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.00 MB");
  });
});