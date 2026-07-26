import { describe, expect, it } from "vitest";
import {
  BodyTooLargeError,
  constantTimeEqual,
  contentDisposition,
  isLegacyRoomId,
  isValidCustomRoomId,
  isValidFileId,
  isValidRoomId,
  normalizeCustomRoomId,
  normalizeRoomId,
  roomObjectName,
  jsonByteLength,
  parseBearerToken,
  parseTtlSeconds,
  randomBase64Url,
  readJsonWithLimit,
  sanitizeFileName,
  sha256Hex,
  utf8ByteLength
} from "./share-utils.js";

describe("share utilities", () => {
  it("measures UTF-8 and JSON payload sizes", () => {
    expect(utf8ByteLength("A中")).toBe(4);
    expect(jsonByteLength({ text: "中" })).toBe(14);
  });

  it("validates room TTLs instead of silently clamping them", () => {
    expect(parseTtlSeconds(undefined, { defaultValue: 60, min: 30, max: 90 })).toBe(60);
    expect(parseTtlSeconds(30, { defaultValue: 60, min: 30, max: 90 })).toBe(30);
    expect(() =>
      parseTtlSeconds(29, { defaultValue: 60, min: 30, max: 90 })
    ).toThrow(RangeError);
    expect(() =>
      parseTtlSeconds(60.5, { defaultValue: 60, min: 30, max: 90 })
    ).toThrow(RangeError);
  });

  it("generates deterministic URL-safe strings with an injected crypto source", () => {
    const cryptoImpl = {
      getRandomValues(bytes) {
        bytes.set([0xff, 0xee, 0xdd, 0xcc]);
        return bytes;
      }
    };
    expect(randomBase64Url(4, cryptoImpl)).toBe("_-7dzA");
    expect(randomBase64Url(18, cryptoImpl)).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it("hashes tokens and compares hashes without early length exits", async () => {
    expect(await sha256Hex("test")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    );
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abc0")).toBe(false);
  });

  it("parses only sufficiently long URL-safe bearer tokens", () => {
    const token = "A".repeat(43);
    expect(parseBearerToken(`Bearer ${token}`)).toBe(token);
    expect(parseBearerToken("Basic abc")).toBeNull();
    expect(parseBearerToken("Bearer short")).toBeNull();
  });

  it("keeps legacy IDs while normalizing memorable custom room names", () => {
    const legacy = "aB_-".repeat(6);
    expect(isLegacyRoomId(legacy)).toBe(true);
    expect(isValidRoomId(legacy)).toBe(true);
    expect(isValidCustomRoomId("Team-Demo")).toBe(true);
    expect(isValidCustomRoomId("临时会议_7")).toBe(true);
    expect(normalizeCustomRoomId(" Ｔeam-Demo ")).toBe("team-demo");
    expect(normalizeRoomId("Team-Demo")).toBe("team-demo");
    expect(roomObjectName("Team-Demo")).toBe("named:team-demo");
    expect(roomObjectName(legacy)).toBe(legacy);
    expect(isValidCustomRoomId("api")).toBe(false);
    expect(isValidCustomRoomId("ab")).toBe(false);
    expect(isValidCustomRoomId("bad/name")).toBe(false);
    expect(isValidFileId("aB_-".repeat(4))).toBe(true);
    expect(isValidFileId("../not-a-file")).toBe(false);
  });

  it("sanitizes download names and produces safe content disposition", () => {
    expect(sanitizeFileName("../bad\r\n:name.png")).toBe("bad_name.png");
    expect(contentDisposition("报告 1.pdf")).toContain("filename*=UTF-8''");
    expect(contentDisposition("evil\"\r\nX-Test: yes")).not.toContain("\r");
  });

  it("reads bounded JSON streams and rejects oversized bodies", async () => {
    const request = new Request("https://example.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" })
    });
    await expect(readJsonWithLimit(request, 64)).resolves.toEqual({ hello: "world" });

    const oversized = new Request("https://example.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(100) })
    });
    await expect(readJsonWithLimit(oversized, 32)).rejects.toBeInstanceOf(
      BodyTooLargeError
    );
  });
});
