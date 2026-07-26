import { describe, expect, it } from "vitest";
import { analyzeQrContent, buildQrPayload, stripTrackingParameters } from "./qr-privacy.js";

describe("二维码内容风险分析", () => {
  it("危险协议不会提供打开地址", () => {
    const result = analyzeQrContent("javascript:alert(1)");
    expect(result.severity).toBe("danger");
    expect(result.openUrl).toBeNull();
    expect(result.summary).toContain("不要执行");
  });

  it("普通 HTTPS 链接只展示、由用户确认后打开", () => {
    const result = analyzeQrContent("https://example.com/path");
    expect(result).toMatchObject({ kind: "网页链接", severity: "safe", openUrl: "https://example.com/path" });
    expect(result.details).toContainEqual(expect.objectContaining({ label: "域名", value: "example.com" }));
  });

  it("识别明文、短网址、IP、账号信息和跟踪参数", () => {
    expect(analyzeQrContent("http://bit.ly/demo").severity).toBe("warning");
    expect(analyzeQrContent("https://127.0.0.1/login").severity).toBe("warning");
    const credential = analyzeQrContent("https://user:pass@example.com/");
    expect(credential.severity).toBe("danger");
    expect(credential.openUrl).toBeNull();
    const tracked = analyzeQrContent("https://example.com/a?utm_source=qr&id=1#x");
    expect(tracked.cleanUrl).toBe("https://example.com/a?id=1#x");
    expect(tracked.removedTracking).toEqual(["utm_source"]);
  });

  it("动态验证码和 Wi-Fi 二维码给出敏感提醒", () => {
    expect(analyzeQrContent("otpauth://totp/Test?secret=ABC").severity).toBe("danger");
    expect(analyzeQrContent("WIFI:T:WPA;S:Home;P:secret;;").severity).toBe("warning");
  });
});

describe("二维码生成内容", () => {
  it("网址缺少协议时使用 HTTPS", () => {
    expect(buildQrPayload("url", { url: "example.com/path" })).toBe("https://example.com/path");
  });

  it("正确转义 Wi-Fi 特殊字符", () => {
    expect(buildQrPayload("wifi", {
      ssid: "Cafe;5G", security: "WPA", password: "a:b;c", hidden: true
    })).toBe("WIFI:T:WPA;S:Cafe\\;5G;P:a\\:b\\;c;H:true;;");
  });

  it("移除常见跟踪参数但保留业务参数", () => {
    expect(stripTrackingParameters("https://example.com/?fbclid=x&order=7&utm_medium=qr")).toEqual({
      url: "https://example.com/?order=7",
      removed: ["fbclid", "utm_medium"]
    });
  });
});